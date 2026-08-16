import {
  decodeWorkRequestId,
  decodeWorkRequestRecordInput,
  type WorkThreadId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderFailure,
} from "@octant/contracts";
import type {
  ProviderConnection,
  ProviderDriver,
  ProviderAcquireInput,
} from "@octant/provider-sdk/driver";
import { Effect, Stream } from "effect";
import type { WorkRequestService, WorkRequestServiceResult } from "./workRequestService";

type RequestConnection = Pick<
  ProviderConnection,
  "events" | "answerApproval" | "answerUserInput" | "interrupt"
>;

export interface WorkRequestRuntimeOptions {
  readonly requests: Pick<WorkRequestService, "record" | "interruptSession">;
  readonly uuid: () => string;
}

export interface WorkRequestSubscriptionInput {
  readonly connection: RequestConnection;
  readonly projectId: ProjectId;
  readonly threadId: WorkThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
}

export type WorkRequestRuntimeContext = Omit<WorkRequestSubscriptionInput, "connection">;

/**
 * Connects a live Work provider session to the durable request service. The
 * provider event stream is the only source that may create a request; answer
 * methods use the same session connection retained for that stream.
 */
export class WorkRequestRuntime {
  readonly #requests: Pick<WorkRequestService, "record" | "interruptSession">;
  readonly #uuid: () => string;
  readonly #connections = new Map<string, RequestConnection>();

  constructor(options: WorkRequestRuntimeOptions) {
    this.#requests = options.requests;
    this.#uuid = options.uuid;
  }

  subscribe(input: WorkRequestSubscriptionInput): Effect.Effect<void, unknown> {
    this.register(input);
    return input.connection.events.pipe(
      Stream.tap((event) => this.observe(input, event)),
      Stream.runDrain,
    );
  }

  observe(
    input: WorkRequestRuntimeContext,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void, ProviderFailure> {
    if (event.sessionId !== input.sessionId) return Effect.void;
    if (isTerminalEvent(event)) {
      return Effect.try({
        try: () => {
          const results = this.#requests.interruptSession(input.sessionId);
          this.#connections.delete(String(input.sessionId));
          const failed = results.find((result) => result.status === "failure");
          if (failed?.status === "failure") throw new Error(failed.failure.message);
        },
        catch: (error) => requestRuntimeFailure(errorMessage(error)),
      });
    }
    if (!isRequestEvent(event)) return Effect.void;

    return Effect.sync(() => this.#record(input, event)).pipe(
      Effect.flatMap((result) => {
        if (result.status === "ok") return Effect.void;
        return this.#interruptProviderWait(input.sessionId).pipe(
          Effect.andThen(
            Effect.fail(
              requestRuntimeFailure(`Work request could not be recorded: ${result.message}`),
            ),
          ),
        );
      }),
    );
  }

  async answerApproval(input: {
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly approved: boolean;
  }): Promise<void> {
    const connection = this.#connection(input.sessionId);
    await this.#run(connection.answerApproval({ ...input }));
  }

  async answerUserInput(input: {
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly answer: string;
  }): Promise<void> {
    const connection = this.#connection(input.sessionId);
    await this.#run(connection.answerUserInput(input));
  }

  async cancel(input: {
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
    readonly kind: "approval" | "user-input";
  }): Promise<void> {
    const connection = this.#connection(input.sessionId);
    if (input.kind === "approval") {
      await this.#run(
        connection.answerApproval({
          sessionId: input.sessionId,
          requestId: input.requestId,
          approved: false,
        }),
      );
      return;
    }
    await this.#run(connection.interrupt(input.sessionId));
  }

  #record(
    input: WorkRequestRuntimeContext,
    event: Extract<
      ProviderRuntimeEvent,
      { readonly kind: "approval-request" | "user-input-request" }
    >,
  ): { readonly status: "ok" } | { readonly status: "failure"; readonly message: string } {
    try {
      const providerCallbackId = normalizedProviderCallbackId(event.requestId);
      if (providerCallbackId === undefined) {
        return { status: "failure", message: "Provider request identity is invalid." };
      }
      const optionValues =
        event.kind === "user-input-request" ? requestOptions(event.options) : undefined;
      const record = decodeWorkRequestRecordInput({
        requestId: decodeWorkRequestId(this.#uuid()),
        projectId: input.projectId,
        threadId: input.threadId,
        providerInstanceId: input.providerInstanceId,
        providerSessionId: event.sessionId,
        providerCallbackId,
        ...(optionValues === undefined ? {} : { providerOptionValues: optionValues.values }),
        detail:
          event.kind === "approval-request"
            ? {
                kind: "approval",
                action: sanitizeRequestText(event.action, "Approval requested"),
                description: sanitizeRequestText(event.description, "Provider approval required"),
              }
            : {
                kind: "user-input",
                prompt: sanitizeRequestText(event.prompt, "Input requested"),
                options: optionValues!.labels,
              },
      });
      const result: WorkRequestServiceResult = this.#requests.record(record);
      return result.status === "ok"
        ? { status: "ok" }
        : { status: "failure", message: result.failure.message };
    } catch {
      return { status: "failure", message: "Provider request is invalid." };
    }
  }

  register(input: WorkRequestSubscriptionInput): () => void {
    this.#connections.set(String(input.sessionId), input.connection);
    return () => {
      if (this.#connections.get(String(input.sessionId)) === input.connection) {
        this.#connections.delete(String(input.sessionId));
      }
    };
  }

  #interruptProviderWait(sessionId: ProviderSessionId): Effect.Effect<void, never> {
    let connection: RequestConnection;
    try {
      connection = this.#connection(sessionId);
    } catch {
      return Effect.void;
    }
    return connection.interrupt(sessionId).pipe(Effect.catchAll(() => Effect.void));
  }

  #connection(sessionId: ProviderSessionId): RequestConnection {
    const connection = this.#connections.get(String(sessionId));
    if (connection === undefined) throw new Error("Work provider session is unavailable.");
    return connection;
  }

  async #run(effect: Effect.Effect<void, unknown>): Promise<void> {
    await Effect.runPromise(effect);
  }
}

/**
 * Adds the request projection tap at the provider acquisition boundary. The
 * returned connection keeps the original event stream intact for the Work
 * turn runtime, avoiding a competing consumer of a single-use provider stream.
 */
export function attachWorkRequestRuntime(
  driver: ProviderDriver,
  runtime: () => WorkRequestRuntime | undefined,
): ProviderDriver {
  return {
    ...driver,
    acquire: (input: ProviderAcquireInput) =>
      Effect.gen(function* () {
        const connection = yield* driver.acquire(input);
        if (input.workRequest === undefined) return connection;
        const active = runtime();
        if (active === undefined) return connection;
        const context = {
          projectId: input.workRequest.projectId,
          threadId: input.workRequest.threadId,
          providerInstanceId: input.instanceId,
          sessionId: input.workRequest.sessionId,
        } satisfies WorkRequestRuntimeContext;
        const detach = active.register({ ...context, connection });
        yield* Effect.addFinalizer(() => Effect.sync(detach));
        return {
          ...connection,
          events: connection.events.pipe(Stream.tap((event) => active.observe(context, event))),
        };
      }),
  };
}

function isRequestEvent(
  event: ProviderRuntimeEvent,
): event is Extract<
  ProviderRuntimeEvent,
  { readonly kind: "approval-request" | "user-input-request" }
> {
  return event.kind === "approval-request" || event.kind === "user-input-request";
}

function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed";
}

function normalizedProviderCallbackId(value: string): string | undefined {
  return value.length > 0 && value.length <= 16_384 ? value : undefined;
}

function sanitizeRequestText(value: string, fallback: string): string {
  const withoutPathOrUrl = value
    .trim()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi, "[redacted reference]")
    .replace(/(?:^|\s|[[({<])file:[^\s]*/gi, " [redacted reference]")
    .replace(/(^|[\s[({<])[^\s]*[\\/][^\s]*/g, "$1[redacted path]")
    .replace(/\s+/g, " ")
    .trim();
  return (withoutPathOrUrl.length === 0 ? fallback : withoutPathOrUrl).slice(0, 2_000).trim();
}

function requestOptions(options: ReadonlyArray<string>): {
  readonly labels: ReadonlyArray<string>;
  readonly values: ReadonlyArray<string>;
} {
  const values = options.slice(0, 8);
  const labels = values.map((option, index) => {
    const label = `Option ${index + 1}: ${sanitizeRequestText(option, "Option unavailable")}`.slice(
      0,
      2_000,
    );
    return label;
  });
  return { labels, values };
}

function requestRuntimeFailure(message: string): ProviderFailure {
  return { category: "provider-failed", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Work request lifecycle update failed.";
}

import {
  decodeWorkRequestId,
  decodeWorkRequestRecordInput,
  type WorkThreadId,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type ProviderFailure,
  type ShieldDecision,
} from "@octant/contracts";
import { shieldCallFromProviderRequest } from "@octant/domain/shield-judge-policy";
import type {
  ProviderConnection,
  ProviderDriver,
  ProviderAcquireInput,
} from "@octant/provider-sdk/driver";
import { Effect, Stream } from "effect";
import type { ShieldReviewPort } from "../shield/octantShield";
import type { WorkRequestService, WorkRequestServiceResult } from "./workRequestService";

type RequestConnection = Pick<
  ProviderConnection,
  "subscribe" | "answerApproval" | "answerUserInput" | "interrupt" | "approvalCall"
>;

export interface WorkRequestRuntimeOptions {
  readonly requests: Pick<WorkRequestService, "record" | "interruptSession">;
  readonly uuid: () => string;
  /**
   * Octant Shield, read when a provider asks for approval: it answers a Work
   * thread's prompts at Auto as it answers a Code thread's, whatever the
   * runtime. Absent, or answering nothing, every prompt goes to the person.
   */
  readonly shield?: () => ShieldReviewPort | undefined;
}

export interface WorkRequestSubscriptionInput {
  readonly connection: RequestConnection;
  readonly projectId: ProjectId;
  readonly threadId: WorkThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
}

export type WorkRequestRuntimeContext = Omit<WorkRequestSubscriptionInput, "connection"> & {
  /** The folder the session runs in, which Shield judges a call against. */
  readonly projectRoot?: string;
  readonly signal?: AbortSignal;
  readonly onApprovalReviewed?: NonNullable<
    NonNullable<ProviderAcquireInput["workRequest"]>["onApprovalReviewed"]
  >;
};

/**
 * Connects a live Work provider session to the durable request service. The
 * provider event stream is the only source that may create a request; answer
 * methods use the same session connection retained for that stream.
 */
export class WorkRequestRuntime {
  readonly #requests: Pick<WorkRequestService, "record" | "interruptSession">;
  readonly #uuid: () => string;
  readonly #shield: (() => ShieldReviewPort | undefined) | undefined;
  readonly #connections = new Map<string, RequestConnection>();

  constructor(options: WorkRequestRuntimeOptions) {
    this.#requests = options.requests;
    this.#uuid = options.uuid;
    this.#shield = options.shield;
  }

  subscribe(input: WorkRequestSubscriptionInput): Effect.Effect<void, unknown> {
    this.register(input);
    return Effect.scoped(
      input.connection.subscribe.pipe(
        Effect.flatMap((events) =>
          events.pipe(
            Stream.tap((event) => this.observe(input, event)),
            Stream.runDrain,
          ),
        ),
      ),
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

  /**
   * An approval prompt, put to Octant Shield when it reviews this thread. An
   * allow or deny goes straight back to the provider for this one call and
   * nobody is asked, so the prompt never becomes a request; it answers true
   * and the caller drops the event. An ask, or a thread Shield does not
   * review, answers false and the prompt is recorded for the person as usual.
   * Shield's decision reaches the turn's transcript either way. The pending
   * call comes from the connection, never from the event, whose text may be
   * redacted.
   */
  screen(
    input: WorkRequestRuntimeContext,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<boolean, never> {
    const shield = this.#shield?.();
    const connection = this.#connections.get(String(input.sessionId));
    if (
      shield === undefined ||
      connection === undefined ||
      input.projectRoot === undefined ||
      event.kind !== "approval-request" ||
      event.sessionId !== input.sessionId
    ) {
      return Effect.succeed(false);
    }
    const projectRoot = input.projectRoot;
    return Effect.promise(async () => {
      let call: ReturnType<NonNullable<RequestConnection["approvalCall"]>>;
      try {
        call = connection.approvalCall?.({
          sessionId: event.sessionId,
          requestId: event.requestId,
        });
      } catch {
        call = undefined;
      }
      let decision: ShieldDecision | undefined;
      try {
        decision = await shield.review({
          threadId: String(input.threadId),
          call: shieldCallFromProviderRequest({
            tool: call?.tool ?? "provider-action",
            input: call?.input,
            workingDirectory: call?.workingDirectory,
            description: event.description,
            boundRoot: projectRoot,
          }),
          boundRoot: projectRoot,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        decision = undefined;
      }
      if (decision === undefined) return false;
      try {
        input.onApprovalReviewed?.({
          requestId: event.requestId,
          toolName: call?.tool ?? event.action,
          summary: sanitizeRequestText(event.description, "Approval requested"),
          decision,
        });
      } catch {
        // A transcript that cannot show the decision does not change it.
      }
      if (decision.verdict === "ask") return false;
      try {
        await Effect.runPromise(
          connection.answerApproval({
            sessionId: event.sessionId,
            requestId: event.requestId,
            approved: decision.verdict === "allow",
            // Shield's answer covers this one call; nothing is remembered.
            scope: "once",
          }),
        );
        return true;
      } catch {
        // A provider that cannot take the answer asks the person instead,
        // which cannot widen what Shield decided.
        return false;
      }
    });
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
        this.#requests.interruptSession(input.sessionId);
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
          projectRoot: input.projectRoot,
          ...(input.workRequest.signal === undefined ? {} : { signal: input.workRequest.signal }),
          ...(input.workRequest.onApprovalReviewed === undefined
            ? {}
            : { onApprovalReviewed: input.workRequest.onApprovalReviewed }),
        } satisfies WorkRequestRuntimeContext;
        const detach = active.register({ ...context, connection });
        yield* Effect.addFinalizer(() => Effect.sync(detach));
        return {
          ...connection,
          subscribe: connection.subscribe.pipe(
            Effect.map((events) =>
              events.pipe(
                Stream.filterEffect((event) =>
                  active
                    .screen(context, event)
                    .pipe(
                      Effect.flatMap((settledByShield) =>
                        settledByShield
                          ? Effect.succeed(false)
                          : active.observe(context, event).pipe(Effect.as(true)),
                      ),
                    ),
                ),
              ),
            ),
          ),
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

export function normalizedProviderCallbackId(value: string): string | undefined {
  return value.length > 0 && value.length <= 16_384 ? value : undefined;
}

/**
 * Work's request text: paths and URLs redacted, whitespace folded, at most
 * 2,000 characters. Every Work-facing request row, a subagent's included, uses
 * this, so none is looser than the Work request contract.
 */
export function sanitizeRequestText(value: string, fallback: string): string {
  const withoutPathOrUrl = value
    .trim()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi, "[redacted reference]")
    .replace(/(?:^|\s|[[({<])file:[^\s]*/gi, " [redacted reference]")
    .replace(/(^|[\s[({<])[^\s]*[\\/][^\s]*/g, "$1[redacted path]")
    .replace(/\s+/g, " ")
    .trim();
  return (withoutPathOrUrl.length === 0 ? fallback : withoutPathOrUrl).slice(0, 2_000).trim();
}

function requestOptions(options: ReadonlyArray<{ readonly label: string }>): {
  readonly labels: ReadonlyArray<string>;
  readonly values: ReadonlyArray<string>;
} {
  const values = options.slice(0, 8).map((option) => option.label);
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

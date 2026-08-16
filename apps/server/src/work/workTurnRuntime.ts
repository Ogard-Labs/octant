import {
  MAX_WORK_TURN_RESPONSE_BYTES,
  type WorkTurnFailure,
  type ProviderFailure,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
  type StartWorkThreadTurnCommand,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Scope, Stream } from "effect";
import {
  countsTowardTurnEventBudget,
  makeIdleTimeout,
  type IdleTimeout,
} from "../providers/turnBudget";

// Discrete events only; streaming deltas are exempt (see turnBudget.ts).
const MAX_EVENTS = 4_096;
// Inactivity window, not total wall time.
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;
const RESPONSE_TRUNCATION_MARKER = "\n[Output truncated by Octant.]";
const textEncoder = new TextEncoder();

export type WorkTurnRuntimeOutcome =
  | { readonly kind: "completed"; readonly response: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "waiting"; readonly failure: WorkTurnFailure }
  | { readonly kind: "failed"; readonly failure: WorkTurnFailure };

export interface WorkTurnRuntimePort {
  run(input: {
    readonly command: StartWorkThreadTurnCommand;
    readonly providerSessionId: ProviderSessionId;
    readonly projectRoot: string;
    readonly driver: ProviderDriver;
    readonly signal: AbortSignal;
    readonly onDelta?: (response: string) => void;
  }): Promise<WorkTurnRuntimeOutcome>;
}

export interface WorkTurnRuntimeOptions {
  readonly timeoutMs?: number;
}

/**
 * Provider-backed Work turn runner. Acquires the driver in Work mode with
 * project-backed workspace and optional request-projection context, then
 * streams text deltas into a bounded durable response. Shell/Git/worktree/PR
 * Code authority is never requested.
 */
export class WorkTurnRuntime implements WorkTurnRuntimePort {
  readonly #timeoutMs: number;

  constructor(options: WorkTurnRuntimeOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async run(input: {
    readonly command: StartWorkThreadTurnCommand;
    readonly providerSessionId: ProviderSessionId;
    readonly projectRoot: string;
    readonly driver: ProviderDriver;
    readonly signal: AbortSignal;
    readonly onDelta?: (response: string) => void;
  }): Promise<WorkTurnRuntimeOutcome> {
    try {
      if (input.signal.aborted) return { kind: "cancelled" };
      const cleanupTimeoutMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
      const idle = await Effect.runPromise(makeIdleTimeout(this.#timeoutMs));
      const execution = Effect.scoped(
        this.#execute(input, idle).pipe(
          Effect.catchAll((error) => Effect.succeed<WorkTurnRuntimeOutcome>(failureOutcome(error))),
        ),
      ).pipe(Effect.map((outcome): LifecycleResult => ({ kind: "outcome", outcome })));
      const boundary = Effect.raceFirst(
        abortEffect(input.signal).pipe(Effect.as<LifecycleResult>({ kind: "cancelled" })),
        idle.expired.pipe(Effect.as<LifecycleResult>({ kind: "timeout" })),
      );
      const result = await Effect.runPromise(Effect.raceFirst(execution, boundary));
      if (result.kind === "cancelled") return { kind: "cancelled" };
      if (result.kind === "timeout") {
        return {
          kind: "waiting",
          failure: {
            category: "interrupted",
            message: "Provider turn timed out with an ambiguous outcome.",
          },
        };
      }
      void cleanupTimeoutMs;
      return result.outcome;
    } catch (error) {
      if (input.signal.aborted) return { kind: "cancelled" };
      return failureOutcome(error);
    }
  }

  #execute(
    input: {
      readonly command: StartWorkThreadTurnCommand;
      readonly providerSessionId: ProviderSessionId;
      readonly projectRoot: string;
      readonly driver: ProviderDriver;
      readonly signal: AbortSignal;
      readonly onDelta?: (response: string) => void;
    },
    idle: IdleTimeout,
  ): Effect.Effect<WorkTurnRuntimeOutcome, ProviderFailure, Scope.Scope> {
    const cleanupTimeoutMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
    return Effect.gen(function* () {
      let reachedTerminalEvent = false;
      const connection = yield* input.driver.acquire({
        instanceId: input.command.authority.providerInstanceId,
        projectRoot: input.projectRoot,
        mode: "work",
        workspace: { kind: "project-backed" },
        workRequest: {
          projectId: input.command.authority.projectId,
          threadId: input.command.threadId,
          sessionId: input.providerSessionId,
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!reachedTerminalEvent) {
            yield* boundedCleanup(connection.interrupt(input.providerSessionId), cleanupTimeoutMs);
          }
          yield* boundedCleanup(connection.stop(input.providerSessionId), cleanupTimeoutMs);
        }),
      );
      yield* connection.start({
        sessionId: input.providerSessionId,
        modelId: input.command.authority.modelId,
        executionPolicy: "approval-gated",
      });

      let handledEvents = 0;
      let response = "";
      let terminal: ProviderRuntimeEvent | undefined;
      const events = yield* Effect.forkScoped(
        connection.events.pipe(
          Stream.filter((event) => event.sessionId === input.providerSessionId),
          Stream.takeUntil((event) => isTerminalEvent(event) || handledEvents > MAX_EVENTS),
          Stream.tap(() => idle.touch),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (countsTowardTurnEventBudget(event)) handledEvents += 1;
              if (handledEvents > MAX_EVENTS) return;
              if (event.kind === "text-delta") {
                response = appendBoundedResponse(response, event.text);
                input.onDelta?.(response);
              }
              if (isTerminalEvent(event)) terminal = event;
            }),
          ),
        ),
      );
      yield* Effect.yieldNow();
      if (input.signal.aborted) {
        yield* connection
          .interrupt(input.providerSessionId)
          .pipe(Effect.catchAll(() => Effect.void));
        return { kind: "cancelled" };
      }
      yield* connection.send({
        sessionId: input.providerSessionId,
        prompt: input.command.prompt,
        context: [],
        attachments: [],
        tools: [],
      });
      yield* Fiber.join(events);

      if (handledEvents > MAX_EVENTS) {
        return {
          kind: "waiting",
          failure: {
            category: "interrupted",
            message: "Provider turn exceeded the bounded event budget.",
          },
        };
      }
      reachedTerminalEvent = terminal !== undefined;
      return outcomeFromEvents(terminal, response);
    });
  }
}

type LifecycleResult =
  | { readonly kind: "outcome"; readonly outcome: WorkTurnRuntimeOutcome }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

function abortEffect(signal: AbortSignal): Effect.Effect<"cancelled"> {
  return Effect.suspend(() => {
    if (signal.aborted) return Effect.succeed("cancelled" as const);
    return Effect.async<"cancelled">((resume) => {
      const onAbort = () => resume(Effect.succeed("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
  });
}

function boundedCleanup<E, R>(
  effect: Effect.Effect<void, E, R>,
  timeoutMs: number,
): Effect.Effect<void, never, R> {
  return Effect.raceFirst(effect.pipe(Effect.catchAll(() => Effect.void)), Effect.sleep(timeoutMs));
}

function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed";
}

function outcomeFromEvents(
  terminal: ProviderRuntimeEvent | undefined,
  response: string,
): WorkTurnRuntimeOutcome {
  if (terminal?.kind === "completed") {
    return { kind: "completed", response };
  }
  if (terminal?.kind === "interrupted") {
    return {
      kind: "waiting",
      failure: {
        category: "interrupted",
        message: "Provider turn was interrupted.",
      },
    };
  }
  if (terminal?.kind === "failed") {
    return {
      kind: "failed",
      failure: {
        category: "failed",
        message: truncateMessage(terminal.failure.message || "Provider turn failed."),
      },
    };
  }
  return {
    kind: "waiting",
    failure: {
      category: "interrupted",
      message: "Provider turn ended without a terminal receipt.",
    },
  };
}

function failureOutcome(error: unknown): WorkTurnRuntimeOutcome {
  if (isProviderFailure(error)) {
    const category =
      error.category === "interrupted"
        ? "interrupted"
        : error.category === "unauthorized" || error.category === "unauthenticated"
          ? "unauthorized"
          : error.category === "unsupported" || error.category === "incompatible"
            ? "unsupported"
            : error.category === "provider-failed"
              ? "failed"
              : "unavailable";
    return {
      kind: category === "interrupted" ? "waiting" : "failed",
      failure: { category, message: truncateMessage(error.message) },
    };
  }
  return {
    kind: "failed",
    failure: {
      category: "unavailable",
      message: truncateMessage(
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Work provider turn is unavailable.",
      ),
    },
  };
}

function isProviderFailure(error: unknown): error is ProviderFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof (error as ProviderFailure).message === "string"
  );
}

function appendBoundedResponse(current: string, delta: string): string {
  const next = current + delta;
  if (textEncoder.encode(next).byteLength <= MAX_WORK_TURN_RESPONSE_BYTES) return next;
  const marker = RESPONSE_TRUNCATION_MARKER;
  const budget = MAX_WORK_TURN_RESPONSE_BYTES - textEncoder.encode(marker).byteLength;
  let truncated = current;
  while (
    textEncoder.encode(truncated + marker).byteLength > MAX_WORK_TURN_RESPONSE_BYTES &&
    truncated.length > 0
  ) {
    truncated = truncated.slice(0, Math.max(0, truncated.length - 16));
  }
  if (textEncoder.encode(truncated).byteLength > budget) {
    truncated = truncated.slice(0, Math.max(0, truncated.length - 32));
  }
  return `${truncated}${marker}`;
}

function truncateMessage(message: string): string {
  const bytes = textEncoder.encode(message);
  if (bytes.byteLength <= 8_192) return message;
  return new TextDecoder().decode(bytes.slice(0, 8_192));
}

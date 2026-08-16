import {
  decodeDiagnosticFailureCode,
  MAX_ROOTLESS_TURN_FAILURE_BYTES as FAILURE_BYTES,
  MAX_ROOTLESS_TURN_RESPONSE_BYTES as RESPONSE_BYTES,
} from "@octant/contracts";
import type {
  ProviderFailure,
  ProviderRuntimeEvent,
  ProviderSessionId,
  RootlessTurnFailure,
  StartRootlessThreadTurnCommand,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Scope, Stream } from "effect";
import {
  countsTowardTurnEventBudget,
  makeIdleTimeout,
  type IdleTimeout,
} from "./providers/turnBudget";
import { RootlessScratchStore } from "./rootlessScratchStore";

// Discrete events only; streaming deltas are exempt (see providers/turnBudget.ts).
const MAX_EVENTS = 4_096;
// Inactivity window, not total wall time.
const IDLE_TIMEOUT_MS = 2 * 60_000;
const RESPONSE_TRUNCATION_MARKER = "\n[Output truncated by Octant.]";
const FAILURE_TRUNCATION_MARKER = " [Message truncated by Octant.]";
const textEncoder = new TextEncoder();

export interface RootlessTurnRuntimeOptions {
  readonly dataDirectory: string;
  readonly timeoutMs?: number;
}

export type RootlessTurnRuntimeOutcome =
  | { readonly kind: "completed"; readonly response: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "waiting"; readonly failure: RootlessTurnFailure }
  | { readonly kind: "failed"; readonly failure: RootlessTurnFailure };

export interface RootlessTurnRuntimePort {
  run(input: {
    readonly command: StartRootlessThreadTurnCommand;
    readonly providerSessionId: ProviderSessionId;
    readonly driver: ProviderDriver;
    readonly signal: AbortSignal;
  }): Promise<RootlessTurnRuntimeOutcome>;
}

export class RootlessTurnRuntime implements RootlessTurnRuntimePort {
  readonly #scratch: RootlessScratchStore;
  readonly #timeoutMs: number;

  constructor(options: RootlessTurnRuntimeOptions) {
    this.#scratch = new RootlessScratchStore(options.dataDirectory);
    this.#timeoutMs = options.timeoutMs ?? IDLE_TIMEOUT_MS;
  }

  async run(input: {
    readonly command: StartRootlessThreadTurnCommand;
    readonly providerSessionId: ProviderSessionId;
    readonly driver: ProviderDriver;
    readonly signal: AbortSignal;
  }): Promise<RootlessTurnRuntimeOutcome> {
    try {
      if (input.signal.aborted) return { kind: "cancelled" };
      const cleanupTimeoutMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
      const idle = await Effect.runPromise(makeIdleTimeout(this.#timeoutMs));
      const execution = Effect.scoped(
        this.#acquireScratch(input.command.turnId, cleanupTimeoutMs).pipe(
          Effect.flatMap((scratchRoot) =>
            this.#execute(input, scratchRoot, idle).pipe(
              Effect.catchAll((error) =>
                Effect.succeed<RootlessTurnRuntimeOutcome>(failureOutcome(error, scratchRoot)),
              ),
            ),
          ),
          Effect.catchAll((error) =>
            Effect.succeed<RootlessTurnRuntimeOutcome>(failureOutcome(error)),
          ),
        ),
      ).pipe(Effect.map((outcome): RootlessLifecycleResult => ({ kind: "outcome", outcome })));
      const boundary = Effect.raceFirst(
        abortEffect(input.signal).pipe(Effect.as<RootlessLifecycleResult>({ kind: "cancelled" })),
        idle.expired.pipe(Effect.as<RootlessLifecycleResult>({ kind: "timeout" })),
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
      return result.outcome;
    } catch (error) {
      if (input.signal.aborted) return { kind: "cancelled" };
      return failureOutcome(error);
    }
  }

  #acquireScratch(
    turnId: StartRootlessThreadTurnCommand["turnId"],
    cleanupTimeoutMs: number,
  ): Effect.Effect<string, unknown, Scope.Scope> {
    const acquire = Effect.async<string, unknown>((resume) => {
      let interrupted = false;
      void this.#scratch.acquire(turnId).then(
        (scratchRoot) => {
          if (interrupted) {
            void this.#scratch.purge(turnId).catch(() => undefined);
            return;
          }
          resume(Effect.succeed(scratchRoot));
        },
        (error) => {
          if (!interrupted) resume(Effect.fail(error));
        },
      );
      return Effect.sync(() => {
        interrupted = true;
      });
    });
    const scratch = this.#scratch;
    return Effect.gen(function* () {
      const scratchRoot = yield* acquire;
      yield* Effect.addFinalizer(() =>
        boundedCleanup(
          Effect.tryPromise({
            try: () => scratch.purge(turnId),
            catch: (error) => error,
          }),
          cleanupTimeoutMs,
        ),
      );
      return scratchRoot;
    });
  }

  #execute(
    input: {
      readonly command: StartRootlessThreadTurnCommand;
      readonly providerSessionId: ProviderSessionId;
      readonly driver: ProviderDriver;
      readonly signal: AbortSignal;
    },
    scratchRoot: string,
    idle: IdleTimeout,
  ): Effect.Effect<RootlessTurnRuntimeOutcome, ProviderFailure, Scope.Scope> {
    const cleanupTimeoutMs = Math.max(1, Math.min(this.#timeoutMs, 1_000));
    return Effect.gen(function* () {
      let reachedTerminalEvent = false;
      const connection = yield* input.driver.acquire({
        instanceId: input.command.context.providerInstanceId,
        projectRoot: scratchRoot,
        mode: input.command.context.mode,
        workspace: { kind: "rootless" },
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
        modelId: input.command.context.modelId,
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
                response = appendBoundedResponse(response, event.text, scratchRoot);
              }
              if (isTerminalEvent(event)) terminal = event;
            }),
          ),
        ),
      );
      yield* Effect.yieldNow();
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
      return outcomeFromEvents(terminal, response, scratchRoot);
    });
  }
}

type RootlessLifecycleResult =
  | { readonly kind: "outcome"; readonly outcome: RootlessTurnRuntimeOutcome }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

function abortEffect(signal: AbortSignal): Effect.Effect<"cancelled"> {
  return Effect.suspend(() => {
    if (signal.aborted) return Effect.succeed("cancelled");
    return Effect.async<"cancelled">((resume) => {
      const abort = () => resume(Effect.succeed("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    });
  });
}

function isTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "waiting" ||
    event.kind === "completed" ||
    event.kind === "interrupted" ||
    event.kind === "failed"
  );
}

function outcomeFromEvents(
  terminal: ProviderRuntimeEvent | undefined,
  response: string,
  scratchRoot: string,
): RootlessTurnRuntimeOutcome {
  if (terminal?.kind === "completed") {
    return response.trim().length > 0
      ? { kind: "completed", response }
      : {
          kind: "failed",
          failure: {
            category: "failed",
            message: "The provider completed without a visible reply.",
          },
        };
  }
  if (terminal?.kind === "failed") {
    const failure = toRootlessFailure(terminal.failure, scratchRoot);
    return shouldRemainAmbiguous(terminal.failure)
      ? { kind: "waiting", failure }
      : { kind: "failed", failure };
  }
  if (terminal?.kind === "waiting") {
    return {
      kind: "waiting",
      failure: { category: "interrupted", message: "Provider is waiting." },
    };
  }
  if (terminal?.kind === "interrupted") {
    return {
      kind: "waiting",
      failure: {
        category: "interrupted",
        message: boundedFailureMessage(terminal.message, scratchRoot),
      },
    };
  }
  return {
    kind: "waiting",
    failure: {
      category: "interrupted",
      message: "Provider turn ended without a terminal outcome.",
    },
  };
}

function failureOutcome(error: unknown, scratchRoot?: string): RootlessTurnRuntimeOutcome {
  const failure = toRootlessFailure(error, scratchRoot);
  return shouldRemainAmbiguous(error) ? { kind: "waiting", failure } : { kind: "failed", failure };
}

function toRootlessFailure(error: unknown, scratchRoot?: string): RootlessTurnFailure {
  if (isProviderFailure(error)) {
    const category: RootlessTurnFailure["category"] =
      error.category === "unsupported" || error.category === "incompatible"
        ? "unsupported"
        : error.category === "unauthorized" || error.category === "unauthenticated"
          ? "unauthorized"
          : error.category === "interrupted" || error.category === "stale-resume"
            ? "interrupted"
            : error.category === "invalid-configuration"
              ? "invalid"
              : error.category === "unavailable" || error.category === "rate-limited"
                ? "unavailable"
                : "failed";
    return {
      category,
      code: decodeDiagnosticFailureCode(error.category),
      message: boundedFailureMessage(error.message, scratchRoot),
    };
  }
  return { category: "unavailable", message: "Rootless provider turn is unavailable." };
}

function appendBoundedResponse(current: string, value: string, scratchRoot: string): string {
  if (current.endsWith(RESPONSE_TRUNCATION_MARKER)) return current;
  const redacted = redactScratchRoot(value, scratchRoot);
  const currentBytes = byteLength(current);
  const redactedBytes = byteLength(redacted);
  if (currentBytes + redactedBytes <= RESPONSE_BYTES) return current + redacted;

  const contentBudget = RESPONSE_BYTES - byteLength(RESPONSE_TRUNCATION_MARKER);
  const base = truncateUtf8(current, contentBudget);
  const remaining = contentBudget - byteLength(base);
  return base + truncateUtf8(redacted, remaining) + RESPONSE_TRUNCATION_MARKER;
}

function boundedFailureMessage(value: string, scratchRoot?: string): string {
  const redacted = redactScratchRoot(value, scratchRoot).replaceAll("\0", "�").trim();
  const safe = redacted.length > 0 ? redacted : "Provider failure details were unavailable.";
  if (byteLength(safe) <= FAILURE_BYTES) return safe;
  const contentBudget = FAILURE_BYTES - byteLength(FAILURE_TRUNCATION_MARKER);
  return truncateUtf8(safe, contentBudget) + FAILURE_TRUNCATION_MARKER;
}

function redactScratchRoot(value: string, scratchRoot?: string): string {
  return scratchRoot === undefined || scratchRoot.length === 0
    ? value
    : value.replaceAll(scratchRoot, "[rootless scratch]");
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const characterBytes =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function boundedCleanup<E, R>(
  effect: Effect.Effect<unknown, E, R>,
  timeoutMs: number,
): Effect.Effect<void, never, R> {
  return Effect.raceFirst(
    effect.pipe(
      Effect.catchAll(() => Effect.void),
      Effect.asVoid,
    ),
    Effect.sleep(timeoutMs),
  ).pipe(Effect.asVoid);
}

function isProviderFailure(error: unknown): error is ProviderFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    "message" in error &&
    typeof (error as { readonly message?: unknown }).message === "string"
  );
}

function shouldRemainAmbiguous(error: unknown): boolean {
  return (
    isProviderFailure(error) &&
    (error.category === "unavailable" ||
      error.category === "interrupted" ||
      error.category === "rate-limited" ||
      error.category === "stale-resume")
  );
}

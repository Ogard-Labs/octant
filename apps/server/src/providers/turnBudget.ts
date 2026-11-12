import type { ProviderRuntimeEvent } from "@octant/contracts";
import { Clock, Effect } from "effect";

/**
 * Streaming deltas and progress ticks are unbounded by nature (one per token
 * or per tool heartbeat) and must not consume a turn's discrete event budget.
 * Only structural events — tool calls, approvals, file changes, terminal
 * events — count. A tool call's content rides beside its start and its
 * result, which already count, so it does not spend the budget twice.
 */
export function countsTowardTurnEventBudget(event: Pick<ProviderRuntimeEvent, "kind">): boolean {
  return (
    event.kind !== "text-delta" &&
    event.kind !== "reasoning-delta" &&
    event.kind !== "tool-progress" &&
    event.kind !== "tool-call-content" &&
    event.kind !== "liveness"
  );
}

/**
 * The most streamed text and reasoning one turn may journal. The deltas are
 * exempt from the event budget above, and Chat and Code journal every one, so
 * without this a provider that never stops streaming grows the journal until
 * the disk fills. 32 MiB is far past any real answer (a 200,000-token context
 * is under 1 MiB of text, and Chat already keeps only the first 256 KiB of a
 * reply for the turn's own record), yet small enough that a runaway turn
 * costs a bounded, recoverable slice of the disk.
 */
export const MAX_TURN_STREAMED_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The words a turn's output ends with when Octant stopped keeping it. */
export const STREAMED_OUTPUT_TRUNCATION_MARKER = "\n\n[Output truncated by Octant.]";

/** The bounded failure code a turn stopped by its streamed-output budget carries. */
export const STREAMED_OUTPUT_BUDGET_CODE = "output-budget-exceeded";

/**
 * Counts a turn's streamed text and reasoning bytes. It answers `exceeded`
 * for the first delta that would carry the turn past `limitBytes`; that delta
 * is not kept, and the runner ends the turn with the truncation marker.
 */
export function makeStreamedOutputBudget(
  limitBytes: number = MAX_TURN_STREAMED_OUTPUT_BYTES,
): (event: ProviderRuntimeEvent) => "within" | "exceeded" {
  let streamedBytes = 0;
  return (event) => {
    if (event.kind !== "text-delta" && event.kind !== "reasoning-delta") return "within";
    streamedBytes += Buffer.byteLength(event.text, "utf8");
    return streamedBytes > limitBytes ? "exceeded" : "within";
  };
}

/**
 * The provider answered the request a harness retry was waiting on: reply
 * text, reasoning, or a tool call. A retried response that only calls a tool
 * streams no text, so a tool event has to end the wait as well, or the retry
 * line would stay up through every tool the turn then runs.
 */
export function endsHarnessRetryWait(event: Pick<ProviderRuntimeEvent, "kind">): boolean {
  return (
    event.kind === "text-delta" ||
    event.kind === "reasoning-delta" ||
    event.kind === "tool-request" ||
    event.kind === "tool-start" ||
    event.kind === "tool-progress" ||
    event.kind === "tool-success" ||
    event.kind === "tool-failure"
  );
}

/**
 * Events that mark a step in the agent's work between two stretches of its
 * answer. Usage, rate limits, citations, and liveness arrive mid-sentence and
 * are not steps. Neither are reasoning and plan updates: a Responses-compatible
 * provider streams reasoning between two deltas of one message ("Hello ",
 * reasoning, "world"), and a break there split the sentence.
 */
function isAnswerStep(event: Pick<ProviderRuntimeEvent, "kind">): boolean {
  return (
    event.kind === "tool-request" ||
    event.kind === "tool-start" ||
    event.kind === "tool-progress" ||
    event.kind === "tool-success" ||
    event.kind === "tool-failure" ||
    event.kind === "file-change" ||
    event.kind === "diff" ||
    event.kind === "approval-request" ||
    event.kind === "user-input-request" ||
    event.kind === "research-started" ||
    event.kind === "research-completed" ||
    event.kind === "context-compacted"
  );
}

/**
 * Providers stream an answer as bare text deltas, and every runner joins a
 * turn's deltas into one message. Text the agent wrote after a tool step then
 * ran straight on from the text before it ("…the repository.Let me
 * understand…", seen on an ACP Code thread in October 2026). A delta that
 * resumes the answer after a step starts a new paragraph. Codex sends its own
 * break between agent messages, and a delta that already starts on a new line
 * is left as it is.
 */
export function makeTurnTextParagraphs(): (event: ProviderRuntimeEvent) => ProviderRuntimeEvent {
  let wroteText = false;
  let stepSinceText = false;
  let endsOnNewLine = false;
  return (event) => {
    if (event.kind !== "text-delta") {
      if (wroteText && isAnswerStep(event)) stepSinceText = true;
      return event;
    }
    const resumes = stepSinceText && !endsOnNewLine && !event.text.startsWith("\n");
    const text = resumes ? `\n\n${event.text}` : event.text;
    wroteText = true;
    stepSinceText = false;
    endsOnNewLine = text.endsWith("\n");
    return resumes ? { ...event, text } : event;
  };
}

/**
 * How long a turn may process provider events before it hands the event loop
 * back. A provider that streams faster than the host journals keeps the
 * event stream non-empty, and each event resumes the turn from a promise, so
 * the work ran as one unbroken chain of microtasks: timers and incoming
 * requests, Stop among them, never ran until the provider paused (a Code
 * turn fed deltas as fast as they could be pulled starved a 50 ms timer for
 * a whole minute).
 */
export const PROVIDER_EVENT_SLICE_MS = 10;

/**
 * An effect a turn runs once per provider event. It is free until the turn
 * has held the event loop for `sliceMs`, then waits one `setImmediate` so
 * timers and pending I/O (a Stop, an approval answer) run before the next
 * event. Wall time, not the Effect clock: a test clock that never advances
 * would otherwise turn it off.
 */
export function makeEventLoopShare(
  sliceMs: number = PROVIDER_EVENT_SLICE_MS,
  now: () => number = () => performance.now(),
): Effect.Effect<void> {
  let sliceStartedAt = now();
  return Effect.suspend(() => {
    if (now() - sliceStartedAt < sliceMs) return Effect.void;
    return Effect.async<void>((resume) => {
      const pending = setImmediate(() => {
        sliceStartedAt = now();
        resume(Effect.void);
      });
      return Effect.sync(() => clearImmediate(pending));
    });
  });
}

export interface IdleTimeout {
  /** Record activity; the idle clock restarts from now. */
  readonly touch: Effect.Effect<void>;
  /** Resolves once no activity has been recorded for the configured window. */
  readonly expired: Effect.Effect<void>;
  /** App-owned work has its own deadline; it is not provider silence. */
  readonly during: <A, E, R>(activity: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * An inactivity timeout: a turn is allowed to run for as long as the provider
 * keeps producing events, and is only cut off after `idleMs` of silence. Uses
 * the Effect clock so tests can drive it deterministically.
 */
export function makeIdleTimeout(idleMs: number): Effect.Effect<IdleTimeout> {
  return Effect.gen(function* () {
    let lastActivity = yield* Clock.currentTimeMillis;
    let activeActions = 0;
    const touch = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        lastActivity = now;
      }),
    );
    const expired = Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const remaining = idleMs - (now - lastActivity);
        if (remaining <= 0 && activeActions === 0) return;
        yield* Effect.sleep(activeActions > 0 ? idleMs : remaining);
      }
    });
    const during = <A, E, R>(activity: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          activeActions += 1;
        }),
        () => activity,
        () =>
          touch.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                activeActions -= 1;
              }),
            ),
          ),
      );
    return { touch, expired, during };
  });
}

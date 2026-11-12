import {
  DEFAULT_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES,
  DEFAULT_STALLED_TURN_LIMIT_MINUTES,
  type ProviderRuntimeEvent,
  type ShellSettings,
} from "@octant/contracts";
import { Clock, Effect } from "effect";

/**
 * Streaming deltas and progress ticks are unbounded by nature (one per token
 * or per tool heartbeat) and must not consume a turn's discrete event budget.
 * Only structural events — tool calls, approvals, file changes, terminal
 * events — count.
 */
export function countsTowardTurnEventBudget(event: Pick<ProviderRuntimeEvent, "kind">): boolean {
  return (
    event.kind !== "text-delta" &&
    event.kind !== "reasoning-delta" &&
    event.kind !== "tool-progress" &&
    event.kind !== "liveness"
  );
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
 * The stalled-turn limit the host setting asks for, in milliseconds; `null`
 * when the setting is Off and no turn is cut off for silence.
 */
export function stalledTurnLimitMs(
  settings: Pick<ShellSettings, "stalledTurnLimitMinutes">,
): number | null {
  return settings.stalledTurnLimitMinutes === null
    ? null
    : settings.stalledTurnLimitMinutes * 60_000;
}

/** The limit a runner uses when nothing tells it the host's setting. */
export const DEFAULT_STALLED_TURN_LIMIT_MS = DEFAULT_STALLED_TURN_LIMIT_MINUTES * 60_000;

/**
 * The longest one provider tool call pauses the stalled-turn clock, in
 * milliseconds; `null` when the setting is Off and a call that never reports
 * a finish pauses the clock for as long as the turn runs.
 */
export function providerToolCallPauseLimitMs(
  settings: Pick<ShellSettings, "providerToolCallPauseLimitMinutes">,
): number | null {
  return settings.providerToolCallPauseLimitMinutes === null
    ? null
    : settings.providerToolCallPauseLimitMinutes * 60_000;
}

/** The pause bound a runner uses when nothing tells it the host's setting. */
export const DEFAULT_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MS =
  DEFAULT_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MINUTES * 60_000;

export interface IdleTimeout {
  /** Record activity; the idle clock restarts from now. */
  readonly touch: Effect.Effect<void>;
  /**
   * Record a provider event as activity. A tool call the runtime reports as
   * started pauses the clock until the runtime reports it finished: a long
   * build or test run inside the provider is work, and the provider says
   * nothing while it lasts. A driver that reports no start gets no pause, and
   * one call pauses the clock for no longer than the pause limit.
   */
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  /** Resolves once no activity has been recorded for the configured window. */
  readonly expired: Effect.Effect<void>;
  /** App-owned work has its own deadline; it is not provider silence. */
  readonly during: <A, E, R>(activity: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * An inactivity timeout: a turn is allowed to run for as long as the provider
 * keeps producing events, and is only cut off after `idleMs` of silence.
 * `null` is the setting turned off: it never expires. Uses the Effect clock so
 * tests can drive it deterministically.
 *
 * `providerToolCallPauseLimitMs` bounds how long one provider tool call pauses
 * the clock, counted from its start. A runtime that reports a start and never
 * the finish would otherwise hold its turn open until the person stops it.
 * Once the bound passes the clock runs again from that moment, so the turn is
 * cut off one full window of silence later, and the call's late finish still
 * counts as activity. `null` is that setting turned off: no bound.
 */
export function makeIdleTimeout(
  idleMs: number | null,
  providerToolCallPauseLimitMs: number | null = DEFAULT_PROVIDER_TOOL_CALL_PAUSE_LIMIT_MS,
): Effect.Effect<IdleTimeout> {
  return Effect.gen(function* () {
    let lastActivity = yield* Clock.currentTimeMillis;
    let activeActions = 0;
    /** Each running provider tool call's start time, by its id. */
    const runningProviderToolCalls = new Map<string, number>();
    const touch = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        lastActivity = now;
      }),
    );
    const observe = (event: ProviderRuntimeEvent) =>
      touch.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // A repeated start keeps the first start time: the bound is on the
            // call, not on how often the runtime announces it.
            if (event.kind === "tool-start") {
              if (!runningProviderToolCalls.has(event.toolCallId))
                runningProviderToolCalls.set(event.toolCallId, lastActivity);
            } else if (event.kind === "tool-success" || event.kind === "tool-failure")
              runningProviderToolCalls.delete(event.toolCallId);
          }),
        ),
      );
    const expired =
      idleMs === null
        ? Effect.never
        : Effect.gen(function* () {
            for (;;) {
              const now = yield* Clock.currentTimeMillis;
              let paused = activeActions > 0;
              let nextCheck = idleMs;
              let quietSince = lastActivity;
              for (const startedAt of runningProviderToolCalls.values()) {
                const pauseEnds =
                  providerToolCallPauseLimitMs === null
                    ? Number.POSITIVE_INFINITY
                    : startedAt + providerToolCallPauseLimitMs;
                if (now < pauseEnds) {
                  paused = true;
                  nextCheck = Math.min(nextCheck, pauseEnds - now);
                } else quietSince = Math.max(quietSince, pauseEnds);
              }
              const remaining = idleMs - (now - quietSince);
              if (remaining <= 0 && !paused) return;
              yield* Effect.sleep(paused ? nextCheck : remaining);
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
    return { touch, observe, expired, during };
  });
}

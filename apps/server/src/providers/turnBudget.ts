import {
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

export interface IdleTimeout {
  /** Record activity; the idle clock restarts from now. */
  readonly touch: Effect.Effect<void>;
  /**
   * Record a provider event as activity. A tool call the runtime reports as
   * started pauses the clock until the runtime reports it finished: a long
   * build or test run inside the provider is work, and the provider says
   * nothing while it lasts. A driver that reports no start gets no pause.
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
 */
export function makeIdleTimeout(idleMs: number | null): Effect.Effect<IdleTimeout> {
  return Effect.gen(function* () {
    let lastActivity = yield* Clock.currentTimeMillis;
    let activeActions = 0;
    const runningProviderToolCalls = new Set<string>();
    const touch = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        lastActivity = now;
      }),
    );
    const observe = (event: ProviderRuntimeEvent) =>
      touch.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (event.kind === "tool-start") runningProviderToolCalls.add(event.toolCallId);
            else if (event.kind === "tool-success" || event.kind === "tool-failure")
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
              const remaining = idleMs - (now - lastActivity);
              const paused = activeActions > 0 || runningProviderToolCalls.size > 0;
              if (remaining <= 0 && !paused) return;
              yield* Effect.sleep(paused ? idleMs : remaining);
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

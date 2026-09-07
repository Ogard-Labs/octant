import type { ProviderRuntimeEvent } from "@octant/contracts";
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
    event.kind !== "tool-progress"
  );
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

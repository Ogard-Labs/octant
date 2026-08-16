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
}

/**
 * An inactivity timeout: a turn is allowed to run for as long as the provider
 * keeps producing events, and is only cut off after `idleMs` of silence. Uses
 * the Effect clock so tests can drive it deterministically.
 */
export function makeIdleTimeout(idleMs: number): Effect.Effect<IdleTimeout> {
  return Effect.gen(function* () {
    let lastActivity = yield* Clock.currentTimeMillis;
    const touch = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        lastActivity = now;
      }),
    );
    const expired = Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const remaining = idleMs - (now - lastActivity);
        if (remaining <= 0) return;
        yield* Effect.sleep(remaining);
      }
    });
    return { touch, expired };
  });
}

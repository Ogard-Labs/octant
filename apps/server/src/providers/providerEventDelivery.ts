import type { ProviderFailure, ProviderRuntimeEvent } from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Scope, Stream } from "effect";

export interface SubscribeThenSendInput<A, E, R, SendError, SendR> {
  readonly connection: Pick<ProviderConnection, "subscribe">;
  /** Builds the turn's consumer over the connection's runtime events. */
  readonly consume: (
    events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
  ) => Effect.Effect<A, E, R>;
  /** The send, plus whatever the caller must check once subscribed. */
  readonly send: Effect.Effect<void, SendError, SendR>;
}

/**
 * Subscribes to a connection's runtime events, sends the turn, and hands the
 * caller the consumer fiber to join, race, or interrupt.
 *
 * A provider that answers immediately publishes from inside `send`, so the
 * subscription has to exist before the send rather than merely be on its way:
 * forking a consumer and yielding lets the forked fiber start but never waits
 * for it to reach the stream, which left the order to the scheduler. Every turn
 * runner and one-shot completion needs this, so it lives here once.
 */
export function subscribeThenSend<A, E, R, SendError, SendR>(
  input: SubscribeThenSendInput<A, E, R, SendError, SendR>,
): Effect.Effect<Fiber.RuntimeFiber<A, E>, SendError, R | SendR | Scope.Scope> {
  return Effect.gen(function* () {
    const events = yield* input.connection.subscribe;
    const consumer = yield* Effect.forkScoped(input.consume(events));
    yield* input.send;
    return consumer;
  });
}

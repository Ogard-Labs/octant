# 0082. Provider events are subscribed before a turn is sent

**Status:** Accepted

## Context

0005 requires a driver to "send input and stream output" but says nothing about
when a caller starts receiving. The contract expressed output as a ready-made
`Stream`, and a `Stream` only subscribes when something first pulls it.

Every turn runner and one-shot completion therefore forked a consumer, called
`Effect.yieldNow()`, and sent — hoping the forked fiber reached the stream
first. It often does not. A consumer forked over a `PubSub`-backed driver was
measured still not subscribed when the send ran, and a provider that answers
inside `send` publishes into a channel nobody is listening to: the turn reads a
truncated response, or waits for a terminal event that already went by.

Nothing on the consumer's side can close that gap. `Stream.toQueue`,
`Stream.toPull`, `Stream.broadcastDynamic`, `Stream.share`, and `Stream.onStart`
were each measured to subscribe lazily or before the source is acquired, and
waiting for the consumer fiber to suspend is wrong for any source that yields
before it subscribes. Subscribing eagerly is something only the connection can
offer, so the seam had to say so.

## Decision

- This refines one rule of 0005 — "send input and stream output" — and replaces
  nothing else in that record.
- A `ProviderConnection` exposes `subscribe`, a scoped effect that establishes a
  subscription and returns the stream reading from it, instead of an `events`
  stream. Subscribing is the effect; reading is what the caller does next.
- Each subscriber gets its own subscription, lasting as long as the scope it was
  taken in. A connection multiplexes sessions, and concurrent consumers of one
  connection each see every event rather than competing for them.
- A driver holds what it publishes for a subscription that exists, whether it is
  being read yet or not. Queue-backed drivers already buffer; `PubSub`-backed
  drivers subscribe when the caller asks rather than when the stream is pulled.
- Callers subscribe before they send. `subscribeThenSend` in
  `apps/server/src/providers/providerEventDelivery.ts` is that order, and the
  turn runners and one-shot completions go through it rather than rebuilding it.

## Consequences

- A provider that answers immediately is read in full, and ordering no longer
  depends on how the scheduler interleaved a fork with a send.
- Third-party drivers implement one more member, and one that is easy to satisfy
  honestly: a queue-backed driver returns its stream, a `PubSub`-backed one
  subscribes. A driver that returns a lazily subscribing stream is still wrong,
  but it is now wrong against a stated rule rather than silently.
- Test fakes state a subscription rather than a stream, which makes the fakes
  that count subscriptions say what they mean.
- The conformance harness subscribes per turn, so a driver that hands every
  consumer one shared subscription fails it.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0006 ACP agent drivers as one generic stack
- 0007 Direct API providers and the native agent harness

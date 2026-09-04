import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { subscribeThenSend } from "./providerEventDelivery";

const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const instanceId = decodeProviderInstanceId("ffffffff-ffff-4fff-8fff-ffffffffffff");
const sessionId = decodeProviderSessionId("11111111-1111-4111-8111-111111111111");

const envelope = (sequence: number) => ({
  instanceId,
  sessionId,
  sequence,
  correlationId: decodeCorrelationId(String(instanceId)),
  occurredAt: decodeTimestamp("2026-09-04T12:00:00.000Z"),
});

describe("provider event delivery", () => {
  it("reads a turn the provider answers while the send is still running", async () => {
    const observed: Array<ProviderRuntimeEvent["kind"]> = [];
    let readingEvents = false;
    let readingWhenSent = false;

    const program = Effect.gen(function* () {
      const published = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const consumer = yield* subscribeThenSend({
        connection: {
          subscribe: Effect.sync(() => {
            readingEvents = true;
            return Stream.fromQueue(published);
          }),
        },
        consume: (events) =>
          events.pipe(
            Stream.takeUntil((event) => event.kind === "completed"),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                observed.push(event.kind);
              }),
            ),
          ),
        // A provider that answers immediately publishes its whole turn from
        // inside send, without ever handing control back to the consumer.
        send: Effect.gen(function* () {
          readingWhenSent = readingEvents;
          yield* Queue.offer(published, { ...envelope(1), kind: "text-delta", text: "answer" });
          yield* Queue.offer(published, { ...envelope(2), kind: "completed" });
        }),
      });
      yield* Fiber.join(consumer);
    }).pipe(Effect.scoped, Effect.timeout(2_000));

    await Effect.runPromise(program);
    expect(readingWhenSent).toBe(true);
    expect(observed).toEqual(["text-delta", "completed"]);
  });
});

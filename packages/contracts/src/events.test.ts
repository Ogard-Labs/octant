import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AppendEventsRequest,
  CommittedAppend,
  EventActor,
  EventEnvelope,
  ProjectionCheckpoint,
  ReplayCursor,
  UtcTimestamp,
} from "./events";

const decodeAppend = Schema.decodeUnknownSync(AppendEventsRequest);
const decodeCommittedAppend = Schema.decodeUnknownSync(CommittedAppend);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeEnvelope = Schema.decodeUnknownSync(EventEnvelope);
const decodeProjectionCheckpoint = Schema.decodeUnknownSync(ProjectionCheckpoint);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);
const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const pendingEvent = {
  eventId: "1c1a16a0-6f54-4a6c-9266-ae5288238e42",
  eventName: "fixture.recorded",
  eventVersion: 1,
  hostId: "local",
  correlationId: "2c2a16a0-6f54-4a6c-9266-ae5288238e42",
  actor: {
    kind: "system",
    actorId: "3c3a16a0-6f54-4a6c-9266-ae5288238e42",
  },
  occurredAt: "2026-07-13T12:00:00.000Z",
  payload: { value: "one" },
} as const;

describe("AppendEventsRequest", () => {
  it("accepts one same-aggregate event batch", () => {
    expect(
      decodeAppend({
        aggregate: {
          aggregateType: "fixture",
          aggregateId: "4c4a16a0-6f54-4a6c-9266-ae5288238e42",
        },
        expectedVersion: 0,
        events: [pendingEvent],
      }).events,
    ).toHaveLength(1);
  });

  it.each([{ expectedVersion: -1 }, { events: [] }, { extra: true }])(
    "rejects invalid requests: %o",
    (change) => {
      expect(() =>
        decodeAppend({
          aggregate: {
            aggregateType: "fixture",
            aggregateId: "4c4a16a0-6f54-4a6c-9266-ae5288238e42",
          },
          expectedVersion: 0,
          events: [pendingEvent],
          ...change,
        }),
      ).toThrow();
    },
  );
});

describe("EventActor", () => {
  const actorId = "3c3a16a0-6f54-4a6c-9266-ae5288238e42";
  const deviceId = "5c5a16a0-6f54-4a6c-9266-ae5288238e42";
  const providerInstanceId = "6c6a16a0-6f54-4a6c-9266-ae5288238e42";
  const threadId = "7c7a16a0-6f54-4a6c-9266-ae5288238e42";

  it("keeps decoding persisted system and local-user actors", () => {
    expect(decodeActor({ kind: "system", actorId })).toEqual({ kind: "system", actorId });
    expect(decodeActor({ kind: "local-user", actorId })).toEqual({ kind: "local-user", actorId });
  });

  it("accepts remote-device actors with device identity", () => {
    expect(decodeActor({ kind: "remote-device", actorId, deviceId })).toEqual({
      kind: "remote-device",
      actorId,
      deviceId,
    });
    expect(() => decodeActor({ kind: "remote-device", actorId })).toThrow();
  });

  it("accepts agent attribution with provider instance and thread identity", () => {
    expect(
      decodeActor({
        kind: "agent",
        actorId,
        providerInstanceId,
        threadId,
      }),
    ).toEqual({
      kind: "agent",
      actorId,
      providerInstanceId,
      threadId,
    });
    expect(() => decodeActor({ kind: "agent", actorId, providerInstanceId })).toThrow();
    expect(() => decodeActor({ kind: "agent", actorId, threadId })).toThrow();
  });

  it("rejects unknown actor kinds and excess fields", () => {
    expect(() => decodeActor({ kind: "local-window", actorId })).toThrow();
    expect(() => decodeActor({ kind: "system", actorId, deviceId })).toThrow();
  });
});

describe("EventEnvelope", () => {
  it("rejects malformed identity, timestamp, and excess fields", () => {
    const valid = {
      ...pendingEvent,
      globalSequence: 1,
      aggregateType: "fixture",
      aggregateId: "4c4a16a0-6f54-4a6c-9266-ae5288238e42",
      aggregateVersion: 1,
    };
    expect(decodeEnvelope(valid)).toMatchObject(valid);
    expect(() => decodeEnvelope({ ...valid, eventId: "not-a-uuid" })).toThrow();
    expect(() => decodeEnvelope({ ...valid, occurredAt: "yesterday" })).toThrow();
    expect(() => decodeEnvelope({ ...valid, secretExtra: true })).toThrow();
  });

  it("round-trips envelopes with remote-device and agent actors", () => {
    const remote = {
      ...pendingEvent,
      actor: {
        kind: "remote-device" as const,
        actorId: "3c3a16a0-6f54-4a6c-9266-ae5288238e42",
        deviceId: "5c5a16a0-6f54-4a6c-9266-ae5288238e42",
      },
      globalSequence: 2,
      aggregateType: "fixture",
      aggregateId: "4c4a16a0-6f54-4a6c-9266-ae5288238e42",
      aggregateVersion: 2,
    };
    const agent = {
      ...pendingEvent,
      eventId: "8c8a16a0-6f54-4a6c-9266-ae5288238e42",
      actor: {
        kind: "agent" as const,
        actorId: "3c3a16a0-6f54-4a6c-9266-ae5288238e42",
        providerInstanceId: "6c6a16a0-6f54-4a6c-9266-ae5288238e42",
        threadId: "7c7a16a0-6f54-4a6c-9266-ae5288238e42",
      },
      globalSequence: 3,
      aggregateType: "fixture",
      aggregateId: "4c4a16a0-6f54-4a6c-9266-ae5288238e42",
      aggregateVersion: 3,
    };
    expect(decodeEnvelope(remote)).toMatchObject(remote);
    expect(decodeEnvelope(agent)).toMatchObject(agent);
  });
});

describe("UtcTimestamp", () => {
  it("accepts only canonical real UTC millisecond timestamps", () => {
    expect(decodeUtcTimestamp("2024-02-29T23:59:59.999Z")).toBe("2024-02-29T23:59:59.999Z");

    for (const invalid of [
      "2025-02-29T12:00:00.000Z",
      "2026-02-30T12:00:00.000Z",
      "2026-13-13T12:00:00.000Z",
      "2026-07-13T24:00:00.000Z",
      "2026-07-13T12:00:00.000+00:00",
      "2026-07-13T12:00:00Z",
      "2026-07-13T12:00:00.000z",
    ]) {
      expect(() => decodeUtcTimestamp(invalid)).toThrow();
    }
  });
});

describe("strict persistence contracts", () => {
  const envelope = {
    ...pendingEvent,
    globalSequence: 1,
    aggregateType: "fixture",
    aggregateId: "4c4a16a0-6f54-4a6c-9266-ae5288238e42",
    aggregateVersion: 1,
  };

  it("rejects excess properties on committed append results", () => {
    expect(() =>
      decodeCommittedAppend({
        events: [envelope],
        firstSequence: 1,
        lastSequence: 1,
        aggregateVersion: 1,
        privateExtra: true,
      }),
    ).toThrow();
  });

  it("rejects excess properties on replay cursors", () => {
    expect(() =>
      decodeReplayCursor({ afterSequence: 0, limit: 100, privateExtra: true }),
    ).toThrow();
  });

  it("rejects excess properties on projection checkpoints", () => {
    expect(() =>
      decodeProjectionCheckpoint({
        projectionName: "aggregate-heads",
        lastSequence: 1,
        updatedAt: pendingEvent.occurredAt,
        privateExtra: true,
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  decodeChatTurnLoopNoticed,
  decodeChatTurnLoopStopped,
  decodeChatTurnStallNoticed,
  decodeCodeOperationEventFrame,
  decodeTurnLoopNotice,
  decodeTurnStallNotice,
  decodeWorkTurnLoopNoticed,
  decodeWorkTurnLoopStopped,
  decodeWorkTurnStallNoticed,
} from "./index";

const occurredAt = "2026-11-19T12:00:00.000Z";
const uuid = "11111111-1111-4111-8111-111111111111";

describe("turn loop and stall notices", () => {
  it("decodes loop and stall notice payloads and refuses invalid counts or extra fields", () => {
    expect(
      decodeTurnLoopNotice({
        kind: "turn-loop-noticed",
        toolName: "octant_read",
        count: 6,
        occurredAt,
      }),
    ).toEqual({
      kind: "turn-loop-noticed",
      toolName: "octant_read",
      count: 6,
      occurredAt,
    });
    expect(
      decodeTurnLoopNotice({
        kind: "turn-loop-stopped",
        toolName: "Read",
        count: 6,
        occurredAt,
      }).kind,
    ).toBe("turn-loop-stopped");
    expect(() =>
      decodeTurnLoopNotice({
        kind: "turn-loop-noticed",
        toolName: "Read",
        count: 1,
        occurredAt,
      }),
    ).toThrow();
    expect(() =>
      decodeTurnLoopNotice({
        kind: "turn-loop-noticed",
        toolName: "Read",
        count: 6,
        occurredAt,
        extra: true,
      }),
    ).toThrow();

    expect(
      decodeTurnStallNotice({
        kind: "turn-stall-noticed",
        idleMs: 1_800_000,
        occurredAt,
      }),
    ).toEqual({
      kind: "turn-stall-noticed",
      idleMs: 1_800_000,
      occurredAt,
    });
    expect(() =>
      decodeTurnStallNotice({
        kind: "turn-stall-noticed",
        idleMs: 0,
        occurredAt,
      }),
    ).toThrow();
  });

  it("decodes Chat, Work, and Code journal events for loop and stall notices", () => {
    expect(
      decodeChatTurnLoopNoticed({
        kind: "turn-loop-noticed",
        threadId: uuid,
        turnId: uuid,
        attemptId: uuid,
        toolName: "octant_search",
        count: 6,
        occurredAt,
      }).toolName,
    ).toBe("octant_search");
    expect(
      decodeChatTurnLoopStopped({
        kind: "turn-loop-stopped",
        threadId: uuid,
        turnId: uuid,
        attemptId: uuid,
        toolName: "octant_search",
        count: 6,
        occurredAt,
      }).kind,
    ).toBe("turn-loop-stopped");
    expect(
      decodeChatTurnStallNoticed({
        kind: "turn-stall-noticed",
        threadId: uuid,
        turnId: uuid,
        attemptId: uuid,
        idleMs: 1_800_000,
        occurredAt,
      }).idleMs,
    ).toBe(1_800_000);

    expect(
      decodeWorkTurnLoopNoticed({
        kind: "turn-loop-noticed",
        requestId: uuid,
        threadId: uuid,
        turnId: uuid,
        toolName: "Read",
        count: 6,
        occurredAt,
      }).count,
    ).toBe(6);
    expect(
      decodeWorkTurnLoopStopped({
        kind: "turn-loop-stopped",
        requestId: uuid,
        threadId: uuid,
        turnId: uuid,
        toolName: "Read",
        count: 6,
        occurredAt,
      }).kind,
    ).toBe("turn-loop-stopped");
    expect(
      decodeWorkTurnStallNoticed({
        kind: "turn-stall-noticed",
        requestId: uuid,
        threadId: uuid,
        turnId: uuid,
        idleMs: 1_800_000,
        occurredAt,
      }).kind,
    ).toBe("turn-stall-noticed");

    for (const event of [
      { kind: "turn-loop-noticed", toolName: "Read", count: 6 },
      { kind: "turn-loop-stopped", toolName: "Read", count: 6 },
      { kind: "turn-stall-noticed", idleMs: 1_800_000 },
    ] as const) {
      expect(
        decodeCodeOperationEventFrame({
          threadId: uuid,
          operationId: uuid,
          cursor: 1,
          occurredAt,
          event,
        }).event.kind,
      ).toBe(event.kind);
    }
  });
});

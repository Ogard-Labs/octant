import {
  decodeContextCompactionId,
  decodeContextCompactionReceipt,
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeWindowId,
  type ContextCompactionRecord,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { IdleCompactions } from "./idleCompaction";
import type { SessionCompactionService } from "./sessionCompaction";

const subject = decodeContextSubjectRef({
  aggregateType: "code-thread",
  aggregateId: "11111111-1111-4111-8111-111111111111",
});
const windowId = decodeWindowId("82000000-0000-4000-8000-000000000001");
const endedAt = "2026-11-07T10:00:00.000Z";
const minutes = (count: number) => Date.parse(endedAt) + count * 60_000;

type Start = Parameters<SessionCompactionService["start"]>;
type Fill = ReturnType<SessionCompactionService["windowFill"]>;

function harness(input: {
  readonly fill?: Fill;
  readonly idleMinutes?: number | null;
  readonly latest?: ContextCompactionRecord;
  readonly refusals?: ReadonlyArray<"turn-running" | "spend-ceiling-reached">;
}) {
  const starts: Array<Start> = [];
  let fills = 0;
  let now = minutes(0);
  const refusals = [...(input.refusals ?? [])];
  const idle = new IdleCompactions({
    compactions: {
      windowFill: () => {
        fills += 1;
        return "fill" in input
          ? input.fill
          : { tokens: 60_000, contextWindow: 200_000, keeper: "runtime" };
      },
      start: (...args: Start) => {
        starts.push(args);
        const reason = refusals.shift();
        return reason === undefined
          ? {
              kind: "compaction-started",
              compactionId: args[0].compactionId,
              executor: {
                kind: "runtime",
                driverKind: "codex",
                providerInstanceId: decodeProviderInstanceId(
                  "81000000-0000-4000-8000-000000000001",
                ),
              },
            }
          : { kind: "compaction-refused", reason };
      },
    },
    latestCompaction: () => input.latest,
    idleMinutes: () => (input.idleMinutes === undefined ? 30 : input.idleMinutes),
    clock: () => now,
  });
  return {
    idle,
    starts,
    fills: () => fills,
    at: (count: number) => {
      now = minutes(count);
    },
  };
}

describe("compacting a thread that has gone quiet", () => {
  it("compacts once a thread is quiet past the set minutes, under its last turn's window", () => {
    const { idle, starts, at } = harness({});
    idle.turnEnded({ subject, endedAt, windowId });
    at(29);
    idle.pass();
    expect(starts).toHaveLength(0);
    at(31);
    idle.pass();
    expect(starts).toHaveLength(1);
    const [command, principal, window, cause] = starts[0] ?? [];
    expect(command?.subject).toEqual(subject);
    expect(principal).toBe("host-policy");
    expect(window).toBe(windowId);
    expect(cause).toEqual({ kind: "idle", idleMinutes: 31, thresholdMinutes: 30 });
    expect(() => decodeContextCompactionId(String(command?.compactionId))).not.toThrow();
  });

  it("runs no second compaction for the same quiet spell", () => {
    const { idle, starts, at } = harness({});
    idle.turnEnded({ subject, endedAt, windowId });
    at(31);
    idle.pass();
    at(41);
    idle.pass();
    expect(starts).toHaveLength(1);
  });

  it("starts the clock again when the thread's next turn ends", () => {
    const { idle, starts, at } = harness({});
    idle.turnEnded({ subject, endedAt, windowId });
    at(20);
    idle.turnEnded({ subject, endedAt: new Date(minutes(20)).toISOString(), windowId });
    at(31);
    idle.pass();
    expect(starts).toHaveLength(0);
    at(51);
    idle.pass();
    expect(starts).toHaveLength(1);
  });

  it("tries again on the next pass while a turn still holds the thread", () => {
    const { idle, starts, at } = harness({ refusals: ["turn-running"] });
    idle.turnEnded({ subject, endedAt, windowId });
    at(31);
    idle.pass();
    at(32);
    idle.pass();
    expect(starts).toHaveLength(2);
    expect(String(starts[0]?.[0].compactionId)).toBe(String(starts[1]?.[0].compactionId));
  });

  it("gives up on a spell any other refusal met, which leaves nothing behind", () => {
    const { idle, starts, at } = harness({ refusals: ["spend-ceiling-reached"] });
    idle.turnEnded({ subject, endedAt, windowId });
    at(31);
    idle.pass();
    at(32);
    idle.pass();
    expect(starts).toHaveLength(1);
  });

  it("leaves a thread compacted since its last turn, or one holding too little", () => {
    const compacted: ContextCompactionRecord = {
      status: "completed",
      receipt: decodeContextCompactionReceipt({
        compactionId: "22222222-2222-4222-8222-222222222223",
        subject,
        executor: {
          kind: "runtime",
          driverKind: "codex",
          providerInstanceId: "81000000-0000-4000-8000-000000000001",
        },
        trigger: "requested",
        tokensBefore: { kind: "known", tokens: 92_000, accuracy: "provider-reported" },
        tokensAfter: { kind: "known", tokens: 18_000, accuracy: "provider-reported" },
        tokensFreed: { kind: "measured", tokens: 74_000, accuracy: "provider-reported" },
        summary: { visibility: "runtime-only" },
        usage: { kind: "unreported" },
        completedAt: "2026-11-07T10:05:00.000Z",
      }),
    };
    const after = harness({ latest: compacted });
    after.idle.turnEnded({ subject, endedAt, windowId });
    after.at(31);
    after.idle.pass();
    const small = harness({ fill: { tokens: 5_000, contextWindow: 200_000, keeper: "runtime" } });
    small.idle.turnEnded({ subject, endedAt, windowId });
    small.at(31);
    small.idle.pass();
    expect(after.starts).toHaveLength(0);
    expect(small.starts).toHaveLength(0);
  });

  it("does nothing while the person has the rule off, nor for those spells once it is on", () => {
    let rule: number | null = null;
    const starts: Array<Start> = [];
    let now = minutes(0);
    const idle = new IdleCompactions({
      compactions: {
        windowFill: () => ({ tokens: 60_000, contextWindow: 200_000, keeper: "runtime" }),
        start: (...args: Start) => {
          starts.push(args);
          return { kind: "compaction-refused", reason: "no-session" };
        },
      },
      latestCompaction: () => undefined,
      idleMinutes: () => rule,
      clock: () => now,
    });
    idle.turnEnded({ subject, endedAt, windowId });
    now = minutes(600);
    idle.pass();
    rule = 30;
    idle.pass();
    expect(starts).toHaveLength(0);
  });

  it("reads nothing and asks no provider in a pass where no thread is due", () => {
    const { idle, starts, fills, at } = harness({});
    for (let index = 0; index < 500; index += 1) {
      idle.turnEnded({
        subject: decodeContextSubjectRef({
          aggregateType: "chat-thread",
          aggregateId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        }),
        endedAt,
      });
    }
    at(10);
    const began = performance.now();
    idle.pass();
    expect(performance.now() - began).toBeLessThan(50);
    expect(fills()).toBe(0);
    expect(starts).toHaveLength(0);
  });
});

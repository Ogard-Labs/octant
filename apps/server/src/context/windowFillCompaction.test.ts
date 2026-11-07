import {
  decodeContextCompactionId,
  decodeContextCompactionReceipt,
  decodeContextSubjectRef,
  decodeProviderInstanceId,
  decodeUtcTimestamp,
  decodeWindowId,
  type ContextCompactionRecord,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { SessionCompactionService } from "./sessionCompaction";
import { WindowFillCompactions, type WindowFillRules } from "./windowFillCompaction";

const subject = decodeContextSubjectRef({
  aggregateType: "code-thread",
  aggregateId: "11111111-1111-4111-8111-111111111111",
});
const windowId = decodeWindowId("82000000-0000-4000-8000-000000000001");

type Start = Parameters<SessionCompactionService["start"]>;
type Fill = ReturnType<SessionCompactionService["windowFill"]>;

function harness(input: {
  readonly fill: Fill;
  readonly rules?: WindowFillRules;
  readonly latest?: ContextCompactionRecord;
  readonly refusals?: ReadonlyArray<"turn-running" | "spend-ceiling-reached">;
}) {
  const starts: Array<Start> = [];
  const refusals = [...(input.refusals ?? [])];
  const pending: Array<() => void> = [];
  const rules = input.rules ?? { octant: 85, runtime: null };
  const compactions = new WindowFillCompactions({
    compactions: {
      windowFill: () => input.fill,
      start: (...args: Start) => {
        starts.push(args);
        const reason = refusals.shift();
        return reason === undefined
          ? {
              kind: "compaction-started",
              compactionId: args[0].compactionId,
              executor: {
                kind: "runtime",
                driverKind: "openai-compatible",
                providerInstanceId: decodeProviderInstanceId(
                  "81000000-0000-4000-8000-000000000001",
                ),
              },
            }
          : { kind: "compaction-refused", reason };
      },
    },
    latestCompaction: () => input.latest,
    rules: () => rules,
    schedule: (run) => {
      pending.push(run);
    },
  });
  const drain = () => {
    while (pending.length > 0) pending.shift()?.();
  };
  return { compactions, starts, drain };
}

describe("compacting a thread when its window fills", () => {
  it("compacts an Octant Harness thread past the share the person set, under the turn's window", () => {
    const { compactions, starts, drain } = harness({
      fill: { tokens: 90_000, contextWindow: 100_000, keeper: "octant" },
    });
    compactions.turnEnded({ subject, turnKey: "2026-11-07T10:00:00.000Z", windowId });
    drain();
    expect(starts).toHaveLength(1);
    const [command, principal, window, cause] = starts[0] ?? [];
    expect(command?.subject).toEqual(subject);
    expect(principal).toBe("host-policy");
    expect(window).toBe(windowId);
    expect(cause).toEqual({ kind: "window-fill", filledPercent: 90, thresholdPercent: 85 });
  });

  it("gives the same turn's end announced twice the same compaction id", () => {
    const { compactions, starts, drain } = harness({
      fill: { tokens: 90_000, contextWindow: 100_000, keeper: "octant" },
    });
    compactions.turnEnded({ subject, turnKey: "turn-a", windowId });
    compactions.turnEnded({ subject, turnKey: "turn-a", windowId });
    compactions.turnEnded({ subject, turnKey: "turn-b", windowId });
    drain();
    const ids = starts.map(([command]) => String(command.compactionId));
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(() => decodeContextCompactionId(ids[0])).not.toThrow();
  });

  it("leaves a runtime's thread to the runtime unless the person set a share for runtimes", () => {
    const fill = { tokens: 90_000, contextWindow: 100_000, keeper: "runtime" } as const;
    const left = harness({ fill });
    left.compactions.turnEnded({ subject, turnKey: "turn", windowId });
    left.drain();
    expect(left.starts).toHaveLength(0);

    const ruled = harness({ fill, rules: { octant: null, runtime: 80 } });
    ruled.compactions.turnEnded({ subject, turnKey: "turn", windowId });
    ruled.drain();
    expect(ruled.starts[0]?.[3]).toEqual({
      kind: "window-fill",
      filledPercent: 90,
      thresholdPercent: 80,
    });
  });

  it("does nothing below the share, or for a thread that has reported nothing", () => {
    const below = harness({ fill: { tokens: 50_000, contextWindow: 100_000, keeper: "octant" } });
    below.compactions.turnEnded({ subject, turnKey: "turn", windowId });
    below.drain();
    const silent = harness({ fill: undefined });
    silent.compactions.turnEnded({ subject, turnKey: "turn", windowId });
    silent.drain();
    expect(below.starts).toHaveLength(0);
    expect(silent.starts).toHaveLength(0);
  });

  it("asks again while the turn that crossed the rule is still letting go of the thread", () => {
    const { compactions, starts, drain } = harness({
      fill: { tokens: 90_000, contextWindow: 100_000, keeper: "octant" },
      refusals: ["turn-running", "turn-running"],
    });
    compactions.turnEnded({ subject, turnKey: "turn", windowId });
    drain();
    expect(starts).toHaveLength(3);
  });

  it("stops after any other refusal, which leaves nothing behind", () => {
    const { compactions, starts, drain } = harness({
      fill: { tokens: 90_000, contextWindow: 100_000, keeper: "octant" },
      refusals: ["spend-ceiling-reached"],
    });
    compactions.turnEnded({ subject, turnKey: "turn", windowId });
    drain();
    expect(starts).toHaveLength(1);
  });

  it("does not retry a failed rule until the window has grown past it", () => {
    const failed: ContextCompactionRecord = {
      status: "failed",
      compactionId: decodeContextCompactionId("22222222-2222-4222-8222-222222222222"),
      executor: {
        kind: "runtime",
        driverKind: "openai-compatible",
        providerInstanceId: decodeProviderInstanceId("81000000-0000-4000-8000-000000000001"),
      },
      cause: { kind: "window-fill", filledPercent: 88, thresholdPercent: 85 },
      reason: "summary-not-smaller",
      sessionMayHaveChanged: false,
      failedAt: decodeUtcTimestamp("2026-11-07T10:00:00.000Z"),
    };
    const same = harness({
      fill: { tokens: 90_000, contextWindow: 100_000, keeper: "octant" },
      latest: failed,
    });
    same.compactions.turnEnded({ subject, turnKey: "turn", windowId });
    same.drain();
    expect(same.starts).toHaveLength(0);
  });

  it("does not compact again after a rule's compaction that freed too little", () => {
    const completed: ContextCompactionRecord = {
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
        cause: { kind: "window-fill", filledPercent: 92, thresholdPercent: 85 },
        tokensBefore: { kind: "known", tokens: 92_000, accuracy: "provider-reported" },
        tokensAfter: { kind: "known", tokens: 88_000, accuracy: "provider-reported" },
        tokensFreed: { kind: "measured", tokens: 4_000, accuracy: "provider-reported" },
        summary: { visibility: "runtime-only" },
        usage: { kind: "unreported" },
        completedAt: "2026-11-07T10:00:00.000Z",
      }),
    };
    const fill = { tokens: 90_000, contextWindow: 100_000, keeper: "runtime" } as const;
    const held = harness({ fill, latest: completed, rules: { octant: null, runtime: 85 } });
    held.compactions.turnEnded({ subject, turnKey: "turn", windowId });
    held.drain();
    expect(held.starts).toHaveLength(0);

    const grown = harness({
      fill: { ...fill, tokens: 94_000 },
      latest: completed,
      rules: { octant: null, runtime: 85 },
    });
    grown.compactions.turnEnded({ subject, turnKey: "turn", windowId });
    grown.drain();
    expect(grown.starts).toHaveLength(1);
  });
});

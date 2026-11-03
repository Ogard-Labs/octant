import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  UtcTimestamp,
  type AutomationFileArrivalTrigger,
  type AutomationFileSourceCheckpoint,
  type AutomationSourceSnapshot,
} from "@octant/contracts";
import {
  automationSourceSnapshotDigest,
  initialAutomationFileCheckpoint,
  reconcileAutomationFileObservation,
} from "./automationFileSourceState";

const at = Schema.decodeUnknownSync(UtcTimestamp)("2026-11-03T00:00:00.000Z");
const digest = "a".repeat(64);
const trigger: AutomationFileArrivalTrigger = {
  kind: "file-arrival",
  directory: "Inbox",
  includeExtensions: [],
  excludeDirectories: [],
  settleSeconds: 2,
  automaticStartLimit: 8,
};
const file = (path: string, value = digest) => ({ path, digest: value, size: 1 });
const baseline: AutomationSourceSnapshot = [file("old.txt")];
function watching(): AutomationFileSourceCheckpoint {
  return {
    ...initialAutomationFileCheckpoint(digest, at),
    phase: "watching",
    baselineReady: true,
    baseline,
    baselineDigest: automationSourceSnapshotDigest(baseline),
  };
}
function observe(
  previous: AutomationFileSourceCheckpoint,
  snapshot: AutomationSourceSnapshot,
  extra: Partial<Parameters<typeof reconcileAutomationFileObservation>[0]> = {},
) {
  return reconcileAutomationFileObservation({
    previous,
    snapshot,
    trigger,
    observedAt: at,
    settled: true,
    activity: "quiet",
    coverageGap: false,
    missedRunPolicy: "skip",
    ...extra,
  });
}
function saved(decision: ReturnType<typeof observe>): AutomationFileSourceCheckpoint {
  if (decision.kind === "unchanged") throw new Error("Expected a persisted decision");
  return decision.kind === "claim" ? decision.receipt.checkpoint : decision.checkpoint;
}

describe("durable file source decisions", () => {
  it("baselines pre-existing input without an automatic start", () => {
    const decision = observe(initialAutomationFileCheckpoint(digest, at), baseline);
    expect(decision.kind).toBe("checkpoint");
    expect(saved(decision)).toMatchObject({
      baselineReady: true,
      observationRevision: 2,
      automaticStarts: 0,
      phase: "watching",
      baseline,
    });
  });
  it("requires a complete settled observation before creating an occurrence", () => {
    expect(observe(watching(), [...baseline, file("new.txt")], { settled: false })).toEqual({
      kind: "unchanged",
    });
    const decision = observe(watching(), [...baseline, file("new.txt")]);
    expect(decision.kind === "claim" && decision.receipt.files).toEqual(["new.txt"]);
    expect(saved(decision).automaticStarts).toBe(1);
    expect(saved(decision).observationRevision).toBe(2);
    expect(observe(saved(decision), [...baseline, file("new.txt")])).toEqual({ kind: "unchanged" });
  });
  it("does not run removals or content that returned to the baseline", () => {
    expect(observe(watching(), baseline)).toEqual({ kind: "unchanged" });
    const removed = observe(watching(), []);
    expect(removed.kind).toBe("checkpoint");
    expect(saved(removed).automaticStarts).toBe(0);
  });
  it("holds busy input durably even if content reverts before quiescence", () => {
    const busy = saved(
      observe(watching(), [file("old.txt", "b".repeat(64))], { activity: "busy", settled: false }),
    );
    expect(busy).toMatchObject({ busyChangeObserved: true, baseline });
    const reverted = saved(observe(busy, baseline));
    expect(reverted).toMatchObject({
      phase: "held",
      busyChangeObserved: true,
      held: { files: [], snapshot: baseline },
    });
    expect(observe(reverted, baseline)).toEqual({ kind: "unchanged" });
  });
  it("keeps the busy window through the first settled scan after first-turn completion", () => {
    const previous = { ...watching(), activityWindow: ["11111111-1111-4111-8111-111111111111"] };
    expect(saved(observe(previous, [...baseline, file("late-output.txt")]))).toMatchObject({
      phase: "held",
      reason: "input-changed-while-running",
    });
    const quiet = saved(observe(previous, baseline));
    expect(quiet.activityWindow).toEqual([]);
    expect(observe(quiet, [...baseline, file("arrival.txt")]).kind).toBe("claim");
  });
  it("unknown activity cannot establish quiescence or dispatch", () => {
    const unknown = saved(
      observe(watching(), [...baseline, file("arrival.txt")], { activity: "unknown" }),
    );
    expect(unknown).toMatchObject({
      phase: "needs-rearm",
      reason: "activity-unknown",
      automaticStarts: 0,
    });
    expect(saved(observe(unknown, [...baseline, file("arrival.txt")]))).toMatchObject({
      phase: "held",
      automaticStarts: 0,
    });
  });
  it.each(["skip", "run-once"] as const)(
    "offline %s describes one net-final-state observation",
    (policy) => {
      const decision = observe(watching(), [file("surviving.txt")], {
        coverageGap: true,
        missedRunPolicy: policy,
      });
      expect(decision.kind).toBe(policy === "skip" ? "checkpoint" : "claim");
      expect(saved(decision).coverageGap).toBe(true);
      expect(saved(decision).automaticStarts).toBe(policy === "skip" ? 0 : 1);
    },
  );
  it("persists the finite per-arm limit through quiet/restart and never resets it", () => {
    const previous = { ...watching(), automaticStarts: 7 };
    const eighth = observe(previous, [...baseline, file("eighth.txt")]);
    expect(eighth.kind).toBe("claim");
    const persisted = JSON.parse(JSON.stringify(saved(eighth)));
    expect(persisted).toMatchObject({
      automaticStarts: 8,
      phase: "needs-rearm",
      reason: "automatic-start-limit",
      armGeneration: 1,
    });
    expect(observe(persisted, persisted.baseline)).toEqual({ kind: "unchanged" });
    const ninth = observe(persisted, [...persisted.baseline, file("ninth.txt")]);
    expect(ninth.kind).toBe("checkpoint");
    expect(saved(ninth)).toMatchObject({
      automaticStarts: 8,
      phase: "held",
      reason: "automatic-start-limit",
      held: { files: ["ninth.txt"] },
    });
  });
  it("never adopts a changed source or definition from a later observation", () => {
    for (const reason of ["source-changed", "authority-changed", "definition-changed"] as const)
      expect(observe({ ...watching(), phase: "needs-rearm", reason }, [file("new.txt")])).toEqual({
        kind: "unchanged",
      });
  });
});

import {
  decodeCodeProjectPullRequestSwitchTarget,
  decodeCodeThreadId,
  type CodeProjectPullRequestAutoFixFailure,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  applyPullRequestSwitchEvent,
  decidePullRequestAutoFix,
  emptyPullRequestSwitchFold,
  type PullRequestSwitchEvent,
  type PullRequestSwitchFold,
} from "./codePullRequestSwitchPolicy";

const target = decodeCodeProjectPullRequestSwitchTarget({
  projectId: "00000000-0000-4000-8000-000000000001",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 7,
});
const threadId = decodeCodeThreadId("00000000-0000-4000-8000-0000000000aa");
const lint: CodeProjectPullRequestAutoFixFailure = { kind: "check", key: "lint" };
const review: CodeProjectPullRequestAutoFixFailure = { kind: "review-thread", key: "RT_1" };

function replay(events: ReadonlyArray<PullRequestSwitchEvent>): PullRequestSwitchFold {
  return events.reduce(applyPullRequestSwitchEvent, emptyPullRequestSwitchFold(target));
}

const enabled: PullRequestSwitchEvent = {
  kind: "auto-fix",
  occurredAt: "2026-10-31T10:00:00.000Z",
  record: { target, threadId, change: { kind: "enabled" } },
};

function woke(
  headSha: string,
  failures: ReadonlyArray<CodeProjectPullRequestAutoFixFailure>,
  attempt: number,
  result: "started" | "refused" = "started",
): PullRequestSwitchEvent {
  return {
    kind: "auto-fix",
    occurredAt: "2026-10-31T10:05:00.000Z",
    record: { target, threadId, change: { kind: "woke", headSha, failures, attempt, result } },
  };
}

const quiet = { turnActive: false, personTyping: false };

describe("pull-request Auto-fix policy", () => {
  it("wakes the thread for a new failure as its first attempt", () => {
    const decision = decidePullRequestAutoFix({
      fold: replay([enabled]).autoFix,
      observation: { state: "open", headSha: "a1", failures: [lint] },
      ...quiet,
    });
    expect(decision).toEqual({ kind: "wake", attempt: 1, failures: [lint] });
  });

  it("does not wake twice for the same failures on the same head", () => {
    const decision = decidePullRequestAutoFix({
      fold: replay([enabled, woke("a1", [lint], 1)]).autoFix,
      observation: { state: "open", headSha: "a1", failures: [lint] },
      ...quiet,
    });
    expect(decision).toEqual({ kind: "idle" });
  });

  it("stops after three started attempts on one failure instead of trying a fourth", () => {
    const fold = replay([
      enabled,
      woke("a1", [lint], 1),
      woke("a2", [lint], 2),
      woke("a3", [lint], 3),
    ]).autoFix;
    expect(
      decidePullRequestAutoFix({
        fold,
        observation: { state: "open", headSha: "a4", failures: [lint] },
        ...quiet,
      }),
    ).toEqual({ kind: "stop", reason: "attempt-limit" });
  });

  it("counts attempts per distinct failure, so a new failure starts its own count", () => {
    const fold = replay([enabled, woke("a1", [lint], 1), woke("a2", [lint], 2)]).autoFix;
    expect(
      decidePullRequestAutoFix({
        fold,
        observation: { state: "open", headSha: "a3", failures: [review] },
        ...quiet,
      }),
    ).toEqual({ kind: "wake", attempt: 1, failures: [review] });
  });

  it("does not spend an attempt on a wake that was refused", () => {
    const fold = replay([enabled, woke("a1", [lint], 1, "refused")]).autoFix;
    expect(
      decidePullRequestAutoFix({
        fold,
        observation: { state: "open", headSha: "a2", failures: [lint] },
        ...quiet,
      }),
    ).toEqual({ kind: "wake", attempt: 1, failures: [lint] });
  });

  it("holds the wake while a turn runs or the person is typing", () => {
    const fold = replay([enabled]).autoFix;
    const observation = { state: "open" as const, headSha: "a1", failures: [lint] };
    expect(
      decidePullRequestAutoFix({ fold, observation, turnActive: true, personTyping: false }),
    ).toEqual({ kind: "paused", reason: "turn-active" });
    expect(
      decidePullRequestAutoFix({ fold, observation, turnActive: false, personTyping: true }),
    ).toEqual({ kind: "paused", reason: "person-typing" });
  });

  it("stops when the pull request is merged or closed", () => {
    const fold = replay([enabled]).autoFix;
    expect(
      decidePullRequestAutoFix({
        fold,
        observation: { state: "merged", headSha: "a1", failures: [lint] },
        ...quiet,
      }),
    ).toEqual({ kind: "stop", reason: "merged" });
    expect(
      decidePullRequestAutoFix({
        fold,
        observation: { state: "closed", headSha: "a1", failures: [] },
        ...quiet,
      }),
    ).toEqual({ kind: "stop", reason: "closed" });
  });

  it("does nothing while the switch is off or after it stopped", () => {
    const stopped = replay([
      enabled,
      {
        kind: "auto-fix",
        occurredAt: "2026-10-31T11:00:00.000Z",
        record: { target, threadId, change: { kind: "stopped", reason: "attempt-limit" } },
      },
    ]).autoFix;
    expect(stopped.status).toBe("stopped");
    expect(
      decidePullRequestAutoFix({
        fold: stopped,
        observation: { state: "open", headSha: "a9", failures: [review] },
        ...quiet,
      }),
    ).toEqual({ kind: "idle" });
  });

  it("gives a fresh attempt budget when the person turns Auto-fix on again", () => {
    const fold = replay([
      enabled,
      woke("a1", [lint], 1),
      woke("a2", [lint], 2),
      woke("a3", [lint], 3),
      enabled,
    ]).autoFix;
    expect(
      decidePullRequestAutoFix({
        fold,
        observation: { state: "open", headSha: "a4", failures: [lint] },
        ...quiet,
      }),
    ).toEqual({ kind: "wake", attempt: 1, failures: [lint] });
  });
});

describe("pull-request Merge when ready replay", () => {
  it("rebuilds on, merged, and turned off by the forge from journaled changes", () => {
    const on = replay([
      {
        kind: "merge-when-ready",
        occurredAt: "2026-10-31T10:00:00.000Z",
        record: { target, change: { kind: "enabled", method: "squash", headSha: "a1" } },
      },
    ]);
    expect(on.mergeWhenReady).toEqual({
      status: "on",
      method: "squash",
      headSha: "a1",
      enabledAt: "2026-10-31T10:00:00.000Z",
    });
    const forge = applyPullRequestSwitchEvent(on, {
      kind: "merge-when-ready",
      occurredAt: "2026-10-31T10:30:00.000Z",
      record: { target, change: { kind: "turned-off-by-forge" } },
    });
    expect(forge.mergeWhenReady.status).toBe("turned-off-by-forge");
  });
});

import {
  decodeCodeProjectPullRequestSwitchTarget,
  decodeCodeThreadId,
  type CodeProjectPullRequestAutoFixFailure,
  type CodeProjectPullRequestWatchSignal,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  applyPullRequestSwitchEvent,
  decidePullRequestAutoFix,
  decidePullRequestWatch,
  emptyPullRequestSwitchFold,
  pullRequestWatchBaseline,
  pullRequestWatchExpired,
  type PullRequestSwitchEvent,
  type PullRequestSwitchFold,
  type PullRequestWatchObservation,
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
  result: "started" | "refused" | "unmarked" = "started",
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

  it("tries again on the same head when the previous wake never started a turn", () => {
    for (const result of ["refused", "unmarked"] as const) {
      const fold = replay([enabled, woke("a1", [lint], 1, result)]).autoFix;
      expect(
        decidePullRequestAutoFix({
          fold,
          observation: { state: "open", headSha: "a1", failures: [lint] },
          ...quiet,
        }),
      ).toEqual({ kind: "wake", attempt: 1, failures: [lint] });
    }
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

describe("pull-request watch policy", () => {
  const enabledAt = "2026-11-01T10:00:00.000Z";
  const now = "2026-11-01T12:00:00.000Z";

  function watchEnabled(
    baseline: ReadonlyArray<CodeProjectPullRequestWatchSignal> = [],
  ): PullRequestSwitchEvent {
    return {
      kind: "watch",
      occurredAt: enabledAt,
      record: { target, threadId, change: { kind: "enabled", baseline } },
    };
  }

  function watchWoke(
    headSha: string,
    signals: ReadonlyArray<CodeProjectPullRequestWatchSignal>,
    wake: number,
    result: "started" | "refused" | "unmarked" = "started",
  ): PullRequestSwitchEvent {
    return {
      kind: "watch",
      occurredAt: "2026-11-01T11:00:00.000Z",
      record: { target, threadId, change: { kind: "woke", headSha, signals, wake, result } },
    };
  }

  function observation(
    overrides: Partial<PullRequestWatchObservation> = {},
  ): PullRequestWatchObservation {
    return {
      state: "open",
      headSha: "a1",
      checks: "pending",
      conflicting: false,
      reviews: [],
      comments: [],
      ...overrides,
    };
  }

  function decide(
    events: ReadonlyArray<PullRequestSwitchEvent>,
    observed: PullRequestWatchObservation,
    overrides: {
      readonly now?: string;
      readonly turnActive?: boolean;
      readonly personTyping?: boolean;
    } = {},
  ) {
    return decidePullRequestWatch({
      fold: replay(events).watch,
      observation: observed,
      now: overrides.now ?? now,
      turnActive: overrides.turnActive ?? false,
      personTyping: overrides.personTyping ?? false,
    });
  }

  it("wakes once when the checks on the head settle, whether they passed or failed", () => {
    expect(decide([watchEnabled()], observation({ checks: "failed" }))).toEqual({
      kind: "wake",
      wake: 1,
      signals: [{ kind: "checks-failed", key: "a1" }],
    });
    const afterFailure = [
      watchEnabled(),
      watchWoke("a1", [{ kind: "checks-failed", key: "a1" }], 1),
    ];
    expect(decide(afterFailure, observation({ checks: "failed" }))).toEqual({ kind: "idle" });
    expect(decide(afterFailure, observation({ headSha: "a2", checks: "passed" }))).toEqual({
      kind: "wake",
      wake: 2,
      signals: [{ kind: "checks-passed", key: "a2" }],
    });
  });

  it("stays quiet while checks run and for what was already true when the watch began", () => {
    expect(decide([watchEnabled()], observation({ checks: "pending" }))).toEqual({ kind: "idle" });
    expect(
      decide(
        [
          watchEnabled([
            { kind: "checks-passed", key: "a1" },
            { kind: "review-decision", key: "review-required" },
            { kind: "conflict", key: "a1" },
          ]),
        ],
        observation({ checks: "passed", reviewDecision: "review-required", conflicting: true }),
      ),
    ).toEqual({ kind: "idle" });
  });

  it("wakes for a review or comment posted after the watch began, but not one from before", () => {
    const decision = decide(
      [watchEnabled()],
      observation({
        reviews: [
          { id: "PRR_old", at: "2026-11-01T09:00:00.000Z" },
          { id: "PRR_new", at: "2026-11-01T10:30:00.000Z" },
        ],
        comments: [{ id: "IC_new", at: "2026-11-01T10:40:00.000Z" }],
      }),
    );
    expect(decision).toEqual({
      kind: "wake",
      wake: 1,
      signals: [
        { kind: "review", key: "PRR_new" },
        { kind: "comment", key: "IC_new" },
      ],
    });
  });

  it("coalesces everything one observation found into a single wake", () => {
    const decision = decide(
      [watchEnabled([{ kind: "review-decision", key: "review-required" }])],
      observation({
        checks: "failed",
        reviewDecision: "changes-requested",
        conflicting: true,
        reviews: [{ id: "PRR_1", at: "2026-11-01T10:30:00.000Z" }],
      }),
    );
    expect(decision).toEqual({
      kind: "wake",
      wake: 1,
      signals: [
        { kind: "checks-failed", key: "a1" },
        { kind: "review-decision", key: "changes-requested" },
        { kind: "conflict", key: "a1" },
        { kind: "review", key: "PRR_1" },
      ],
    });
  });

  it("wakes when the review decision changes, and again when it changes back", () => {
    const events = [
      watchEnabled([{ kind: "review-decision", key: "approved" }]),
      watchWoke("a1", [{ kind: "review-decision", key: "changes-requested" }], 1),
    ];
    expect(decide(events, observation({ reviewDecision: "changes-requested" }))).toEqual({
      kind: "idle",
    });
    expect(decide(events, observation({ reviewDecision: "approved" }))).toEqual({
      kind: "wake",
      wake: 2,
      signals: [{ kind: "review-decision", key: "approved" }],
    });
  });

  it("wakes again for a conflict on a new head", () => {
    const events = [watchEnabled(), watchWoke("a1", [{ kind: "conflict", key: "a1" }], 1)];
    expect(decide(events, observation({ conflicting: true }))).toEqual({ kind: "idle" });
    expect(decide(events, observation({ headSha: "a2", conflicting: true }))).toEqual({
      kind: "wake",
      wake: 2,
      signals: [{ kind: "conflict", key: "a2" }],
    });
  });

  it("tries a wake that never started a turn again, without spending a wake", () => {
    const events = [
      watchEnabled(),
      watchWoke("a1", [{ kind: "checks-failed", key: "a1" }], 1, "refused"),
    ];
    expect(decide(events, observation({ checks: "failed" }))).toEqual({
      kind: "wake",
      wake: 1,
      signals: [{ kind: "checks-failed", key: "a1" }],
    });
  });

  it("holds a wake while a turn runs or the person is typing", () => {
    const failed = observation({ checks: "failed" });
    expect(decide([watchEnabled()], failed, { turnActive: true })).toEqual({
      kind: "paused",
      reason: "turn-active",
    });
    expect(decide([watchEnabled()], failed, { personTyping: true })).toEqual({
      kind: "paused",
      reason: "person-typing",
    });
  });

  it("ends when the pull request merges or closes", () => {
    expect(decide([watchEnabled()], observation({ state: "merged" }))).toEqual({
      kind: "stop",
      reason: "merged",
    });
    expect(decide([watchEnabled()], observation({ state: "closed" }))).toEqual({
      kind: "stop",
      reason: "closed",
    });
  });

  it("ends three days after it began, even with something new to report", () => {
    const failed = observation({ checks: "failed" });
    expect(decide([watchEnabled()], failed, { now: "2026-11-04T09:59:59.000Z" }).kind).toBe("wake");
    expect(decide([watchEnabled()], failed, { now: "2026-11-04T10:00:00.000Z" })).toEqual({
      kind: "stop",
      reason: "expired",
    });
    const fold = replay([watchEnabled()]).watch;
    expect(pullRequestWatchExpired(fold, "2026-11-04T10:00:00.000Z")).toBe(true);
    expect(pullRequestWatchExpired(fold, "2026-11-04T09:59:59.000Z")).toBe(false);
  });

  it("ends after ten started wakes instead of waking an eleventh time", () => {
    const wakes = Array.from({ length: 10 }, (_, index) =>
      watchWoke(`a${index}`, [{ kind: "checks-failed", key: `a${index}` }], index + 1),
    );
    expect(
      decide([watchEnabled(), ...wakes], observation({ headSha: "b1", checks: "failed" })),
    ).toEqual({ kind: "stop", reason: "wake-limit" });
  });

  it("starts with a fresh budget when the watch is turned on again, and does nothing once off", () => {
    const wakes = Array.from({ length: 10 }, (_, index) =>
      watchWoke(`a${index}`, [{ kind: "checks-failed", key: `a${index}` }], index + 1),
    );
    expect(
      decide([watchEnabled(), ...wakes, watchEnabled()], observation({ checks: "failed" })),
    ).toEqual({ kind: "wake", wake: 1, signals: [{ kind: "checks-failed", key: "a1" }] });
    const off: PullRequestSwitchEvent = {
      kind: "watch",
      occurredAt: now,
      record: { target, threadId, change: { kind: "disabled" } },
    };
    expect(decide([watchEnabled(), off], observation({ checks: "failed" }))).toEqual({
      kind: "idle",
    });
  });

  it("takes as its baseline only what is settled, decided, or conflicting on the head", () => {
    expect(pullRequestWatchBaseline(observation())).toEqual([]);
    expect(
      pullRequestWatchBaseline(
        observation({
          checks: "passed",
          reviewDecision: "approved",
          conflicting: true,
          comments: [{ id: "IC_1", at: enabledAt }],
        }),
      ),
    ).toEqual([
      { kind: "checks-passed", key: "a1" },
      { kind: "review-decision", key: "approved" },
      { kind: "conflict", key: "a1" },
    ]);
  });
});

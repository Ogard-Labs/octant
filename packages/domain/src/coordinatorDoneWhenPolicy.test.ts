import type { CodeThreadId, CoordinatorDoneWhen } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  COORDINATOR_DONE_WHEN_INITIAL_DELAY_MS,
  COORDINATOR_DONE_WHEN_MAX_DELAY_MS,
  coordinatorDoneWhenEqual,
  coordinatorDoneWhenPullRequestKey,
  coordinatorDoneWhenWakePrompt,
  evaluateCoordinatorDoneWhen,
  nextCoordinatorDoneWhenCheck,
} from "./coordinatorDoneWhenPolicy";

const THREAD_A = "10000000-0000-4000-8000-000000000011" as CodeThreadId;
const THREAD_B = "10000000-0000-4000-8000-000000000012" as CodeThreadId;

const condition: CoordinatorDoneWhen = {
  items: [
    {
      kind: "pull-request-merged",
      repositoryOwner: "Ogard-Labs",
      repositoryName: "octant",
      number: 42,
    },
    {
      kind: "pull-request-checks-green",
      repositoryOwner: "Ogard-Labs",
      repositoryName: "octant",
      number: 42,
    },
    { kind: "thread-done", threadId: THREAD_A },
  ],
};

describe("coordinator done-when condition policy", () => {
  it("reports only the unmet items from closed-set host facts and marks met once every item holds", () => {
    const prKey = coordinatorDoneWhenPullRequestKey("Ogard-Labs", "octant", 42);
    const partial = evaluateCoordinatorDoneWhen(condition, {
      pullRequests: new Map([
        [prKey, { status: "observed", state: "open", requiredChecks: "green" }],
      ]),
      threads: new Map([[String(THREAD_A), "not-done"]]),
    });
    expect(partial).toEqual({
      status: "unmet",
      unmet: [
        "pull request Ogard-Labs/octant#42 is not merged (open)",
        `thread ${String(THREAD_A)} is not Done`,
      ],
    });

    const failingChecks = evaluateCoordinatorDoneWhen(condition, {
      pullRequests: new Map([
        [prKey, { status: "observed", state: "open", requiredChecks: "failing" }],
      ]),
      threads: new Map([[String(THREAD_A), "done"]]),
    });
    expect(failingChecks).toEqual({
      status: "unmet",
      unmet: [
        "pull request Ogard-Labs/octant#42 is not merged (open)",
        "pull request Ogard-Labs/octant#42 required checks are failing",
      ],
    });

    const satisfied = evaluateCoordinatorDoneWhen(condition, {
      pullRequests: new Map([
        [prKey, { status: "observed", state: "merged", requiredChecks: "green" }],
      ]),
      threads: new Map([[String(THREAD_A), "done"]]),
    });
    expect(satisfied).toEqual({ status: "met" });
  });

  it("treats unavailable forge reads and closed or missing items as unmet", () => {
    const prKey = coordinatorDoneWhenPullRequestKey("Ogard-Labs", "octant", 42);
    const unavailable = evaluateCoordinatorDoneWhen(condition, {
      pullRequests: new Map([[prKey, { status: "unavailable" }]]),
      threads: new Map([[String(THREAD_A), "missing"]]),
    });
    expect(unavailable).toEqual({
      status: "unmet",
      unmet: [
        "pull request Ogard-Labs/octant#42 could not be checked",
        "pull request Ogard-Labs/octant#42 required checks could not be checked",
        `thread ${String(THREAD_A)} was not found`,
      ],
    });
  });

  it("backs off exponentially up to the cap while unmet, resets when the unmet set changes, and stops once met", () => {
    const unmetTwo = {
      status: "unmet" as const,
      unmet: [
        "pull request Ogard-Labs/octant#42 is not merged (open)",
        `thread ${String(THREAD_A)} is not Done`,
      ],
    };
    const first = nextCoordinatorDoneWhenCheck({ now: 1_000, evaluation: unmetTwo });
    expect(first).toEqual({
      status: "pending",
      attempts: 1,
      nextCheckAt: 1_000 + COORDINATOR_DONE_WHEN_INITIAL_DELAY_MS,
      lastUnmetKey: unmetTwo.unmet.join("\n"),
    });
    if (first.status !== "pending") throw new Error("expected pending");

    const second = nextCoordinatorDoneWhenCheck({
      now: first.nextCheckAt,
      previous: first,
      evaluation: unmetTwo,
    });
    expect(second).toEqual({
      status: "pending",
      attempts: 2,
      nextCheckAt: first.nextCheckAt + COORDINATOR_DONE_WHEN_INITIAL_DELAY_MS * 2,
      lastUnmetKey: unmetTwo.unmet.join("\n"),
    });
    if (second.status !== "pending") throw new Error("expected pending");

    // Repeated unchanged checks cap at the maximum delay.
    let state = second;
    for (let i = 0; i < 8; i += 1) {
      const next = nextCoordinatorDoneWhenCheck({
        now: state.nextCheckAt,
        previous: state,
        evaluation: unmetTwo,
      });
      if (next.status !== "pending") throw new Error("expected pending");
      expect(next.nextCheckAt - state.nextCheckAt).toBeLessThanOrEqual(
        COORDINATOR_DONE_WHEN_MAX_DELAY_MS,
      );
      state = next;
    }
    expect(state.nextCheckAt).toBeGreaterThan(0);

    // Progress (fewer unmet items) resets backoff to the initial delay.
    const unmetOne = {
      status: "unmet" as const,
      unmet: ["pull request Ogard-Labs/octant#42 is not merged (open)"],
    };
    const progressed = nextCoordinatorDoneWhenCheck({
      now: state.nextCheckAt,
      previous: state,
      evaluation: unmetOne,
    });
    expect(progressed).toEqual({
      status: "pending",
      attempts: 1,
      nextCheckAt: state.nextCheckAt + COORDINATOR_DONE_WHEN_INITIAL_DELAY_MS,
      lastUnmetKey: unmetOne.unmet.join("\n"),
    });

    // Once all items hold, checking stops.
    const done = nextCoordinatorDoneWhenCheck({
      now: state.nextCheckAt + 60_000,
      previous: state,
      evaluation: { status: "met" },
    });
    expect(done).toEqual({ status: "satisfied" });
  });

  it("compares conditions structurally and formats wake prompts with only the unmet items", () => {
    expect(coordinatorDoneWhenEqual(undefined, undefined)).toBe(true);
    expect(coordinatorDoneWhenEqual(condition, undefined)).toBe(false);
    expect(
      coordinatorDoneWhenEqual(
        { items: [{ kind: "thread-done", threadId: THREAD_A }] },
        { items: [{ kind: "thread-done", threadId: THREAD_B }] },
      ),
    ).toBe(false);
    expect(coordinatorDoneWhenEqual(condition, { items: [...condition.items] })).toBe(true);

    const prompt = coordinatorDoneWhenWakePrompt([
      "pull request Ogard-Labs/octant#42 is not merged (open)",
    ]);
    expect(prompt).toContain("pull request Ogard-Labs/octant#42 is not merged (open)");
    expect(prompt).not.toContain("thread");
  });
});

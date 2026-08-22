import type { CodeBoardCard, CodeBoardStatus } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import {
  codeBoardStatusLabel,
  codeBoardStatusReasonLabel,
  groupCodeBoardCards,
  type CodeBoardProjectRef,
} from "./codeBoardGrouping";

const projectA = "00000000-0000-4000-8000-0000000040a1" as ProjectId;
const projectB = "00000000-0000-4000-8000-0000000040a2" as ProjectId;

function card(overrides: {
  readonly id: string;
  readonly status: CodeBoardStatus;
  readonly projectId?: ProjectId;
  readonly activity?: string | null;
  readonly recovering?: boolean;
}): CodeBoardCard {
  return {
    threadId: overrides.id,
    projectId: overrides.projectId ?? projectA,
    checkoutId: "00000000-0000-4000-8000-0000000040ff",
    title: `Thread ${overrides.id}`,
    status: overrides.status,
    statusReason:
      overrides.status === "done"
        ? "delivery-satisfied"
        : overrides.status === "in-progress"
          ? "executing"
          : overrides.status === "waiting"
            ? overrides.recovering
              ? "recovering"
              : "awaiting-input"
            : "idle-unmet-delivery",
    checkoutKind: "existing-worktree",
    outcomeKind: "local-implementation",
    deliverySatisfaction: overrides.status === "done" ? "done" : "pending",
    providerInstanceId: "00000000-0000-4000-8000-0000000040fe",
    modelId: "model-a",
    executing: overrides.status === "in-progress",
    worktree: { kind: "unavailable", checkoutId: "00000000-0000-4000-8000-0000000040ff" },
    changedFiles: { kind: "unavailable" },
    linkedPullRequest: { kind: "none", freshness: "fresh" },
    pullRequestSummaries: { items: [], hiddenCount: 0 },
    checks: { freshness: "fresh", state: "unknown" },
    reviewState: { freshness: "fresh", state: "unknown" },
    childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
    recovery: overrides.recovering
      ? { kind: "recovering", reasons: ["project-projection-missing"] }
      : { kind: "ok" },
    githubFreshness: "fresh",
    followUp: false,
    lastMeaningfulActivityAt:
      overrides.activity === undefined
        ? null
        : (overrides.activity as CodeBoardCard["lastMeaningfulActivityAt"]),
  } as CodeBoardCard;
}

const projects: readonly CodeBoardProjectRef[] = [
  { id: projectA, name: "Project A" },
  { id: projectB, name: "Project B" },
];

describe("codeBoardStatusLabel", () => {
  it("labels each status with human-readable text", () => {
    expect(codeBoardStatusLabel("ready")).toBe("Ready");
    expect(codeBoardStatusLabel("in-progress")).toBe("In Progress");
    expect(codeBoardStatusLabel("waiting")).toBe("Waiting");
    expect(codeBoardStatusLabel("done")).toBe("Done");
  });

  it("labels each specific board reason", () => {
    expect(codeBoardStatusReasonLabel("awaiting-input")).toBe("Waiting for a decision or input");
    expect(codeBoardStatusReasonLabel("recovering")).toBe(
      "Recovering Project or operation history",
    );
    expect(codeBoardStatusReasonLabel("delivery-waiting")).toBe(
      "Delivery evidence is stale or ambiguous",
    );
    expect(codeBoardStatusReasonLabel("delivery-satisfied")).toBe(
      "The confirmed delivery target is satisfied",
    );
  });
});

describe("groupCodeBoardCards by status", () => {
  it("uses the four fixed status columns in order and sorts by recent activity", () => {
    const cards = [
      card({ id: "d", status: "done", activity: "2026-07-22T10:00:00.000Z" }),
      card({ id: "w-old", status: "waiting", activity: "2026-07-22T09:00:00.000Z" }),
      card({ id: "w-new", status: "waiting", activity: "2026-07-22T11:00:00.000Z" }),
      card({ id: "r", status: "ready", activity: null }),
    ];
    const columns = groupCodeBoardCards(cards, "status", { projects });

    expect(columns.map((column) => column.label)).toEqual([
      "Ready",
      "In Progress",
      "Waiting",
      "Done",
    ]);
    const waiting = columns.find((column) => column.status === "waiting")!;
    expect(waiting.cards.map((c) => c.threadId)).toEqual(["w-new", "w-old"]);
    // Done stays a first-class visible column.
    expect(columns.find((column) => column.status === "done")!.cards).toHaveLength(1);
  });

  it("keeps empty status columns so the layout is stable", () => {
    const columns = groupCodeBoardCards([card({ id: "r", status: "ready" })], "status", {
      projects,
    });
    expect(columns.find((column) => column.status === "in-progress")!.cards).toHaveLength(0);
  });
});

describe("groupCodeBoardCards by project", () => {
  it("creates one column per represented project in configured order and prioritizes status", () => {
    const cards = [
      card({
        id: "a-done",
        status: "done",
        projectId: projectA,
        activity: "2026-07-22T10:00:00.000Z",
      }),
      card({
        id: "a-waiting",
        status: "waiting",
        projectId: projectA,
        activity: "2026-07-22T09:00:00.000Z",
      }),
      card({ id: "b-ready", status: "ready", projectId: projectB }),
    ];
    const columns = groupCodeBoardCards(cards, "project", { projects });

    expect(columns.map((column) => column.label)).toEqual(["Project A", "Project B"]);
    const a = columns.find((column) => column.projectId === projectA)!;
    // Waiting before Done; every Done card stays visible below.
    expect(a.cards.map((c) => c.threadId)).toEqual(["a-waiting", "a-done"]);
  });
});

describe("groupCodeBoardCards recovery", () => {
  it("keeps recovering cards in Waiting with their specific reason", () => {
    const cards = [
      card({ id: "ok", status: "ready", projectId: projectA }),
      card({ id: "recovering", status: "waiting", projectId: projectB, recovering: true }),
    ];

    const columns = groupCodeBoardCards(cards, "status", { projects });
    expect(columns.some((column) => column.key === "recovery")).toBe(false);
    const waiting = columns.find((column) => column.status === "waiting")!;
    expect(waiting.cards.map((c) => c.threadId)).toEqual(["recovering"]);
    expect(waiting.cards[0]?.statusReason).toBe("recovering");
  });
});

describe("codeBoardStatusReasonLabel", () => {
  it("labels each Waiting reason specifically", () => {
    expect(codeBoardStatusReasonLabel("awaiting-input")).toBe("Waiting for a decision or input");
    expect(codeBoardStatusReasonLabel("recovering")).toBe(
      "Recovering Project or operation history",
    );
    expect(codeBoardStatusReasonLabel("interrupted")).toBe("The last agent turn was interrupted");
  });
});

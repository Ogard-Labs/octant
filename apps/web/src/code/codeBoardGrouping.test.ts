import type { CodeBoardCard, CodeBoardStatus } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import {
  codeBoardStatusLabel,
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
    outcomeKind: "local-implementation",
    deliverySatisfaction: overrides.status === "done" ? "done" : "pending",
    providerInstanceId: "00000000-0000-4000-8000-0000000040fe",
    modelId: "model-a",
    executing: overrides.status === "in-progress",
    worktree: { kind: "unavailable", checkoutId: "00000000-0000-4000-8000-0000000040ff" },
    changedFiles: { kind: "unavailable" },
    linkedPullRequest: { kind: "none", freshness: "fresh" },
    checks: { freshness: "fresh", state: "unknown" },
    reviewState: { freshness: "fresh", state: "unknown" },
    childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
    recovery: overrides.recovering
      ? { kind: "recovering", reasons: ["project-projection-missing"] }
      : { kind: "ok" },
    githubFreshness: "fresh",
    unread: false,
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
  it("surfaces recovering cards in a dedicated Recovery column in both groupings", () => {
    const cards = [
      card({ id: "ok", status: "ready", projectId: projectA }),
      card({ id: "recovering", status: "waiting", projectId: projectB, recovering: true }),
    ];

    for (const grouping of ["status", "project"] as const) {
      const columns = groupCodeBoardCards(cards, grouping, { projects });
      const recovery = columns.find((column) => column.kind === "recovery");
      expect(recovery?.cards.map((c) => c.threadId)).toEqual(["recovering"]);
      // The recovering card is not duplicated into any status/project column.
      const placed = columns
        .filter((column) => column.kind !== "recovery")
        .flatMap((column) => column.cards.map((c) => c.threadId));
      expect(placed).not.toContain("recovering");
      expect(placed).toContain("ok");
    }
  });

  it("omits the Recovery column when no card is recovering", () => {
    const columns = groupCodeBoardCards([card({ id: "ok", status: "ready" })], "status", {
      projects,
    });
    expect(columns.some((column) => column.kind === "recovery")).toBe(false);
  });
});

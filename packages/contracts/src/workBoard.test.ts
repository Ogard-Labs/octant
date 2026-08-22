import { describe, expect, it } from "vitest";
import {
  decodeWorkBoardCard,
  decodeWorkBoardQuery,
  decodeWorkBoardStatus,
  decodeWorkBoardStatusReason,
  decodeWorkBoardView,
} from "./workBoard";

const ids = {
  thread: "00000000-0000-4000-8000-000000006001",
  other: "00000000-0000-4000-8000-000000006002",
  project: "00000000-0000-4000-8000-0000000060a1",
  provider: "00000000-0000-4000-8000-0000000060fe",
} as const;

function boardCard(overrides: Record<string, unknown> = {}) {
  return {
    threadId: ids.thread,
    projectId: ids.project,
    title: "Draft brief",
    status: "ready",
    statusReason: "idle-unmet-delivery",
    deliveryTarget: "Draft brief",
    deliverySatisfaction: "pending",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    executing: false,
    binding: { kind: "bound", workingDirectory: "." },
    activeRequest: { kind: "none" },
    artifacts: { count: 0 },
    citations: { count: 0, staleCount: 0 },
    goal: { kind: "none" },
    childRuns: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
    pullRequestSummaries: { items: [], hiddenCount: 0 },
    recovery: { kind: "ok" },
    staleEvidence: false,
    followUp: false,
    lastMeaningfulActivityAt: null,
    ...overrides,
  };
}

describe("Work board contracts", () => {
  it("decodes the shared board statuses and reasons", () => {
    for (const status of ["ready", "in-progress", "waiting", "done"] as const) {
      expect(decodeWorkBoardStatus(status)).toBe(status);
    }
    expect(() => decodeWorkBoardStatus("blocked")).toThrow();
    for (const reason of [
      "delivery-satisfied",
      "executing",
      "awaiting-input",
      "interrupted",
      "recovering",
      "delivery-waiting",
      "idle-unmet-delivery",
    ] as const) {
      expect(decodeWorkBoardStatusReason(reason)).toBe(reason);
    }
    expect(() => decodeWorkBoardStatusReason("blocked")).toThrow();
  });

  it("decodes a minimal default query and a fully specified query", () => {
    expect(decodeWorkBoardQuery({ version: 1 })).toEqual({ version: 1 });

    const full = {
      version: 1,
      text: "brief",
      statuses: ["ready", "in-progress", "waiting", "done"],
      projectIds: [ids.project],
      providerInstanceIds: [ids.provider],
      followUp: "only",
      pendingRequest: "only",
    } as const;
    expect(decodeWorkBoardQuery(full)).toEqual(full);
  });

  it("rejects duplicate or unknown query filter values and excess properties", () => {
    expect(() => decodeWorkBoardQuery({ version: 1, statuses: ["ready", "ready"] })).toThrow();
    expect(() => decodeWorkBoardQuery({ version: 1, statuses: ["blocked"] })).toThrow();
    expect(() => decodeWorkBoardQuery({ version: 1, followUp: "maybe" })).toThrow();
    expect(() => decodeWorkBoardQuery({ version: 1, pendingRequest: "maybe" })).toThrow();
    expect(() => decodeWorkBoardQuery({ version: 1, unexpected: true })).toThrow();
  });

  it("strictly decodes a Work board card and rejects unread or Code-only fields", () => {
    const card = boardCard({
      status: "done",
      statusReason: "delivery-satisfied",
      deliverySatisfaction: "done",
      followUp: true,
      lastMeaningfulActivityAt: "2026-07-21T12:05:00.000Z",
    });
    expect(decodeWorkBoardCard(card)).toEqual(card);

    expect(() => decodeWorkBoardCard({ ...boardCard(), unread: true })).toThrow();
    expect(() => decodeWorkBoardCard({ ...boardCard(), status: "blocked" })).toThrow();
    expect(() =>
      decodeWorkBoardCard({ ...boardCard(), checkoutKind: "managed-worktree" }),
    ).toThrow();
    expect(() => decodeWorkBoardCard({ ...boardCard(), extra: 1 })).toThrow();
  });

  it("strictly decodes a board view and rejects duplicate cards", () => {
    const view = {
      version: 1,
      query: { version: 1, statuses: ["ready", "in-progress", "waiting", "done"] },
      cards: [boardCard(), boardCard({ threadId: ids.other })],
      generatedAt: "2026-07-21T12:05:00.000Z",
    } as const;
    expect(decodeWorkBoardView(view)).toEqual(view);

    expect(() => decodeWorkBoardView({ ...view, cards: [boardCard(), boardCard()] })).toThrow();
  });
});

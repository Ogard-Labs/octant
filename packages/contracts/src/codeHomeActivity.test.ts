import { describe, expect, it } from "vitest";
import { decodeActivityDeliveryObserved, decodeActivityRecord } from "./codeHomeActivity";

const mergedDelivery = {
  kind: "prs-merged",
  projectId: "10000000-0000-4000-8000-000000000001",
  threadId: "10000000-0000-4000-8000-000000000002",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
  occurredAt: "2026-08-22T08:00:00.000Z",
  mergedBy: "octocat",
} as const;

const mergedRecord = {
  kind: "prs-merged",
  occurredAt: "2026-08-22T08:00:00.000Z",
  id: "octant/octant#12",
  label: "Ship the panel",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 12,
  mergedBy: "octocat",
  threadId: "10000000-0000-4000-8000-000000000002",
} as const;

describe("code home activity contracts", () => {
  it("accepts a merge performed by a GitHub app actor", () => {
    const decoded = decodeActivityDeliveryObserved({
      ...mergedDelivery,
      mergedBy: "github-actions[bot]",
    });
    expect(decoded).toMatchObject({ kind: "prs-merged", mergedBy: "github-actions[bot]" });
    expect(
      decodeActivityRecord({ ...mergedRecord, mergedBy: "github-actions[bot]" }),
    ).toMatchObject({ mergedBy: "github-actions[bot]" });
  });

  it.each(["not a login", "octocat[bot", "octocat[bot][bot]", "[bot]octocat", "octocat[app]"])(
    "refuses a merger login that is not a GitHub actor (%s)",
    (mergedBy) => {
      expect(() => decodeActivityDeliveryObserved({ ...mergedDelivery, mergedBy })).toThrow();
      expect(() => decodeActivityRecord({ ...mergedRecord, mergedBy })).toThrow();
    },
  );
});

import { describe, expect, it } from "vitest";
import type { MobileInboxRow } from "@octant/client-runtime";
import { searchHitsBesideList, sectionForAgentRow } from "./agentsListPresentation";

const codeRow = (reviewState: NonNullable<MobileInboxRow["reviewState"]>): MobileInboxRow => ({
  hostId: "11111111-1111-4111-8111-111111111111",
  mode: "code",
  threadId: "60000000-0000-4000-8000-000000000001",
  title: "Code task",
  status: "active",
  freshness: "2026-08-10T09:30:00.000Z",
  reviewState,
});

describe("Agents list grouping", () => {
  it("uses authoritative Code review state before lifecycle text", () => {
    expect(sectionForAgentRow(codeRow("pending"))).toBe("review");
    expect(sectionForAgentRow(codeRow("approved"))).toBe("review");
    expect(sectionForAgentRow(codeRow("changes-requested"))).toBe("attention");
  });
});

describe("search hits beside the filtered list", () => {
  const hostId = "11111111-1111-4111-8111-111111111111";
  const listed = {
    hostId,
    mode: "code" as const,
    threadId: "60000000-0000-4000-8000-000000000001",
  };
  const titleHit = { ...listed, field: "title", title: "Parser token" };

  it("keeps a title match the filtered list does not show, and drops one it already shows", () => {
    // "token parser" finds "Parser token" on the host, while the list's
    // whole-query filter hides that row: the hit is the only place it shows.
    expect(searchHitsBesideList([titleHit], [])).toEqual([titleHit]);
    expect(searchHitsBesideList([titleHit], [listed])).toEqual([]);
  });

  it("always keeps message, tool, and Canvas matches", () => {
    const reply = { ...listed, field: "reply" };
    expect(searchHitsBesideList([reply], [listed])).toEqual([reply]);
  });
});

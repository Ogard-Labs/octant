import { describe, expect, it } from "vitest";
import type { MobileInboxRow } from "@octant/client-runtime";
import { sectionForAgentRow } from "./agentsListPresentation";

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

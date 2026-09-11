import { describe, expect, it } from "vitest";
import {
  appendWorkRecentChange,
  decideWorkResumeBrief,
  isWorkStatusStale,
  parseWorkStatus,
  workStatusTemplate,
} from "./workProjectStatusPolicy";

const today = "2026-09-12";

describe("a Work Project's STATUS.md", () => {
  it("parses the template it was seeded from as fresh, with no reminders", () => {
    const parsed = parseWorkStatus(workStatusTemplate("Acme offer", today), today);
    expect(parsed.lastUpdatedOn).toBe(today);
    expect(parsed.currentStatus).toBe("Nothing recorded yet.");
    expect(parsed.followUps).toEqual([]);
    expect(parsed.deadlines).toEqual([]);
    expect(isWorkStatusStale(parsed, today)).toBe(false);
    expect(decideWorkResumeBrief(parsed, today)).toEqual([]);
  });

  it("reads dated follow-ups and deadlines and judges how near they are", () => {
    const text = [
      "# Acme — status",
      "Last updated: 2026-09-10",
      "## Current status",
      "Offer v2 sent, waiting on procurement.",
      "## Follow-ups",
      "- 2026-09-14 Call Dana about the revised scope",
      "- someday: not a dated line",
      "## Deadlines",
      "- 2026-09-01 — Signed offer was due",
      "- 2026-10-01: Kick-off if signed",
    ].join("\n");
    const parsed = parseWorkStatus(text, today);
    expect(parsed.currentStatus).toBe("Offer v2 sent, waiting on procurement.");
    expect(parsed.followUps).toEqual([
      { date: "2026-09-14", text: "Call Dana about the revised scope", state: "due-soon" },
    ]);
    expect(parsed.deadlines).toEqual([
      { date: "2026-09-01", text: "Signed offer was due", state: "overdue" },
      { date: "2026-10-01", text: "Kick-off if signed", state: "upcoming" },
    ]);
    expect(decideWorkResumeBrief(parsed, today)).toEqual(["overdue", "due-soon"]);
  });

  it("treats an undated or two-week-old status as stale", () => {
    expect(isWorkStatusStale(parseWorkStatus("# x\n## Current status\nhi", today), today)).toBe(
      true,
    );
    const old = parseWorkStatus("Last updated: 2026-08-28", today);
    expect(isWorkStatusStale(old, today)).toBe(true);
    expect(decideWorkResumeBrief(old, today)).toEqual(["stale"]);
    expect(isWorkStatusStale(parseWorkStatus("Last updated: 2026-09-06", today), today)).toBe(
      false,
    );
  });

  it("appends what a turn changed under Recent changes, newest first, and leaves the rest alone", () => {
    const seeded = workStatusTemplate("Acme", "2026-09-01");
    const once = appendWorkRecentChange(seeded, {
      date: "2026-09-10",
      taskTitle: "Draft the offer",
      paths: ["offer-v1.docx"],
      truncated: false,
    });
    const twice = appendWorkRecentChange(once, {
      date: "2026-09-12",
      taskTitle: "Revise pricing",
      paths: ["offer-v2.docx", "pricing.xlsx"],
      truncated: true,
    });
    const changes = twice.slice(twice.indexOf("## Recent changes"));
    expect(changes.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- 2026-09-12 Revise pricing: `offer-v2.docx`, `pricing.xlsx` (list incomplete)",
      "- 2026-09-10 Draft the offer: `offer-v1.docx`",
    ]);
    // The person's own sections and the Last updated line are untouched.
    expect(twice.slice(0, twice.indexOf("## Recent changes"))).toBe(
      seeded.slice(0, seeded.indexOf("## Recent changes")),
    );
  });

  it("creates the Recent changes section when a hand-written status lacks it", () => {
    const appended = appendWorkRecentChange("# Notes\nJust text", {
      date: "2026-09-12",
      taskTitle: "Task",
      paths: ["a.md"],
      truncated: false,
    });
    expect(appended).toBe("# Notes\nJust text\n\n## Recent changes\n\n- 2026-09-12 Task: `a.md`\n");
  });
});

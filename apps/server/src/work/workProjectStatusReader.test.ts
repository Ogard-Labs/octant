import { decodeProjectId, type UtcTimestamp } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { WorkProjectStatusReader } from "./workProjectStatusReader";

const projectId = decodeProjectId("72000000-0000-4000-8000-000000000002");
const today = "2026-07-26";

function statusFile(text: string): { text: string; modifiedAt: UtcTimestamp } {
  return { text, modifiedAt: `${today}T08:00:00.000Z` as UtcTimestamp };
}

function readerWith(options: {
  readonly statusText?: string;
  readonly throws?: boolean;
  readonly today?: string;
}): WorkProjectStatusReader {
  return new WorkProjectStatusReader({
    files: {
      read: async () => {
        if (options.throws === true) throw new Error("folder refused the read");
        return {
          agents: undefined,
          status: options.statusText === undefined ? undefined : statusFile(options.statusText),
        };
      },
    },
    clock: () => `${options.today ?? today}T12:00:00.000Z`,
  });
}

const STATUS_WITH_DATES = [
  "# Acme — status",
  "",
  `Last updated: ${today}`,
  "",
  "## Current status",
  "",
  "Offer v2 sent.",
  "",
  "## Follow-ups",
  "",
  "- 2026-08-20 Confirm renewal terms",
  "- 2026-07-27 Chase legal review",
  "",
  "## Deadlines",
  "",
  "- 2026-07-20 Offer v2 signature window closed",
  "- 2026-07-28 Procurement portal opens",
  "",
  "## Recent changes",
  "",
].join("\n");

describe("WorkProjectStatusReader dueReminder", () => {
  it("names the most urgent dated line: what passed outranks what is near", async () => {
    const reader = readerWith({ statusText: STATUS_WITH_DATES });
    await expect(reader.dueReminder(projectId, "/tmp/acme")).resolves.toEqual({
      date: "2026-07-20",
      text: "Offer v2 signature window closed",
      state: "overdue",
    });
  });

  it("answers nothing when every dated line is still comfortably ahead", async () => {
    const reader = readerWith({
      statusText: STATUS_WITH_DATES.replace("2026-07-20", "2026-09-20")
        .replace("2026-07-27", "2026-08-27")
        .replace("2026-07-28", "2026-09-28"),
    });
    await expect(reader.dueReminder(projectId, "/tmp/acme")).resolves.toBeUndefined();
    await expect(reader.hasDueItems(projectId, "/tmp/acme")).resolves.toBe(false);
  });

  it("answers nothing when the folder refuses the read", async () => {
    const reader = readerWith({ throws: true });
    await expect(reader.dueReminder(projectId, "/tmp/acme")).resolves.toBeUndefined();
    await expect(reader.hasDueItems(projectId, "/tmp/acme")).resolves.toBe(false);
  });
});

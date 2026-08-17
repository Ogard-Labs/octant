import { describe, expect, it } from "vitest";
import { findDecisionViolations, type ScannedFile } from "./check-decisions";

function record(number: string, slug: string, body: string): ScannedFile {
  return { path: `docs/decisions/${number}-${slug}.md`, content: body };
}

function wellFormed(number: string, title: string, status = "Accepted"): string {
  return [
    `# ${number}. ${title}`,
    "",
    `**Status:** ${status}`,
    "",
    "## Context",
    "",
    "Why.",
    "",
    "## Decision",
    "",
    "What.",
    "",
    "## Consequences",
    "",
    "So.",
    "",
  ].join("\n");
}

function index(...rows: ReadonlyArray<string>): ScannedFile {
  return {
    path: "docs/decisions/README.md",
    content: ["| ADR | Title | Status |", "| --- | --- | --- |", ...rows, ""].join("\n"),
  };
}

function row(number: string, slug: string, title: string, status = "Accepted"): string {
  return `| [${number}](${number}-${slug}.md) | ${title} | ${status} |`;
}

function reasons(files: ReadonlyArray<ScannedFile>): ReadonlyArray<string> {
  return findDecisionViolations(files).map((violation) => violation.reason);
}

describe("findDecisionViolations", () => {
  it("accepts a record the index agrees with", () => {
    expect(
      reasons([
        record(
          "0001",
          "plugin-architecture",
          wellFormed("0001", "Plugin architecture", "Proposed"),
        ),
        index(row("0001", "plugin-architecture", "Plugin architecture", "Proposed")),
      ]),
    ).toEqual([]);
  });

  it("rejects a status the conventions do not allow", () => {
    expect(
      reasons([
        record("0001", "plugin-architecture", wellFormed("0001", "Plugin architecture", "Draft")),
        index(row("0001", "plugin-architecture", "Plugin architecture", "Draft")),
      ]),
    ).toEqual(["status `Draft` is not Proposed, Accepted, Deprecated, or Superseded by 00NN"]);
  });

  it("rejects a supersession that points at nothing", () => {
    expect(
      reasons([
        record(
          "0001",
          "plugin-architecture",
          wellFormed("0001", "Plugin architecture", "Superseded by 0042"),
        ),
        index(row("0001", "plugin-architecture", "Plugin architecture", "Superseded by 0042")),
      ]),
    ).toEqual(["superseded by 0042, which does not exist"]);
  });

  it("rejects a record missing a required section", () => {
    expect(
      reasons([
        record(
          "0001",
          "plugin-architecture",
          "# 0001. Plugin architecture\n\n**Status:** Accepted\n\n## Context\n\nWhy.\n\n## Decision\n\nWhat.\n",
        ),
        index(row("0001", "plugin-architecture", "Plugin architecture")),
      ]),
    ).toEqual(["no `## Consequences` section"]);
  });

  // A status or title that drifts out of the index is the failure this gate
  // exists for: an agent routed by the index reads a decision as settled that
  // the record itself still calls Proposed.
  it("rejects an index whose status disagrees with the record", () => {
    expect(
      reasons([
        record(
          "0001",
          "plugin-architecture",
          wellFormed("0001", "Plugin architecture", "Proposed"),
        ),
        index(row("0001", "plugin-architecture", "Plugin architecture", "Accepted")),
      ]),
    ).toEqual(["0001 is Accepted in the index but Proposed in the record"]);
  });

  it("rejects a record the index never lists, and a row with no record", () => {
    expect(
      reasons([
        record("0001", "plugin-architecture", wellFormed("0001", "Plugin architecture")),
        index(row("0002", "durable-event-journal", "Durable event journal")),
      ]),
    ).toEqual(["0001 is missing from the index", "0002 is indexed but has no record"]);
  });

  it("rejects a contract that routes to a record that does not exist", () => {
    expect(
      reasons([
        record("0001", "plugin-architecture", wellFormed("0001", "Plugin architecture")),
        index(row("0001", "plugin-architecture", "Plugin architecture")),
        { path: "AGENTS.md", content: "| Sandbox | `docs/decisions/0009` |\n" },
      ]),
    ).toEqual(["routes to decision record 0009, which does not exist"]);
  });
});

describe("findDecisionViolations, on the gaps a weaker gate leaves", () => {
  it("sees a record whose filename does not match the convention", () => {
    // The dangerous case: a misnamed record is invisible to every other rule, so
    // the missing index row this gate exists to catch would pass unnoticed.
    expect(
      reasons([
        { path: "docs/decisions/0001-first.md", content: wellFormed("0001", "First") },
        { path: "docs/decisions/0002-new_feature.md", content: wellFormed("0002", "Second") },
        index(row("0001", "first", "First")),
      ]),
    ).toContain("is not named `00NN-short-slug.md`, so no rule here can see it");
  });

  it("sees a number skipped between records", () => {
    expect(
      reasons([
        record("0001", "first", wellFormed("0001", "First")),
        record("0003", "third", wellFormed("0003", "Third")),
        index(row("0001", "first", "First"), row("0003", "third", "Third")),
      ]),
    ).toContain("numbering skips 0002 before reaching 0003");
  });

  it("sees the same number indexed twice, even when the last row agrees", () => {
    // The last row wins when the rows collapse into a map, so a stale earlier
    // duplicate would otherwise be hidden by the very row that agrees.
    expect(
      reasons([
        record("0001", "first", wellFormed("0001", "First")),
        index(row("0001", "first", "Stale Title"), row("0001", "first", "First")),
      ]),
    ).toContain("0001 is indexed more than once");
  });

  it("refuses a supersession that points at itself or backwards", () => {
    expect(
      reasons([
        record("0001", "first", wellFormed("0001", "First", "Superseded by 0001")),
        record("0002", "second", wellFormed("0002", "Second", "Superseded by 0001")),
        index(
          row("0001", "first", "First", "Superseded by 0001"),
          row("0002", "second", "Second", "Superseded by 0001"),
        ),
      ]),
    ).toEqual(
      expect.arrayContaining([
        "superseded by 0001, which is not a later record",
        "superseded by 0001, which is not a later record",
      ]),
    );
  });

  it("checks the numbers a written range only implies", () => {
    // Both written ends exist, so only the implied middle can fail here. That is
    // exactly the reference the plain matcher cannot see.
    expect(
      reasons([
        record("0001", "first", wellFormed("0001", "First")),
        record("0003", "third", wellFormed("0003", "Third")),
        index(row("0001", "first", "First"), row("0003", "third", "Third")),
        {
          path: "AGENTS.md",
          content: "| Area | `docs/decisions/0001`–`docs/decisions/0003` |\n",
        },
      ]),
    ).toContain("routes to decision record 0002, which does not exist");
  });
});

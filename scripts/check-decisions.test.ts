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

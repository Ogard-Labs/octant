import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decisions register gate.
 *
 * `check-decisions.ts` and `check-decision-history.ts` read only the closed
 * archive, so nothing read the live register. Its Summary table was maintained
 * by hand and drifted: on 2026-11-12 it claimed 235 entries where the file held
 * 246, ten area rows were wrong, and some status lines used words outside the
 * vocabulary the register defines. This derives the counts from the entries
 * and refuses a table, a status line, or an anchor that disagrees with them.
 */

export const REGISTER_PATH = "docs/design/decisions.md";
export const STATUSES = ["Built.", "Partly built.", "Designed, not built."] as const;
type Status = (typeof STATUSES)[number];

export interface RegisterProblem {
  readonly line: number;
  readonly reason: string;
}

export type RegisterCheck =
  | { readonly status: "consistent"; readonly entries: number }
  | { readonly status: "inconsistent"; readonly problems: ReadonlyArray<RegisterProblem> };

const SUMMARY_HEADING = "Summary";
const STATUS_PREFIX = "Status: ";
const COUNT_COLUMNS = ["Decisions", ...STATUSES.map((status) => status.slice(0, -1))];

/** The anchor a renderer gives a heading: lowercase, punctuation dropped, spaces to hyphens. */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replaceAll(" ", "-");
}

export function checkDecisionsRegister(text: string): RegisterCheck {
  const problems: RegisterProblem[] = [];
  const areas = new Map<string, { readonly heading: string; readonly counts: number[] }>();
  const rows: { line: number; cells: ReadonlyArray<string> }[] = [];
  let area: { readonly heading: string; readonly counts: number[] } | undefined;
  let entry: { readonly line: number; readonly title: string; statuses: number } | undefined;
  let inSummary = false;
  let inFence = false;

  const closeEntry = (): void => {
    if (entry !== undefined && entry.statuses !== 1) {
      problems.push({
        line: entry.line,
        reason: `"${entry.title}" has ${entry.statuses} lines starting "${STATUS_PREFIX}"; an entry has exactly one`,
      });
    }
    entry = undefined;
  };

  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    if (raw.startsWith("```")) inFence = !inFence;
    if (inFence) return;
    if (raw.startsWith("## ")) {
      closeEntry();
      const heading = raw.slice(3).trim();
      inSummary = heading === SUMMARY_HEADING;
      area = inSummary ? undefined : { heading, counts: COUNT_COLUMNS.map(() => 0) };
      if (area !== undefined) areas.set(headingAnchor(heading), area);
    } else if (inSummary && raw.startsWith("|")) {
      rows.push({
        line,
        cells: raw
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      });
    } else if (raw.startsWith("### ") && area !== undefined) {
      closeEntry();
      entry = { line, title: raw.slice(4).trim(), statuses: 0 };
      area.counts[0] = (area.counts[0] ?? 0) + 1;
    } else if (raw.startsWith(STATUS_PREFIX) && entry !== undefined && area !== undefined) {
      entry.statuses += 1;
      const rest = raw.slice(STATUS_PREFIX.length);
      const status = STATUSES.findIndex((candidate: Status) => rest.startsWith(candidate));
      if (status === -1) {
        problems.push({
          line,
          reason: `the status of "${entry.title}" begins with none of ${STATUSES.join(" | ")}`,
        });
      } else {
        area.counts[status + 1] = (area.counts[status + 1] ?? 0) + 1;
      }
    }
  });
  closeEntry();

  const compare = (
    line: number,
    name: string,
    cells: ReadonlyArray<string>,
    counted: ReadonlyArray<number>,
  ) => {
    COUNT_COLUMNS.forEach((column, at) => {
      const claimed = Number((cells[at + 1] ?? "").replaceAll("*", ""));
      if (claimed !== (counted[at] ?? 0)) {
        problems.push({
          line,
          reason: `the summary row for ${name} claims ${cells[at + 1] ?? "nothing"} under "${column}"; the entries count ${counted[at] ?? 0}`,
        });
      }
    });
  };

  const seen = new Set<string>();
  // The first two table lines are the column names and the separator.
  for (const row of rows.slice(2)) {
    const link = /^\[[^\]]*\]\(#([^)]*)\)$/.exec(row.cells[0] ?? "");
    if (link === null) {
      const totals = COUNT_COLUMNS.map((_, at) =>
        [...areas.values()].reduce((sum, each) => sum + (each.counts[at] ?? 0), 0),
      );
      compare(row.line, "all areas", row.cells, totals);
      continue;
    }
    const anchor = link[1] ?? "";
    const target = areas.get(anchor);
    if (target === undefined) {
      problems.push({
        line: row.line,
        reason: `the summary links to #${anchor}, which no area heading has`,
      });
    } else if (seen.has(anchor)) {
      problems.push({ line: row.line, reason: `the summary has more than one row for #${anchor}` });
    } else {
      seen.add(anchor);
      compare(row.line, `"${target.heading}"`, row.cells, target.counts);
    }
  }
  for (const [anchor, each] of areas) {
    if (!seen.has(anchor)) {
      problems.push({
        line: rows[0]?.line ?? 1,
        reason: `the summary has no row for the area "${each.heading}"`,
      });
    }
  }

  if (problems.length > 0) {
    return { status: "inconsistent", problems: problems.toSorted((a, b) => a.line - b.line) };
  }
  return {
    status: "consistent",
    entries: [...areas.values()].reduce((sum, each) => sum + (each.counts[0] ?? 0), 0),
  };
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const path = process.argv[2] ?? resolve(root, REGISTER_PATH);
  const check = checkDecisionsRegister(await readFile(path, "utf8"));
  if (check.status === "consistent") {
    console.log(`Decisions register is consistent: ${check.entries} entries.`);
    return;
  }
  for (const problem of check.problems) {
    console.error(`${REGISTER_PATH}:${problem.line}: ${problem.reason}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();

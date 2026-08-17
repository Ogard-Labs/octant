import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decision record gate.
 *
 * `AGENTS.md` ranks decision records above tests and current code, and tells an
 * agent to read the record that owns the area it is changing. Prose alone cannot
 * hold that: an agent that never opens `docs/decisions/` produces a green pull
 * request, and a record whose status or title drifts out of the index is read as
 * settled when it is not. Nothing else in `bun run verify` looks at these files.
 *
 * This gate enforces the hygiene that makes the records trustworthy enough to
 * rank that highly, whichever agent or person wrote the change.
 *
 * Rule A: a record's heading number matches its filename.
 * Rule B: a record declares a status the conventions allow, and a superseding
 *         number resolves to a later record that exists.
 * Rule C: a record carries the required sections.
 * Rule D: the index and the records agree on number, title, and status, and
 *         names each number once.
 * Rule E: every record `AGENTS.md` routes to exists, including the numbers a
 *         written range only implies.
 * Rule F: every Markdown file in the directory is either the index or a record
 *         named the way the conventions require, and the numbers run without
 *         gaps.
 *
 * It cannot enforce that an agent read the record it was routed to. That stays a
 * review question; the gate's job is to make sure the record it would read says
 * what the index claims it says.
 */

export interface ScannedFile {
  readonly path: string;
  readonly content: string;
}

export interface DecisionViolation {
  readonly path: string;
  readonly reason: string;
}

const DECISIONS_DIRECTORY = "docs/decisions";
const INDEX_PATH = `${DECISIONS_DIRECTORY}/README.md`;
const CONTRACT_PATH = "AGENTS.md";
const REQUIRED_SECTIONS = ["## Context", "## Decision", "## Consequences"] as const;
const SIMPLE_STATUSES = new Set(["Proposed", "Accepted", "Deprecated"]);

interface DecisionRecord {
  readonly path: string;
  readonly number: string;
  readonly heading: string | undefined;
  readonly title: string | undefined;
  readonly status: string | undefined;
  readonly statusDeclarations: number;
  readonly content: string;
}

interface IndexRow {
  readonly number: string;
  readonly target: string;
  readonly title: string;
  readonly status: string;
}

export function findDecisionViolations(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<DecisionViolation> {
  const records = collectRecords(files);
  const numbers = new Set(records.map((record) => record.number));
  return [
    ...findMisnamedFiles(files),
    ...findNumberingGaps(records),
    ...findMalformedRecords(records, numbers),
    ...findIndexDisagreements(
      records,
      files.find((file) => file.path === INDEX_PATH),
    ),
    ...findUnroutableReferences(
      numbers,
      files.find((file) => file.path === CONTRACT_PATH),
    ),
  ];
}

/**
 * Rule F, first half: a Markdown file in the directory is the index or a record.
 *
 * Without this the gate is weakest exactly where it is needed most. A file named
 * `0019-new_feature.md` is invisible to every other rule, so the coupled mistake
 * this gate exists to catch — a record added without its index row — passes.
 */
function findMisnamedFiles(files: ReadonlyArray<ScannedFile>): ReadonlyArray<DecisionViolation> {
  return files
    .filter(
      (file) =>
        file.path.startsWith(`${DECISIONS_DIRECTORY}/`) &&
        file.path.endsWith(".md") &&
        file.path !== INDEX_PATH &&
        !/^docs\/decisions\/\d{4}-[a-z0-9-]+\.md$/.test(file.path),
    )
    .map((file) => ({
      path: file.path,
      reason: "is not named `00NN-short-slug.md`, so no rule here can see it",
    }));
}

/**
 * Rule F, second half: the numbers run without gaps.
 *
 * "Take the next number" is only checkable against what the next number is. A
 * skipped number reads as a record someone deleted rather than one never
 * written, which is the ambiguity this removes.
 */
function findNumberingGaps(
  records: ReadonlyArray<DecisionRecord>,
): ReadonlyArray<DecisionViolation> {
  const present = new Set(records.map((record) => Number(record.number)));
  const highest = Math.max(0, ...present);
  const missing: string[] = [];
  for (let number = 1; number <= highest; number += 1) {
    if (!present.has(number)) missing.push(String(number).padStart(4, "0"));
  }
  return missing.length === 0
    ? []
    : [
        {
          path: DECISIONS_DIRECTORY,
          reason: `numbering skips ${missing.join(", ")} before reaching ${String(highest).padStart(4, "0")}`,
        },
      ];
}

function collectRecords(files: ReadonlyArray<ScannedFile>): ReadonlyArray<DecisionRecord> {
  return files.flatMap((file): ReadonlyArray<DecisionRecord> => {
    const named = /^docs\/decisions\/(\d{4})-[a-z0-9-]+\.md$/.exec(file.path);
    if (named === null) return [];
    const heading = /^# (\d{4})\. (.+)$/m.exec(file.content);
    const statuses = [...file.content.matchAll(/^\*\*Status:\*\* (.+)$/gm)];
    const status = statuses[0];
    return [
      {
        path: file.path,
        number: named[1] ?? "",
        heading: heading?.[1],
        title: heading?.[2]?.trim(),
        status: status?.[1]?.trim(),
        statusDeclarations: statuses.length,
        content: file.content,
      },
    ];
  });
}

/** Rules A, B, and C: each record is readable on its own terms. */
function findMalformedRecords(
  records: ReadonlyArray<DecisionRecord>,
  numbers: ReadonlySet<string>,
): ReadonlyArray<DecisionViolation> {
  return records.flatMap((record): ReadonlyArray<DecisionViolation> => {
    const violations: Array<DecisionViolation> = [];
    if (record.heading === undefined) {
      violations.push({ path: record.path, reason: "no `# 00NN. Title` heading" });
    } else if (record.heading !== record.number) {
      violations.push({
        path: record.path,
        reason: `heading is numbered ${record.heading} but the filename says ${record.number}`,
      });
    }
    const status = record.status;
    if (status === undefined) {
      violations.push({ path: record.path, reason: "no `**Status:**` line" });
    } else if (record.statusDeclarations > 1) {
      // Only the first line is read, so a stale `Proposed` above a later
      // `Accepted` passes while the record shows a reader two lifecycles at
      // once — and status is what decides whether it may be revised in place.
      violations.push({
        path: record.path,
        reason: `declares a status ${String(record.statusDeclarations)} times`,
      });
    } else if (!SIMPLE_STATUSES.has(status)) {
      const superseded = /^Superseded by (\d{4})$/.exec(status);
      if (superseded === null) {
        violations.push({
          path: record.path,
          reason: `status \`${status}\` is not Proposed, Accepted, Deprecated, or Superseded by 00NN`,
        });
      } else if (!numbers.has(superseded[1] ?? "")) {
        violations.push({
          path: record.path,
          reason: `superseded by ${superseded[1]}, which does not exist`,
        });
      } else if (Number(superseded[1]) <= Number(record.number)) {
        // Supersession names the record that replaced this decision, so it
        // always points forward. Itself or an earlier record identifies nothing,
        // and a pair pointing at each other leaves no live decision at all.
        violations.push({
          path: record.path,
          reason: `superseded by ${superseded[1]}, which is not a later record`,
        });
      }
    }
    for (const section of REQUIRED_SECTIONS) {
      if (!record.content.includes(`\n${section}\n`)) {
        violations.push({ path: record.path, reason: `no \`${section}\` section` });
      }
    }
    return violations;
  });
}

/** Rule D: a reader who trusts the index reads the same thing the record says. */
function findIndexDisagreements(
  records: ReadonlyArray<DecisionRecord>,
  index: ScannedFile | undefined,
): ReadonlyArray<DecisionViolation> {
  if (index === undefined) return [{ path: INDEX_PATH, reason: "the decision index is missing" }];
  const parsed = parseIndexRows(index.content);
  const violations: Array<DecisionViolation> = [];
  // Collapsing the rows into a map keeps only the last of a repeated number, so
  // a duplicate whose title or status has drifted would agree with the record by
  // being discarded. Say so before the map hides it.
  const seen = new Set<string>();
  for (const row of parsed) {
    if (seen.has(row.number)) {
      violations.push({ path: INDEX_PATH, reason: `${row.number} is indexed more than once` });
    }
    seen.add(row.number);
  }
  const rows = new Map(parsed.map((row) => [row.number, row]));
  for (const record of records) {
    const row = rows.get(record.number);
    if (row === undefined) {
      violations.push({ path: INDEX_PATH, reason: `${record.number} is missing from the index` });
      continue;
    }
    rows.delete(record.number);
    const expectedTarget = record.path.slice(DECISIONS_DIRECTORY.length + 1);
    if (row.target !== expectedTarget) {
      violations.push({
        path: INDEX_PATH,
        reason: `${record.number} links to ${row.target} but the record is ${expectedTarget}`,
      });
    }
    if (record.title !== undefined && row.title !== record.title) {
      violations.push({
        path: INDEX_PATH,
        reason: `${record.number} is titled "${row.title}" in the index but "${record.title}" in the record`,
      });
    }
    if (record.status !== undefined && row.status !== record.status) {
      violations.push({
        path: INDEX_PATH,
        reason: `${record.number} is ${row.status} in the index but ${record.status} in the record`,
      });
    }
  }
  for (const number of rows.keys()) {
    violations.push({ path: INDEX_PATH, reason: `${number} is indexed but has no record` });
  }
  return violations;
}

function parseIndexRows(content: string): ReadonlyArray<IndexRow> {
  return content.split("\n").flatMap((line): ReadonlyArray<IndexRow> => {
    const cells = /^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|([^|]+)\|([^|]+)\|\s*$/.exec(line);
    if (cells === null) return [];
    return [
      {
        number: cells[1] ?? "",
        target: (cells[2] ?? "").trim(),
        title: (cells[3] ?? "").trim(),
        status: (cells[4] ?? "").trim(),
      },
    ];
  });
}

/** Rule E: the contract never routes an agent to a record that is not there. */
function findUnroutableReferences(
  numbers: ReadonlySet<string>,
  contract: ScannedFile | undefined,
): ReadonlyArray<DecisionViolation> {
  if (contract === undefined) return [];
  const referenced = new Set(
    [...contract.content.matchAll(/docs\/decisions\/(\d{4})/g)].map((match) => match[1] ?? ""),
  );
  // A written range routes an agent to every record between its ends, so those
  // are references too. Checking only the two written numbers would let the
  // middle of a range be deleted without the gate noticing.
  for (const range of contract.content.matchAll(
    /docs\/decisions\/(\d{4})`?\s*[–—-]\s*`?docs\/decisions\/(\d{4})/g,
  )) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    for (let number = from + 1; number < to; number += 1) {
      referenced.add(String(number).padStart(4, "0"));
    }
  }
  return [...referenced]
    .filter((number) => !numbers.has(number))
    .map((number) => ({
      path: CONTRACT_PATH,
      reason: `routes to decision record ${number}, which does not exist`,
    }));
}

async function collectFiles(root: string): Promise<ReadonlyArray<ScannedFile>> {
  const names = await readdir(resolve(root, DECISIONS_DIRECTORY));
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".md"))
      .map(async (name): Promise<ScannedFile> => {
        const absolutePath = resolve(root, DECISIONS_DIRECTORY, name);
        return {
          path: relative(root, absolutePath).split("\\").join("/"),
          content: await readFile(absolutePath, "utf8"),
        };
      }),
  );
  return [
    ...records,
    { path: CONTRACT_PATH, content: await readFile(resolve(root, CONTRACT_PATH), "utf8") },
  ];
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const violations = findDecisionViolations(await collectFiles(root));
  if (violations.length === 0) return;
  for (const violation of violations) {
    console.error(`${violation.path}: ${violation.reason}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();

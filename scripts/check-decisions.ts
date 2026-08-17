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
 *         number resolves to a record that exists.
 * Rule C: a record carries the required sections.
 * Rule D: the index and the records agree on number, title, and status.
 * Rule E: every record `AGENTS.md` routes to exists.
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

function collectRecords(files: ReadonlyArray<ScannedFile>): ReadonlyArray<DecisionRecord> {
  return files.flatMap((file): ReadonlyArray<DecisionRecord> => {
    const named = /^docs\/decisions\/(\d{4})-[a-z0-9-]+\.md$/.exec(file.path);
    if (named === null) return [];
    const heading = /^# (\d{4})\. (.+)$/m.exec(file.content);
    const status = /^\*\*Status:\*\* (.+)$/m.exec(file.content);
    return [
      {
        path: file.path,
        number: named[1] ?? "",
        heading: heading?.[1],
        title: heading?.[2]?.trim(),
        status: status?.[1]?.trim(),
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
  const rows = new Map(parseIndexRows(index.content).map((row) => [row.number, row]));
  const violations: Array<DecisionViolation> = [];
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

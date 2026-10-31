import { access, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decision record gate.
 *
 * Current specifications own implementation rules, and the decisions overview
 * (`docs/design/decisions.md`) lists them. The archive under
 * `docs/legacy/decisions/` is history with no authority. This gate keeps the
 * archive closed and internally consistent, and keeps current documents from
 * citing it. It does not compare code or specifications with historical
 * decisions and cannot establish design compliance.
 *
 * Rule A: a record's heading number matches its filename.
 * Rule B: a record declares a status the conventions allow, and a superseding
 *         number resolves to a later record that exists.
 * Rule C: a record carries the required sections.
 * Rule D: the index and the records agree on number, title, and status, and
 *         names each number once.
 * Rule E: current documents never cite a record. A rule still in force is
 *         stated in its owning specification; a link back into the archive
 *         would make history look like authority again (maintainer decision,
 *         2026-10-31).
 * Rule F: every Markdown file in the directory is either the index or a record
 *         named the way the conventions require, and the numbers run without
 *         gaps.
 * Rule H: the archive is closed. A record numbered outside 0001 to the last
 *         archived one is refused; its rule belongs in the owning specification.
 * Rule I: nothing is written to the archive's former location, `docs/decisions/`.
 *         A branch cut before the move would otherwise add a record there that
 *         every rule above, reading only the legacy folder, would miss.
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

const DECISIONS_DIRECTORY = "docs/legacy/decisions";
const FORMER_DECISIONS_DIRECTORY = "docs/decisions";
const LEGACY_DIRECTORY = "docs/legacy";
const INDEX_PATH = `${DECISIONS_DIRECTORY}/README.md`;
const RECORD_PATH = /^docs\/legacy\/decisions\/(\d{4})-[a-z0-9-]+\.md$/;
const ROOT_DOCUMENTS = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "PRODUCT.md",
  "README.md",
] as const;
const DOCS_DIRECTORY = "docs";
// A record cited by path (`decisions/0034`, `../legacy/decisions/0034-…`), or
// a link into the legacy folder other than its README, which says the folder
// is history. Naming the folder in prose, as the contributor rules do, is not
// a citation.
const ARCHIVE_CITATION = /decisions\/\d{4}|\]\([^)]*legacy\/(?!README\.md)[^)]*\)/;
const REQUIRED_SECTIONS = ["## Context", "## Decision", "## Consequences"] as const;
const SIMPLE_STATUSES = new Set(["Proposed", "Accepted", "Deprecated"]);
// New records kept landing after the specifications became the design authority,
// each restating a rule the specification already carried and then drifting from
// it (0161 still says Inter stays bundled after DESIGN.md removed it).
const LAST_ARCHIVED_RECORD = 164;

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
    ...findRecordsAfterClosure(records),
    ...findRecordsAtFormerLocation(files),
    ...findMalformedRecords(records, numbers),
    ...findIndexDisagreements(
      records,
      files.find((file) => file.path === INDEX_PATH),
    ),
    ...files
      .filter(
        (file) =>
          !file.path.startsWith(`${LEGACY_DIRECTORY}/`) &&
          !file.path.startsWith(`${FORMER_DECISIONS_DIRECTORY}/`),
      )
      .flatMap((file) => findArchiveCitations(file)),
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
        !RECORD_PATH.test(file.path),
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

/** Rule I: the archive's former folder stays empty. */
function findRecordsAtFormerLocation(
  files: ReadonlyArray<ScannedFile>,
): ReadonlyArray<DecisionViolation> {
  return files
    .filter((file) => file.path.startsWith(`${FORMER_DECISIONS_DIRECTORY}/`))
    .map((file) => ({
      path: file.path,
      reason: `the decision archive moved to ${DECISIONS_DIRECTORY} and is closed; put the rule and its rationale in the owning specification and the decisions overview`,
    }));
}

/** Rule H: nothing is added to the archive. */
function findRecordsAfterClosure(
  records: ReadonlyArray<DecisionRecord>,
): ReadonlyArray<DecisionViolation> {
  return records
    .filter((record) => {
      const number = Number(record.number);
      return number < 1 || number > LAST_ARCHIVED_RECORD;
    })
    .map((record) => ({
      path: record.path,
      reason: `the decision archive closed at ${String(LAST_ARCHIVED_RECORD).padStart(4, "0")} and holds only 0001 to that number; put the rule and its rationale in the owning specification`,
    }));
}

/**
 * The lines of a Markdown file with fenced blocks removed.
 *
 * These documents are allowed to show what a status line or an index row looks
 * like — the conventions are written down here, examples and all. A matcher
 * that reads the whole file cannot tell an example from the real declaration,
 * so it would reject documentation for doing exactly what it should.
 *
 * Exported because the history gate reads the same declarations from the same
 * documents. Two independent notions of "a real status line" would let a record
 * be Accepted to one gate and something else to the other.
 */
export function linesOutsideFences(content: string): ReadonlyArray<string> {
  const lines: Array<string> = [];
  // A fence closes only on its own marker, at least as long as the opener. A
  // four-backtick example holding a three-backtick snippet is how these
  // documents show a fenced record, and closing on the inner snippet would
  // read its sample status line as a real declaration.
  let open: { readonly marker: string; readonly length: number } | undefined;
  for (const line of content.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      const character = marker.slice(0, 1);
      if (open === undefined) {
        open = { marker: character, length: marker.length };
        continue;
      }
      if (character === open.marker && marker.length >= open.length) {
        open = undefined;
        continue;
      }
    }
    if (open === undefined) lines.push(line);
  }
  return lines;
}

function collectRecords(files: ReadonlyArray<ScannedFile>): ReadonlyArray<DecisionRecord> {
  return files.flatMap((file): ReadonlyArray<DecisionRecord> => {
    const named = RECORD_PATH.exec(file.path);
    if (named === null) return [];
    // Every check below reads the record outside its fenced examples, so a
    // record that documents the conventions is not judged by its own samples.
    const content = linesOutsideFences(file.content).join("\n");
    const heading = /^# (\d{4})\. (.+)$/m.exec(content);
    const statuses = [...content.matchAll(/^\*\*Status:\*\* (.+)$/gm)];
    const status = statuses[0];
    return [
      {
        path: file.path,
        number: named[1] ?? "",
        heading: heading?.[1],
        title: heading?.[2]?.trim(),
        status: status?.[1]?.trim(),
        statusDeclarations: statuses.length,
        content,
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

/** Only the `## Index` table is live index data; anything else is prose. */
function parseIndexRows(content: string): ReadonlyArray<IndexRow> {
  const rows: Array<IndexRow> = [];
  let indexed = false;
  for (const line of linesOutsideFences(content)) {
    if (/^##\s/.test(line)) {
      indexed = /^##\s+Index\s*$/.test(line);
      continue;
    }
    if (!indexed) continue;
    const cells = /^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|([^|]+)\|([^|]+)\|\s*$/.exec(line);
    if (cells === null) continue;
    rows.push({
      number: cells[1] ?? "",
      target: (cells[2] ?? "").trim(),
      title: (cells[3] ?? "").trim(),
      status: (cells[4] ?? "").trim(),
    });
  }
  return rows;
}

/** Rule E: a current document states its rules instead of citing the archive. */
function findArchiveCitations(document: ScannedFile): ReadonlyArray<DecisionViolation> {
  return linesOutsideFences(document.content).flatMap((line): ReadonlyArray<DecisionViolation> => {
    const citation = ARCHIVE_CITATION.exec(line);
    return citation === null
      ? []
      : [
          {
            path: document.path,
            reason: `cites the decision archive (\`${line.trim()}\`), which has no authority; state the rule or its reason in the owning specification`,
          },
        ];
  });
}

async function readScanned(root: string, path: string): Promise<ScannedFile> {
  return { path, content: await readFile(resolve(root, path), "utf8") };
}

async function markdownUnder(root: string, directory: string): Promise<ReadonlyArray<string>> {
  try {
    await access(resolve(root, directory));
  } catch {
    return [];
  }
  const names = await readdir(resolve(root, directory), { recursive: true });
  return names
    .filter((name) => name.endsWith(".md"))
    .map((name) =>
      relative(root, resolve(root, directory, name))
        .split("\\")
        .join("/"),
    );
}

async function collectFiles(root: string): Promise<ReadonlyArray<ScannedFile>> {
  const archived = await markdownUnder(root, DECISIONS_DIRECTORY);
  const former = await markdownUnder(root, FORMER_DECISIONS_DIRECTORY);
  const current = (await markdownUnder(root, DOCS_DIRECTORY)).filter(
    (path) => !path.startsWith(`${LEGACY_DIRECTORY}/`),
  );
  const paths = [...archived, ...former, ...ROOT_DOCUMENTS, ...current];
  return Promise.all(paths.map((path) => readScanned(root, path)));
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

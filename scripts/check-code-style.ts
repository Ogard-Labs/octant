import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Enforces the code-style rules in AGENTS.md that no formatter or default lint
 * rule expresses: no `any`, no non-null `!`, no `as unknown as`, and no tracker
 * identifiers in shipped code.
 *
 * `any` and `!` are found by oxlint's own rules, run here rather than in
 * `.oxlintrc.json` because oxlint has no baseline: turning them on there would
 * fail `bun run lint` on the code that predates the rule. Those two and
 * `as unknown as` ratchet against `scripts/code-style-baseline.json`: a file may
 * not add a finding, and a fix must lower the recorded count so the baseline
 * never overstates. Tracker identifiers are never baselined.
 */

export const BASELINE_PATH = "scripts/code-style-baseline.json";

export type CodeStyleRule = "explicit-any" | "non-null-assertion" | "as-unknown-as" | "tracker-id";

export interface CodeStyleFinding {
  readonly rule: CodeStyleRule;
  readonly file: string;
  readonly line: number;
}

export type CodeStyleBaseline = Readonly<
  Partial<Record<CodeStyleRule, Readonly<Record<string, number>>>>
>;

const RATCHETED_RULES: ReadonlyArray<CodeStyleRule> = [
  "explicit-any",
  "non-null-assertion",
  "as-unknown-as",
];

const OXLINT_RULES: Readonly<Record<string, CodeStyleRule>> = {
  "typescript(no-explicit-any)": "explicit-any",
  "typescript(no-non-null-assertion)": "non-null-assertion",
};

/** Planning ids belong in Linear and the PR, not in code (AGENTS.md). Public
 * examples such as a Linear integration's `ENG-12` are other teams' keys. */
const TRACKER_ID = /\b(?:OCT|BOOT)-\d+\b/g;
const AS_UNKNOWN_AS = /\bas\s+unknown\s+as\b/g;

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/;

/**
 * Code that ships: TypeScript under `apps/` and `packages/`, without tests and
 * the scaffolding that exists only to be imported by tests (the same shapes
 * `check-module-wiring.ts` treats as test scaffolding).
 */
export function isShippedSource(path: string): boolean {
  if (!/^(?:apps|packages)\//.test(path) || !SOURCE_EXTENSION.test(path)) return false;
  if (/(?:^|\/)node_modules\/|(?:^|\/)dist\//.test(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/\.(?:test|spec|smoke)\.(?:ts|tsx)$/.test(path)) return false;
  if (/\.test-[\w-]+\.(?:ts|tsx)$/.test(path)) return false;
  if (/\.integration-fixture\.(?:ts|tsx)$/.test(path)) return false;
  if (/(?:^|\/)(?:__fixtures__|fixtures)\//.test(path)) return false;
  if (/[Ff]ixtures?\.(?:ts|tsx)$/.test(path)) return false;
  if (/[Tt]est(?:Fixtures|Helpers|Model|Support)\.(?:ts|tsx)$/.test(path)) return false;
  if (/(?:^|\/)fake[A-Z][^/]*\.(?:ts|tsx)$/.test(path)) return false;
  if (/(?:^|\/)testSetup\.(?:ts|tsx)$/.test(path)) return false;
  return true;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The two rules a pattern can express exactly. */
export function findTextFindings(
  files: Readonly<Record<string, string>>,
): ReadonlyArray<CodeStyleFinding> {
  const findings: CodeStyleFinding[] = [];
  for (const [file, source] of Object.entries(files)) {
    for (const match of source.matchAll(AS_UNKNOWN_AS)) {
      findings.push({ rule: "as-unknown-as", file, line: lineAt(source, match.index) });
    }
    for (const match of source.matchAll(TRACKER_ID)) {
      findings.push({ rule: "tracker-id", file, line: lineAt(source, match.index) });
    }
  }
  return findings;
}

interface OxlintReport {
  readonly diagnostics: ReadonlyArray<{
    readonly code?: string;
    readonly filename: string;
    readonly labels?: ReadonlyArray<{ readonly span: { readonly line: number } }>;
  }>;
}

/** oxlint's JSON report, reduced to the rules this check owns. */
export function findOxlintFindings(report: OxlintReport): ReadonlyArray<CodeStyleFinding> {
  const findings: CodeStyleFinding[] = [];
  for (const diagnostic of report.diagnostics) {
    const rule = diagnostic.code === undefined ? undefined : OXLINT_RULES[diagnostic.code];
    if (rule === undefined) continue;
    findings.push({
      rule,
      file: diagnostic.filename,
      line: diagnostic.labels?.[0]?.span.line ?? 0,
    });
  }
  return findings;
}

export function countFindings(
  findings: ReadonlyArray<CodeStyleFinding>,
): Record<CodeStyleRule, Record<string, number>> {
  const counts: Record<CodeStyleRule, Record<string, number>> = {
    "explicit-any": {},
    "non-null-assertion": {},
    "as-unknown-as": {},
    "tracker-id": {},
  };
  for (const finding of findings) {
    const byFile = counts[finding.rule];
    byFile[finding.file] = (byFile[finding.file] ?? 0) + 1;
  }
  return counts;
}

export interface BaselineProblem {
  readonly kind: "exceeded" | "stale";
  readonly rule: CodeStyleRule;
  readonly file: string;
  readonly recorded: number;
  readonly current: number;
}

export function compareWithBaseline(
  findings: ReadonlyArray<CodeStyleFinding>,
  baseline: CodeStyleBaseline,
): ReadonlyArray<BaselineProblem> {
  const counts = countFindings(findings);
  const problems: BaselineProblem[] = [];
  for (const file of Object.keys(counts["tracker-id"]).sort()) {
    const current = counts["tracker-id"][file] ?? 0;
    problems.push({ kind: "exceeded", rule: "tracker-id", file, recorded: 0, current });
  }
  for (const rule of RATCHETED_RULES) {
    const recorded = baseline[rule] ?? {};
    const files = new Set([...Object.keys(recorded), ...Object.keys(counts[rule])]);
    for (const file of [...files].sort()) {
      const before = recorded[file] ?? 0;
      const current = counts[rule][file] ?? 0;
      if (current > before) {
        problems.push({ kind: "exceeded", rule, file, recorded: before, current });
      } else if (current < before) {
        problems.push({ kind: "stale", rule, file, recorded: before, current });
      }
    }
  }
  return problems;
}

export function serializeBaseline(findings: ReadonlyArray<CodeStyleFinding>): string {
  const counts = countFindings(findings);
  const baseline: Record<string, Record<string, number>> = {};
  for (const rule of RATCHETED_RULES) {
    const byFile = counts[rule];
    const files = Object.keys(byFile).sort();
    if (files.length === 0) continue;
    baseline[rule] = Object.fromEntries(files.map((file) => [file, byFile[file] ?? 0]));
  }
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

const REMEDY: Readonly<Record<CodeStyleRule, string>> = {
  "explicit-any":
    "model the value with a real type or `unknown` and narrow it (AGENTS.md: no `any`)",
  "non-null-assertion":
    "handle the missing case or narrow with a check instead of `!` (AGENTS.md: no non-null `!`)",
  "as-unknown-as":
    "decode or narrow the value instead of laundering it through `unknown` (AGENTS.md: `as` never invents a value)",
  "tracker-id":
    "remove the tracker identifier; say what the rule means instead (AGENTS.md: tracker ids stay in Linear)",
};

function shippedFiles(root: string): ReadonlyArray<string> {
  const listed = spawnSync("git", ["ls-files", "-z", "apps", "packages"], {
    cwd: root,
    encoding: "utf8",
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split("\0").filter(isShippedSource).sort();
}

function runOxlint(root: string, files: ReadonlyArray<string>): OxlintReport {
  const result = spawnSync(
    resolve(root, "node_modules/.bin/oxlint"),
    [
      "-A",
      "all",
      "-D",
      "typescript/no-explicit-any",
      "-D",
      "typescript/no-non-null-assertion",
      "--format",
      "json",
      ...files,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error !== undefined) throw result.error;
  // oxlint exits non-zero whenever it reports a finding; only unreadable output is a failure.
  return JSON.parse(result.stdout) as OxlintReport;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const files = shippedFiles(root);
  const sources: Record<string, string> = {};
  for (const file of files) sources[file] = await readFile(resolve(root, file), "utf8");
  const findings = [...findOxlintFindings(runOxlint(root, files)), ...findTextFindings(sources)];
  const baselineFile = resolve(root, BASELINE_PATH);

  if (process.argv.includes("--write-baseline")) {
    await writeFile(baselineFile, serializeBaseline(findings));
    console.log(`Wrote ${BASELINE_PATH}.`);
    return;
  }

  const baseline = JSON.parse(await readFile(baselineFile, "utf8")) as CodeStyleBaseline;
  const problems = compareWithBaseline(findings, baseline);
  if (problems.length === 0) {
    console.log(
      `Shipped code holds the AGENTS.md code-style contract (${String(files.length)} files).`,
    );
    return;
  }

  for (const problem of problems) {
    if (problem.kind === "stale") {
      console.error(
        `${problem.file}: ${problem.rule} fell from ${String(problem.recorded)} to ${String(problem.current)}; run \`bun scripts/check-code-style.ts --write-baseline\` to record the improvement.`,
      );
      continue;
    }
    console.error(
      `${problem.file}: ${problem.rule} rose from ${String(problem.recorded)} to ${String(problem.current)}; ${REMEDY[problem.rule]}:`,
    );
    for (const finding of findings) {
      if (finding.rule === problem.rule && finding.file === problem.file) {
        console.error(`  ${finding.file}:${String(finding.line)}`);
      }
    }
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { linesOutsideFences } from "./check-decisions";

/**
 * Decision record history gate.
 *
 * `check-decisions.ts` is a pure function over the current tree, which is what
 * makes it cheap and testable — and also what leaves this hole: it can only ask
 * whether today's records are internally consistent, never whether a number
 * still holds the record it held. Delete `0001-plugin-architecture.md`, add a
 * well-formed `0001-replacement.md`, fix the index row, and every rule there
 * passes. The number set is still contiguous, the record is still well formed,
 * and the index still agrees. An `Accepted` decision has been rewritten in
 * place, which `docs/decisions/README.md` says never happens.
 *
 * Answering that needs the repository, not the tree, so it lives here rather
 * than widening `findDecisionViolations` into something that reads git.
 *
 * Rule G: a number that held an `Accepted` record still holds that record.
 *
 * The record may be renamed, and it may be retired by declaring a supersession
 * that resolves. It may not quietly become a different document, move to another
 * number, or disappear.
 *
 * A gate that reads history can only be as good as the history it is given, and
 * the common CI checkout is a depth-1 clone that has none. Answering from a
 * clone that cannot answer would mean either inventing a base or reporting
 * violations from a truncated one, so this skips with a stated reason and a
 * clean exit instead. A skipped check that says so is recoverable; a check that
 * blocks every shallow clone gets deleted.
 */

export interface RecordIdentity {
  readonly number: string;
  readonly path: string;
  readonly title: string | undefined;
  readonly status: string | undefined;
}

/** One `old -> new` pair as git's own similarity detection saw it. */
export interface RecordRename {
  readonly from: string;
  readonly to: string;
}

export interface HistoryViolation {
  readonly path: string;
  readonly reason: string;
}

export interface RepositoryState {
  readonly isRepository: boolean;
  readonly isShallow: boolean;
  readonly hasCommits: boolean;
  /** Base candidates in preference order, each with the merge base it resolved to. */
  readonly candidates: ReadonlyArray<{
    readonly ref: string;
    readonly mergeBase: string | undefined;
  }>;
}

export type BaseResolution =
  | { readonly status: "resolved"; readonly ref: string; readonly commit: string }
  | { readonly status: "unanswerable"; readonly reason: string };

export type HistoryCheck =
  | {
      readonly status: "checked";
      readonly base: string;
      readonly violations: ReadonlyArray<HistoryViolation>;
    }
  | { readonly status: "skipped"; readonly reason: string };

const DECISIONS_DIRECTORY = "docs/decisions";
const RECORD_PATH = /^docs\/decisions\/(\d{4})-[a-z0-9-]+\.md$/;
const BASE_OVERRIDE = "OCTANT_DECISIONS_BASE";
const DEFAULT_BASE_REFS = ["origin/main", "main"] as const;

/**
 * Git's default similarity threshold, named rather than left implicit.
 *
 * Records share a skeleton — a heading, a status line, and three fixed section
 * titles — so two unrelated records score far below this, while a record whose
 * slug or title was tidied scores far above it. Anything git calls a rename here
 * is the same document under a new name.
 */
const RENAME_SIMILARITY = "50%";

/**
 * Which commit to compare against, or why no honest comparison is available.
 *
 * The order matters. A shallow clone is rejected before any candidate is
 * considered because `git merge-base` on grafted history answers from the
 * commits it happens to have, which is a plausible wrong answer rather than a
 * refusal — the one failure mode worse than skipping.
 */
export function resolveBase(state: RepositoryState): BaseResolution {
  if (!state.isRepository) {
    return { status: "unanswerable", reason: "this is not a git repository" };
  }
  if (!state.hasCommits) {
    return { status: "unanswerable", reason: "this repository has no commits yet" };
  }
  if (state.isShallow) {
    return {
      status: "unanswerable",
      reason:
        "this clone is shallow, so it cannot say what a decision number held before; fetch full history (`fetch-depth: 0`) to run this check",
    };
  }
  const resolved = state.candidates.find((candidate) => candidate.mergeBase !== undefined);
  if (resolved?.mergeBase === undefined) {
    const tried = state.candidates.map((candidate) => candidate.ref).join(", ");
    return {
      status: "unanswerable",
      reason: `no base commit to compare against; tried ${tried || "nothing"}. Set ${BASE_OVERRIDE} to name one`,
    };
  }
  return { status: "resolved", ref: resolved.ref, commit: resolved.mergeBase };
}

/**
 * Rule G, over the two record sets and git's view of what moved between them.
 *
 * Identity is the filename and the title together, because those are what a
 * reader uses to decide a number still means what the index says it means. A
 * changed identity is then read against the rename list: git already knows how
 * to tell a document that was renamed from one that was replaced, and it is
 * better at it than a comparison of titles would be.
 */
export function findHistoryViolations(
  base: ReadonlyArray<RecordIdentity>,
  head: ReadonlyArray<RecordIdentity>,
  renames: ReadonlyArray<RecordRename>,
): ReadonlyArray<HistoryViolation> {
  const current = new Map(head.map((record) => [record.number, record]));
  const numbers = new Set(head.map((record) => record.number));
  const movedTo = new Map(renames.map((rename) => [rename.from, rename.to]));
  return base
    .filter((record) => record.status === "Accepted")
    .flatMap((was): ReadonlyArray<HistoryViolation> => {
      const now = current.get(was.number);
      const moved = movedTo.get(was.path);
      if (now === undefined) {
        return [
          {
            path: was.path,
            reason:
              moved === undefined
                ? "was Accepted and is gone; an accepted record is superseded, never removed"
                : `was Accepted and became ${moved}; a record keeps its number for as long as it exists`,
          },
        ];
      }
      if (now.path === was.path && now.title === was.title) return [];
      if (moved === now.path) return [];
      if (supersedes(now, numbers)) return [];
      return [
        {
          path: now.path,
          reason: describeReplacement(was, now, moved),
        },
      ];
    });
}

/**
 * A record retiring in place, which is the one identity change the conventions
 * invite.
 *
 * Restating a decision as history reasonably rewrites it far enough that git
 * stops calling it the same document, so the supersession itself is the
 * evidence. It has to point somewhere real: `Superseded by 0042` with no 0042 is
 * how a replacement would dress itself up, and that is already a violation the
 * tree gate reports.
 */
function supersedes(record: RecordIdentity, numbers: ReadonlySet<string>): boolean {
  const superseded = /^Superseded by (\d{4})$/.exec(record.status ?? "");
  return superseded !== null && numbers.has(superseded[1] ?? "");
}

function describeReplacement(
  was: RecordIdentity,
  now: RecordIdentity,
  moved: string | undefined,
): string {
  const wasTitle = was.title ?? was.path;
  const nowTitle = now.title ?? now.path;
  if (moved !== undefined) {
    return `held "${wasTitle}", which became ${moved}; ${now.number} now holds "${nowTitle}" instead`;
  }
  if (now.path !== was.path) {
    return `held "${wasTitle}" in ${was.path} and now holds "${nowTitle}"; supersede the accepted record instead of replacing it, or stage the rename so git can see it is the same record`;
  }
  return `held "${wasTitle}" and now holds "${nowTitle}"; supersede the accepted record instead of retitling it`;
}

function identify(path: string, content: string): RecordIdentity | undefined {
  const named = RECORD_PATH.exec(path);
  if (named === null) return undefined;
  // Read past fenced examples exactly as the tree gate does, so a record that
  // documents the conventions is not identified by its own sample heading.
  const outside = linesOutsideFences(content).join("\n");
  return {
    number: named[1] ?? "",
    path,
    title: /^# \d{4}\. (.+)$/m.exec(outside)?.[1]?.trim(),
    status: /^\*\*Status:\*\* (.+)$/m.exec(outside)?.[1]?.trim(),
  };
}

function git(root: string, args: ReadonlyArray<string>): string | undefined {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.success ? result.stdout.toString() : undefined;
}

function readRepositoryState(root: string, requested: string | undefined): RepositoryState {
  const isRepository = git(root, ["rev-parse", "--git-dir"]) !== undefined;
  const refs = requested === undefined ? DEFAULT_BASE_REFS : [requested];
  return {
    isRepository,
    isShallow: git(root, ["rev-parse", "--is-shallow-repository"])?.trim() === "true",
    hasCommits: git(root, ["rev-parse", "--verify", "HEAD"]) !== undefined,
    candidates: refs.map((ref) => ({
      ref,
      mergeBase: git(root, ["merge-base", ref, "HEAD"])?.trim() || undefined,
    })),
  };
}

function readBaseRecords(root: string, commit: string): ReadonlyArray<RecordIdentity> {
  const listed = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    DECISIONS_DIRECTORY,
  ]);
  if (listed === undefined) return [];
  return listed
    .split("\0")
    .filter((path) => RECORD_PATH.test(path))
    .flatMap((path): ReadonlyArray<RecordIdentity> => {
      const content = git(root, ["show", `${commit}:${path}`]);
      if (content === undefined) return [];
      const identity = identify(path, content);
      return identity === undefined ? [] : [identity];
    });
}

/**
 * What git considers a rename between the base commit and the working tree.
 *
 * Comparing against the working tree rather than `HEAD` is deliberate: a record
 * swap is caught while it is still uncommitted, which is when `bun run verify`
 * runs. The cost is that an unstaged rename reads as a delete and an untracked
 * add, so the replacement message says how to make git see it.
 */
function readRenames(root: string, commit: string): ReadonlyArray<RecordRename> {
  const diff = git(root, [
    "diff",
    `--find-renames=${RENAME_SIMILARITY}`,
    "--name-status",
    "-z",
    commit,
    "--",
    DECISIONS_DIRECTORY,
  ]);
  if (diff === undefined) return [];
  // `-z` writes a rename as three fields (`R100`, old, new) and everything else
  // as two, so the record count is only knowable from the status field itself.
  const fields = diff.split("\0");
  const renames: Array<RecordRename> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (status === undefined || status === "") continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[index + 1];
      const to = fields[index + 2];
      if (from !== undefined && to !== undefined) renames.push({ from, to });
      index += 2;
      continue;
    }
    index += 1;
  }
  return renames;
}

async function readHeadRecords(root: string): Promise<ReadonlyArray<RecordIdentity>> {
  const names = await readdir(resolve(root, DECISIONS_DIRECTORY));
  const records = await Promise.all(
    names.map(async (name): Promise<ReadonlyArray<RecordIdentity>> => {
      const path = `${DECISIONS_DIRECTORY}/${name}`;
      if (!RECORD_PATH.test(path)) return [];
      const identity = identify(
        path,
        await readFile(resolve(root, DECISIONS_DIRECTORY, name), "utf8"),
      );
      return identity === undefined ? [] : [identity];
    }),
  );
  return records.flat();
}

export async function checkDecisionHistory(
  root: string,
  requested: string | undefined,
): Promise<HistoryCheck> {
  const base = resolveBase(readRepositoryState(root, requested));
  if (base.status === "unanswerable") return { status: "skipped", reason: base.reason };
  return {
    status: "checked",
    base: `${base.ref} (${base.commit.slice(0, 12)})`,
    violations: findHistoryViolations(
      readBaseRecords(root, base.commit),
      await readHeadRecords(root),
      readRenames(root, base.commit),
    ),
  };
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const result = await checkDecisionHistory(root, process.env[BASE_OVERRIDE]);
  if (result.status === "skipped") {
    console.log(`${DECISIONS_DIRECTORY}: skipped the history check — ${result.reason}`);
    return;
  }
  if (result.violations.length === 0) return;
  console.error(`Compared against ${result.base}.`);
  for (const violation of result.violations) {
    console.error(`${violation.path}: ${violation.reason}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) await main();

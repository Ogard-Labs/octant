import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
 * place, which the archive's README says never happens.
 *
 * Answering that needs the repository, not the tree, so it lives here rather
 * than widening `findDecisionViolations` into something that reads git.
 *
 * Rule G: the archive is closed, so a record present at the base commit is
 * still present at the same path with the same bytes. Wording, status, title,
 * and filename are all frozen; a rule that changes goes in its owning current
 * specification instead. Records added after the base are the tree gate's
 * business (Rule H there refuses them).
 *
 * The archive moved from `docs/decisions/` to `docs/legacy/decisions/` on
 * 2026-10-31. A base from before the move still names the old paths, so a
 * record is looked up by filename in the new folder. The move is the one change
 * a record may carry: a relative link that left the folder (`../`) may gain the
 * one `../` the deeper folder needs, and nothing else.
 *
 * A gate that reads history can only be as good as the history it is given, and
 * the common CI checkout is a depth-1 clone that has none. Answering from a
 * clone that cannot answer would mean either inventing a base or reporting
 * violations from a truncated one, so this skips with a stated reason and a
 * clean exit instead. A skipped check that says so is recoverable; a check that
 * blocks every shallow clone gets deleted.
 */

export interface ArchivedRecord {
  readonly path: string;
  readonly content: string;
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

const DECISIONS_DIRECTORY = "docs/legacy/decisions";
const FORMER_DECISIONS_DIRECTORY = "docs/decisions";
const RECORD_PATH = /^docs\/(?:legacy\/)?decisions\/(\d{4})-[a-z0-9-]+\.md$/;
const BASE_OVERRIDE = "OCTANT_DECISIONS_BASE";
const DEFAULT_BASE_REFS = ["origin/main", "main"] as const;

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
 * Rule G over the records at the base commit and what the working tree now
 * holds at each of their paths (`undefined` when the path is gone).
 */
export function findHistoryViolations(
  base: ReadonlyArray<ArchivedRecord>,
  readCurrent: (path: string) => string | undefined,
): ReadonlyArray<HistoryViolation> {
  return base.flatMap((was): ReadonlyArray<HistoryViolation> => {
    const path = currentArchivePath(was.path);
    const now = readCurrent(path);
    if (now === undefined) {
      return [
        {
          path,
          reason: "is gone; the decision archive is closed, so its records keep their paths",
        },
      ];
    }
    const moved = path !== was.path;
    if (now !== was.content && !(moved && now === rebaseOutwardLinks(was.content))) {
      return [
        {
          path,
          reason:
            "was edited; the decision archive is closed, so its records keep their wording and status. Change the owning specification instead",
        },
      ];
    }
    return [];
  });
}

/** Where a record at a base path lives now: the same filename in the legacy folder. */
export function currentArchivePath(path: string): string {
  const former = `${FORMER_DECISIONS_DIRECTORY}/`;
  return path.startsWith(former) ? `${DECISIONS_DIRECTORY}/${path.slice(former.length)}` : path;
}

/** A record's links out of its folder, one level deeper. */
export function rebaseOutwardLinks(content: string): string {
  return content.replaceAll("](../", "](../../");
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

function readBaseRecords(root: string, commit: string): ReadonlyArray<ArchivedRecord> {
  const listed = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    DECISIONS_DIRECTORY,
    FORMER_DECISIONS_DIRECTORY,
  ]);
  if (listed === undefined) return [];
  return listed
    .split("\0")
    .filter((path) => RECORD_PATH.test(path))
    .flatMap((path): ReadonlyArray<ArchivedRecord> => {
      const content = git(root, ["show", `${commit}:${path}`]);
      return content === undefined ? [] : [{ path, content }];
    });
}

/**
 * The working tree rather than `HEAD`, so an edit is caught while it is still
 * uncommitted, which is when `bun run verify` runs.
 */
async function readWorkingTree(
  root: string,
  base: ReadonlyArray<ArchivedRecord>,
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    base.map(async (record): Promise<ReadonlyArray<readonly [string, string]>> => {
      try {
        return [[record.path, await readFile(resolve(root, record.path), "utf8")]];
      } catch {
        return [];
      }
    }),
  );
  return new Map(entries.flat());
}

export async function checkDecisionHistory(
  root: string,
  requested: string | undefined,
): Promise<HistoryCheck> {
  const base = resolveBase(readRepositoryState(root, requested));
  if (base.status === "unanswerable") return { status: "skipped", reason: base.reason };
  const records = readBaseRecords(root, base.commit);
  const current = await readWorkingTree(
    root,
    records.map((record) => ({ ...record, path: currentArchivePath(record.path) })),
  );
  return {
    status: "checked",
    base: `${base.ref} (${base.commit.slice(0, 12)})`,
    violations: findHistoryViolations(records, (path) => current.get(path)),
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

import { createHash } from "node:crypto";

export type GitWorktreeLockState = true | string;

export interface ParsedGitWorktree {
  readonly reportedPath: string;
  readonly head: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly locked?: GitWorktreeLockState;
  readonly prunable?: true | string;
}

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function oneField(fields: readonly string[], prefix: string): string | undefined {
  const matches = fields.filter((field) => field === prefix || field.startsWith(`${prefix} `));
  if (matches.length > 1) throw new Error("invalid Git worktree inventory");
  const match = matches[0];
  if (match === undefined) return undefined;
  return match === prefix ? "" : match.slice(prefix.length + 1);
}

function marker(fields: readonly string[], name: string): boolean {
  const matches = fields.filter((field) => field === name);
  if (matches.length > 1) throw new Error("invalid Git worktree inventory");
  return matches.length === 1;
}

function reasonField(fields: readonly string[], name: string): true | string | undefined {
  const value = oneField(fields, name);
  if (value === undefined) return undefined;
  return value === "" ? true : value;
}

export interface FileSystemIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface RepositoryIdentityDependencies {
  readonly isMissingError: (error: unknown) => boolean;
  readonly realpath: (path: string) => Promise<string>;
  readonly statIdentity: (path: string) => Promise<FileSystemIdentity>;
  readonly runGit: (args: readonly string[], signal: AbortSignal) => Promise<GitCommandResult>;
}

export type ObservedGitWorktree =
  | Readonly<ParsedGitWorktree & { status: "present"; canonicalPath: string }>
  | Readonly<ParsedGitWorktree & { status: "missing-prunable" }>;

export type RepositoryIdentityObservation =
  | Readonly<{
      status: "available";
      repositoryId: `repo_${string}`;
      repositoryRoot: string;
      commonDirectory: string;
      objectDirectory: string;
      checkout: Extract<ObservedGitWorktree, { status: "present" }>;
      worktrees: readonly ObservedGitWorktree[];
    }>
  | Readonly<{ status: "unavailable"; reason: "root-missing-or-moved" | "not-repository" }>
  | Readonly<{ status: "ineligible"; reason: "bare" | "submodule" | "not-worktree" }>
  | Readonly<{ status: "failed" }>;

async function requireGit(
  run: (args: readonly string[]) => Promise<GitCommandResult>,
  args: readonly string[],
): Promise<string> {
  const result = await run(args);
  if (result.exitCode !== 0) throw new Error("Git repository observation failed");
  return result.stdout;
}

function opaqueRepositoryId(
  common: FileSystemIdentity,
  objects: FileSystemIdentity,
): `repo_${string}` {
  const digest = createHash("sha256")
    .update("octant.repository-identity.v1\0")
    .update(`${common.device}:${common.inode}`)
    .update("\0")
    .update(`${objects.device}:${objects.inode}`)
    .digest("hex");
  return `repo_${digest}`;
}

function isSubmoduleCommonDirectory(commonDirectory: string): boolean {
  return /(?:^|\/)\.git\/modules(?:\/|$)/.test(commonDirectory.replaceAll("\\", "/"));
}

export async function observeRepositoryIdentity(
  root: string,
  dependencies: RepositoryIdentityDependencies,
  signal: AbortSignal,
): Promise<RepositoryIdentityObservation> {
  let repositoryRoot: string;
  try {
    repositoryRoot = await dependencies.realpath(root);
  } catch (error) {
    return dependencies.isMissingError(error)
      ? { status: "unavailable", reason: "root-missing-or-moved" }
      : { status: "failed" };
  }
  try {
    const run = (args: readonly string[]) =>
      dependencies.runGit(["-C", repositoryRoot, ...args], signal);
    const repositoryProbe = await run(["rev-parse", "--is-bare-repository"]);
    if (repositoryProbe.exitCode !== 0) {
      return { status: "unavailable", reason: "not-repository" };
    }
    if (repositoryProbe.stdout.trim() === "true") {
      return { status: "ineligible", reason: "bare" };
    }
    const commonDirectory = await dependencies.realpath(
      (await requireGit(run, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
    );
    // `--show-superproject-working-tree` traverses above the selected root and
    // can block indefinitely when macOS grants access only to that folder.
    // Git stores submodule object databases under the superproject's
    // `.git/modules` tree, so the canonical common directory is sufficient to
    // reject submodules without escaping the user-authorized repository root.
    if (isSubmoduleCommonDirectory(commonDirectory)) {
      return { status: "ineligible", reason: "submodule" };
    }
    const objectDirectory = await dependencies.realpath(
      (
        await requireGit(run, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])
      ).trim(),
    );
    const parsed = parseWorktreePorcelain(
      await requireGit(run, ["worktree", "list", "--porcelain", "-z"]),
    );
    const worktrees: ObservedGitWorktree[] = [];
    for (const record of parsed) {
      try {
        worktrees.push({
          ...record,
          status: "present",
          canonicalPath: await dependencies.realpath(record.reportedPath),
        });
      } catch (error) {
        if (record.prunable === undefined || !dependencies.isMissingError(error)) {
          throw new Error("Git worktree path is unavailable");
        }
        worktrees.push({ ...record, status: "missing-prunable" });
      }
    }
    const checkout = worktrees.find(
      (entry): entry is Extract<ObservedGitWorktree, { status: "present" }> =>
        entry.status === "present" && entry.canonicalPath === repositoryRoot,
    );
    if (checkout === undefined) return { status: "ineligible", reason: "not-worktree" };
    const [commonIdentity, objectIdentity] = await Promise.all([
      dependencies.statIdentity(commonDirectory),
      dependencies.statIdentity(objectDirectory),
    ]);
    return {
      status: "available",
      repositoryId: opaqueRepositoryId(commonIdentity, objectIdentity),
      repositoryRoot,
      commonDirectory,
      objectDirectory,
      checkout,
      worktrees,
    };
  } catch {
    return { status: "failed" };
  }
}

export function parseWorktreePorcelain(value: string): readonly ParsedGitWorktree[] {
  if (value === "") throw new Error("invalid Git worktree inventory");
  const records: ParsedGitWorktree[] = [];
  for (const block of value.split("\0\0")) {
    if (block === "") continue;
    const fields = block.split("\0");
    const reportedPath = oneField(fields, "worktree");
    const head = oneField(fields, "HEAD");
    const branch = oneField(fields, "branch");
    const detached = marker(fields, "detached");
    const locked = reasonField(fields, "locked");
    const prunable = reasonField(fields, "prunable");
    if (
      reportedPath === undefined ||
      reportedPath === "" ||
      head === undefined ||
      !objectIdPattern.test(head) ||
      detached === (branch !== undefined) ||
      fields.some(
        (field) =>
          ![
            `worktree ${reportedPath}`,
            `HEAD ${head}`,
            ...(branch === undefined ? [] : [`branch ${branch}`]),
            ...(detached ? ["detached"] : []),
            ...(locked === undefined ? [] : [locked === true ? "locked" : `locked ${locked}`]),
            ...(prunable === undefined
              ? []
              : [prunable === true ? "prunable" : `prunable ${prunable}`]),
          ].includes(field),
      )
    ) {
      throw new Error("invalid Git worktree inventory");
    }
    records.push({
      reportedPath,
      head,
      ...(branch === undefined ? {} : { branch }),
      detached,
      ...(locked === undefined ? {} : { locked }),
      ...(prunable === undefined ? {} : { prunable }),
    });
  }
  if (records.length === 0) throw new Error("invalid Git worktree inventory");
  return records;
}

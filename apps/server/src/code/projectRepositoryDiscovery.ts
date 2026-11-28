import { execFile as nodeExecFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  decodeCodeCheckoutHead,
  decodeProjectRepositoriesList,
  MAX_DISCOVERED_PROJECT_REPOSITORIES,
  MAX_DISCOVERED_REPOSITORY_SUBMODULES,
  MAX_DISCOVERED_WORKSPACE_FOLDERS,
  type BindingRevisionId,
  type CodeCheckoutHead,
  type CodeCheckoutId,
  type CodeRepositoryId,
  type DiscoveredProjectRepository,
  type DiscoveredWorkspaceFolder,
  type ProjectId,
  type ProjectRepositoriesList,
  type ProjectRepositorySubmodule,
} from "@octant/contracts";
import { extraFolderRefusal, folderContainsPath } from "@octant/domain";
import { childProcessEnvironment } from "../childProcessEnvironment";
import type { ManagedWorktreeRepositoryPort } from "./managedWorktreeService";
import { deriveExistingWorktreeCheckoutId } from "./repositoryIdentity";

const execFileAsync = promisify(nodeExecFile);

/** Discovery walks at most two directory levels below each granted root. */
export const MAX_REPOSITORY_DISCOVERY_DEPTH = 2;

/** Maximum entries inspected per directory so huge directories stay bounded. */
const MAX_ENTRIES_PER_DIRECTORY = 256;

/** Maximum `.code-workspace` files read from a Project's main folder. */
const MAX_WORKSPACE_FILES = 8;

/** Maximum byte size of a single `.code-workspace` file read during discovery. */
const MAX_WORKSPACE_FILE_BYTES = 64 * 1024;

/** Maximum byte size of committed `HEAD:.gitmodules` read per repository. */
const MAX_GITMODULES_BYTES = 64 * 1024;

/** Timeout for reading committed `.gitmodules` via `git show`. */
const GITMODULES_TIMEOUT_MS = 2_000;

/** Common dependency and build directories skipped during repository discovery. */
const SKIPPED_DIRECTORY_NAMES = new Set<string>([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "out",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  "Carthage",
  "bower_components",
]);

export interface ProjectRepositoryDiscoveryInput {
  readonly projectId: ProjectId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly mainRoot: string;
  readonly extraFolders: ReadonlyArray<string>;
  readonly homeDirectory: string;
  readonly strict: boolean;
}

export interface ProjectRepositoryDiscoveryDependencies {
  readonly repository: Pick<ManagedWorktreeRepositoryPort, "observe">;
  readonly readGitModulesBlob?: (
    repositoryRoot: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
}

/**
 * Result of discovering Git repositories inside a Code Project's already-granted
 * folders (its main folder and approved extra folders) plus any folders named in
 * `.code-workspace` files in the main folder.
 *
 * Discovery is strictly read-only and grants no authority. Repositories inside
 * granted folders are already covered by those grants; folders outside the
 * Project named by a `.code-workspace` file are reported as data so the UI can
 * offer the existing extra-folder picker flow, judged by `extraFolderRefusal`.
 */
export async function discoverProjectRepositories(
  input: ProjectRepositoryDiscoveryInput,
  dependencies: ProjectRepositoryDiscoveryDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProjectRepositoriesList> {
  const readGitModules = dependencies.readGitModulesBlob ?? defaultReadGitModulesBlob;
  const repositories: DiscoveredProjectRepository[] = [];
  const seenCanonicalRoots = new Set<string>();
  const seenRepositoryIds = new Set<string>();
  let truncated = false;

  const grantedRoots: ReadonlyArray<{
    readonly path: string;
    readonly source: "main-folder" | "extra-folder";
  }> = [
    { path: input.mainRoot, source: "main-folder" },
    ...input.extraFolders.map((path) => ({ path, source: "extra-folder" as const })),
  ];

  const recordCandidate = async (
    candidatePath: string,
    source: "main-folder" | "nested" | "extra-folder",
    rootOrigin: string,
  ): Promise<boolean> => {
    if (signal.aborted) return false;
    if (repositories.length >= MAX_DISCOVERED_PROJECT_REPOSITORIES) {
      truncated = true;
      return false;
    }
    const observation = await dependencies.repository.observe(candidatePath, signal);
    if (observation.status !== "available") return false;
    if (
      observation.repositoryRoot !== candidatePath ||
      observation.checkout.canonicalPath !== candidatePath ||
      observation.checkout.locked !== undefined ||
      observation.checkout.prunable !== undefined
    ) {
      return false;
    }
    if (
      seenCanonicalRoots.has(observation.repositoryRoot) ||
      seenRepositoryIds.has(observation.repositoryId)
    ) {
      return true;
    }
    const head = checkoutHeadOf(observation.checkout);
    if (head === undefined) return false;

    const checkoutId = deriveExistingWorktreeCheckoutId({
      projectId: String(input.projectId),
      bindingRevisionId: String(input.bindingRevisionId),
      repositoryId: observation.repositoryId,
      canonicalRoot: observation.repositoryRoot,
    });
    const submodules = await discoverCommittedSubmodules(
      observation.repositoryRoot,
      readGitModules,
      signal,
    );
    seenCanonicalRoots.add(observation.repositoryRoot);
    seenRepositoryIds.add(observation.repositoryId);
    repositories.push({
      repositoryId: observation.repositoryId as CodeRepositoryId,
      checkoutId: checkoutId as CodeCheckoutId,
      name: repositoryDisplayName(observation.repositoryRoot, input.mainRoot, rootOrigin, source),
      canonicalRoot: observation.repositoryRoot,
      source,
      head,
      ...(submodules.length === 0 ? {} : { submodules }),
    });
    return true;
  };

  for (const granted of grantedRoots) {
    if (signal.aborted) break;
    const rootIsDir = await isRealDirectory(granted.path);
    if (!rootIsDir) continue;

    await walkDirectory(granted.path, 0, granted.source, granted.path);
    if (truncated) break;
  }

  async function walkDirectory(
    dirPath: string,
    depth: number,
    rootSource: "main-folder" | "extra-folder",
    rootOrigin: string,
  ): Promise<void> {
    if (signal.aborted) return;
    if (repositories.length >= MAX_DISCOVERED_PROJECT_REPOSITORIES) {
      truncated = true;
      return;
    }
    const marker = await inspectGitMarker(dirPath);
    if (marker === "linked-worktree" && depth > 0) {
      // Nested linked worktrees are skipped so discovery never treats a
      // secondary worktree checkout as an independent repository.
      return;
    }
    if (marker === "git-dir" || (marker === "linked-worktree" && depth === 0)) {
      const source =
        depth === 0 ? rootSource : rootSource === "extra-folder" ? "extra-folder" : "nested";
      const admitted = await recordCandidate(dirPath, source, rootOrigin);
      if (admitted) {
        // Do not recurse inside an admitted Git repository; its submodules are
        // read from committed `.gitmodules` instead.
        return;
      }
      // If `observe` rejected it (e.g., submodule or bare), skip recursing into it.
      if (marker === "git-dir" || marker === "linked-worktree") return;
    }
    if (marker === "submodule-or-symlink") return;

    if (depth >= MAX_REPOSITORY_DISCOVERY_DEPTH) return;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const bounded = entries.slice(0, MAX_ENTRIES_PER_DIRECTORY);
    for (const entry of bounded) {
      if (signal.aborted) return;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (shouldSkipDirectoryName(entry.name)) continue;
      const childPath = join(dirPath, entry.name);
      if (!(await isRealDirectory(childPath))) continue;
      if (repositories.length >= MAX_DISCOVERED_PROJECT_REPOSITORIES) {
        // Probe whether any more repositories exist before reporting truncated.
        const childMarker = await inspectGitMarker(childPath);
        if (childMarker === "git-dir") {
          const probe = await dependencies.repository.observe(childPath, signal);
          if (
            probe.status === "available" &&
            !seenCanonicalRoots.has(probe.repositoryRoot) &&
            !seenRepositoryIds.has(probe.repositoryId)
          ) {
            truncated = true;
            return;
          }
        }
        continue;
      }
      await walkDirectory(childPath, depth + 1, rootSource, rootOrigin);
    }
  }

  const workspaceFolders = await discoverCodeWorkspaceFolders({
    mainRoot: input.mainRoot,
    extraFolders: input.extraFolders,
    homeDirectory: input.homeDirectory,
    strict: input.strict,
    signal,
  });

  return decodeProjectRepositoriesList({
    kind: "project-repositories",
    projectId: input.projectId,
    bindingRevisionId: input.bindingRevisionId,
    repositories,
    truncated,
    workspaceFolders,
  });
}

function shouldSkipDirectoryName(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIPPED_DIRECTORY_NAMES.has(name);
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return !info.isSymbolicLink() && info.isDirectory();
  } catch {
    return false;
  }
}

type GitMarkerKind = "none" | "git-dir" | "linked-worktree" | "submodule-or-symlink";

async function inspectGitMarker(dirPath: string): Promise<GitMarkerKind> {
  const dotGit = join(dirPath, ".git");
  let info;
  try {
    info = await lstat(dotGit);
  } catch {
    return "none";
  }
  if (info.isSymbolicLink()) return "submodule-or-symlink";
  if (info.isDirectory()) return "git-dir";
  if (!info.isFile()) return "none";
  // `.git` is a regular file pointing via `gitdir: <target>`.
  try {
    const raw = await readFile(dotGit, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
    if (match === null || match[1] === undefined) return "submodule-or-symlink";
    const resolved = resolve(dirPath, match[1]).replaceAll("\\", "/");
    if (/(?:^|\/)\.git\/(?:worktrees\/[^/]+\/)?modules(?:\/|$)/.test(resolved)) {
      return "submodule-or-symlink";
    }
    if (/(?:^|\/)\.git\/worktrees(?:\/|$)/.test(resolved)) {
      return "linked-worktree";
    }
    return "git-dir";
  } catch {
    return "submodule-or-symlink";
  }
}

function checkoutHeadOf(checkout: {
  readonly detached: boolean;
  readonly head: string;
  readonly branch?: string;
}): CodeCheckoutHead | undefined {
  if (checkout.detached) {
    return decodeCodeCheckoutHead({ kind: "detached", oid: checkout.head });
  }
  if (checkout.branch?.startsWith("refs/heads/")) {
    return decodeCodeCheckoutHead({
      kind: "branch",
      name: checkout.branch.slice("refs/heads/".length),
      oid: checkout.head,
    });
  }
  return undefined;
}

function repositoryDisplayName(
  canonicalRoot: string,
  mainRoot: string,
  rootOrigin: string,
  source: "main-folder" | "nested" | "extra-folder",
): string {
  if (source === "nested") {
    const rel = relative(mainRoot, canonicalRoot).split(sep).join("/");
    if (rel !== "" && !rel.startsWith("..")) return rel;
  }
  if (source === "extra-folder" && canonicalRoot !== rootOrigin) {
    const parentName = basename(rootOrigin) || rootOrigin;
    const rel = relative(rootOrigin, canonicalRoot).split(sep).join("/");
    if (rel !== "" && !rel.startsWith("..")) return `${parentName}/${rel}`;
  }
  return basename(canonicalRoot) || canonicalRoot;
}

async function defaultReadGitModulesBlob(
  repositoryRoot: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "show", "HEAD:.gitmodules"],
      {
        encoding: "utf8",
        maxBuffer: MAX_GITMODULES_BYTES,
        timeout: GITMODULES_TIMEOUT_MS,
        signal,
        shell: false,
        env: {
          ...childProcessEnvironment(process.env),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
        },
      },
    );
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Parse submodule declarations from committed `.gitmodules` content.
 * Only safe repository-relative paths without traversal or control characters
 * are admitted.
 */
export function parseCommittedGitModules(
  content: string,
): ReadonlyArray<{ readonly name: string; readonly path: string }> {
  const results: Array<{ readonly name: string; readonly path: string }> = [];
  const seenPaths = new Set<string>();
  let currentName: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[submodule\s+"([^"]+)"\]$/i.exec(line);
    if (header !== null && header[1] !== undefined) {
      currentName = header[1].trim();
      continue;
    }
    if (line.startsWith("[")) {
      currentName = undefined;
      continue;
    }
    if (currentName === undefined || currentName === "") continue;
    const keyValue = /^path\s*=\s*(.+)$/.exec(line);
    if (keyValue === null || keyValue[1] === undefined) continue;
    const subPath = keyValue[1].trim().replaceAll("\\", "/").replace(/\/+$/, "");
    if (!isSafeRelativeSubmodulePath(subPath) || seenPaths.has(subPath)) continue;
    seenPaths.add(subPath);
    results.push({ name: currentName.slice(0, 255), path: subPath });
    if (results.length >= MAX_DISCOVERED_REPOSITORY_SUBMODULES) break;
  }
  return results;
}

function isSafeRelativeSubmodulePath(value: string): boolean {
  if (value === "" || value.length > 512) return false;
  if (value.startsWith("/") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function discoverCommittedSubmodules(
  repositoryRoot: string,
  readGitModules: (root: string, signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<ReadonlyArray<ProjectRepositorySubmodule>> {
  const content = await readGitModules(repositoryRoot, signal);
  if (content === undefined || content.trim() === "") return [];
  const declared = parseCommittedGitModules(content);
  const submodules: ProjectRepositorySubmodule[] = [];
  for (const entry of declared) {
    if (signal.aborted) break;
    const initialized = await isSubmoduleInitialized(repositoryRoot, entry.path);
    submodules.push({
      name: entry.name,
      path: entry.path,
      initialized,
    });
  }
  return submodules;
}

async function isSubmoduleInitialized(
  repositoryRoot: string,
  relativePath: string,
): Promise<boolean> {
  // Walk each segment with lstat so symlinks are never traversed.
  let current = repositoryRoot;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  try {
    const dotGit = await lstat(join(current, ".git"));
    return !dotGit.isSymbolicLink() && (dotGit.isFile() || dotGit.isDirectory());
  } catch {
    return false;
  }
}

/**
 * Strip single-line `//`, block comments, and trailing commas from JSONC
 * `.code-workspace` files so standard editor workspace files parse cleanly.
 */
export function parseCodeWorkspaceJson(
  content: string,
): ReadonlyArray<{ readonly path: string; readonly name?: string }> | undefined {
  const stripped = stripJsonCommentsAndTrailingCommas(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("folders" in parsed)) return undefined;
  const folders = (parsed as { readonly folders?: unknown }).folders;
  if (!Array.isArray(folders)) return undefined;
  const result: Array<{ readonly path: string; readonly name?: string }> = [];
  for (const item of folders) {
    if (typeof item !== "object" || item === null) continue;
    const rawPath = "path" in item ? (item as { readonly path?: unknown }).path : undefined;
    if (typeof rawPath !== "string" || rawPath.trim() === "") continue;
    const rawName = "name" in item ? (item as { readonly name?: unknown }).name : undefined;
    const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : undefined;
    result.push({ path: rawPath.trim(), ...(name === undefined ? {} : { name }) });
    if (result.length >= MAX_DISCOVERED_WORKSPACE_FOLDERS) break;
  }
  return result;
}

function stripJsonCommentsAndTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      if (i < input.length) out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

async function discoverCodeWorkspaceFolders(input: {
  readonly mainRoot: string;
  readonly extraFolders: ReadonlyArray<string>;
  readonly homeDirectory: string;
  readonly strict: boolean;
  readonly signal: AbortSignal;
}): Promise<ReadonlyArray<DiscoveredWorkspaceFolder>> {
  let entries;
  try {
    entries = await readdir(input.mainRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const workspaceFiles = entries
    .filter(
      (entry) =>
        !entry.isSymbolicLink() &&
        entry.isFile() &&
        entry.name.endsWith(".code-workspace") &&
        entry.name.length > ".code-workspace".length,
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_WORKSPACE_FILES);

  const discovered: DiscoveredWorkspaceFolder[] = [];
  const seenPaths = new Set<string>();

  for (const filename of workspaceFiles) {
    if (input.signal.aborted || discovered.length >= MAX_DISCOVERED_WORKSPACE_FOLDERS) break;
    const filePath = join(input.mainRoot, filename);
    let info;
    try {
      info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_WORKSPACE_FILE_BYTES) continue;
    } catch {
      continue;
    }
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const folders = parseCodeWorkspaceJson(content);
    if (folders === undefined) continue;

    for (const entry of folders) {
      if (discovered.length >= MAX_DISCOVERED_WORKSPACE_FOLDERS) break;
      const resolved = resolve(dirname(filePath), entry.path);
      if (seenPaths.has(resolved)) continue;

      const label = (entry.name ?? basename(resolved) ?? entry.path).slice(0, 255);
      const judged = await judgeWorkspaceFolderCandidate({
        workspaceFile: filename,
        label,
        resolvedPath: resolved,
        mainRoot: input.mainRoot,
        extraFolders: input.extraFolders,
        homeDirectory: input.homeDirectory,
        strict: input.strict,
      });
      seenPaths.add(judged.path);
      discovered.push(judged);
    }
  }
  return discovered;
}

async function judgeWorkspaceFolderCandidate(input: {
  readonly workspaceFile: string;
  readonly label: string;
  readonly resolvedPath: string;
  readonly mainRoot: string;
  readonly extraFolders: ReadonlyArray<string>;
  readonly homeDirectory: string;
  readonly strict: boolean;
}): Promise<DiscoveredWorkspaceFolder> {
  if (input.resolvedPath.includes("\0")) {
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: input.resolvedPath.replaceAll("\0", ""),
      status: "refused",
      reason: "That folder path is invalid.",
    };
  }

  // Never follow symlinks: if the named path itself is a symlink, refuse it.
  let entryStat;
  try {
    entryStat = await lstat(input.resolvedPath);
  } catch {
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: input.resolvedPath,
      status: "refused",
      reason: "That folder does not exist or cannot be accessed.",
    };
  }
  if (entryStat.isSymbolicLink()) {
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: input.resolvedPath,
      status: "refused",
      reason: "Symbolic links cannot be added from a workspace file.",
    };
  }
  if (!entryStat.isDirectory()) {
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: input.resolvedPath,
      status: "refused",
      reason: "That entry is not a directory.",
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(input.resolvedPath);
  } catch {
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: input.resolvedPath,
      status: "refused",
      reason: "That folder could not be resolved.",
    };
  }
  // Check whether any ancestor component was a symlink (when mainRoot itself is canonical).
  if (canonicalPath !== input.resolvedPath) {
    // Allow OS prefix canonicalization only when the resolved target matches
    // the same real parent outside symlink tricks? Actually, if the user wrote
    // `../symlink-dir/sub`, `canonicalPath !== resolvedPath` catches it cleanly!
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: canonicalPath,
      status: "refused",
      reason: "Symbolic links cannot be added from a workspace file.",
    };
  }

  if (
    folderContainsPath(input.mainRoot, canonicalPath) ||
    input.extraFolders.some((extra) => folderContainsPath(extra, canonicalPath))
  ) {
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: canonicalPath,
      status: "already-included",
    };
  }

  const refusal = extraFolderRefusal({
    mainRoot: input.mainRoot,
    extraFolders: input.extraFolders,
    candidate: canonicalPath,
    homeDirectory: input.homeDirectory,
    strict: input.strict,
  });
  if (refusal !== undefined) {
    return {
      workspaceFile: input.workspaceFile,
      name: input.label,
      path: canonicalPath,
      status: "refused",
      reason: refusal,
    };
  }

  return {
    workspaceFile: input.workspaceFile,
    name: input.label,
    path: canonicalPath,
    status: "available",
  };
}

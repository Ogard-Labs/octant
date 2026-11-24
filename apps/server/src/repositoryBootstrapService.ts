import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Project, ProjectId, UtcTimestamp, WindowId } from "@octant/contracts";
import {
  REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES,
  REPOSITORY_BOOTSTRAP_MAX_IGNORED_FILES,
  REPOSITORY_BOOTSTRAP_MAX_TOTAL_BYTES,
  type RepositoryBootstrapCancelCloneRequest,
  type RepositoryBootstrapCloneStatusRequest,
  type RepositoryBootstrapFailure,
  type RepositoryBootstrapFailureCode,
  type RepositoryBootstrapIgnoredFile,
  type RepositoryBootstrapInspectRequest,
  type RepositoryBootstrapInspectResult,
  type RepositoryBootstrapLandFileFailure,
  type RepositoryBootstrapLandFilesRequest,
  type RepositoryBootstrapLandFilesResult,
  type RepositoryBootstrapOperation,
  type RepositoryBootstrapOperationId,
  type RepositoryBootstrapOperationResponse,
  type RepositoryBootstrapReadFileRequest,
  type RepositoryBootstrapReadFileResult,
  type RepositoryBootstrapStartCloneRequest,
  type RepositoryCloneTransport,
} from "@octant/contracts/repository-bootstrap";
import {
  classifyBootstrapCloneStderr,
  defaultBootstrapFolderName,
  deriveBootstrapCloneRemotes,
  isBootstrapSensitiveIgnoredPath,
  isOsJunkIgnoredFile,
  validateBootstrapCloneUrl,
  validateBootstrapDestinationInput,
  validateBootstrapRelativePath,
} from "@octant/domain/repository-bootstrap-policy";
import type { BindingReceiptStorePort } from "./bindingReceiptStore";
import { runHostGit } from "./code/hostGitReads";
import { secretGuardRefusal } from "./process/secretGuard";
import type { ProjectRootPort } from "./projectRootPort";

const OPERATION_TTL_MS = 15 * 60_000;
const CLONE_TIMEOUT_MS = 15 * 60_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const STDERR_TAIL_CHARS = 8 * 1024;
const PROGRESS_LINE_CHARS = 160;
const MAX_ACTIVE_OPERATIONS = 32;

const NO_FOLLOW_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const NO_FOLLOW_CREATE_WRITE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "GH_CONFIG_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

export type RepositoryBootstrapServiceResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "refused"; readonly failure: RepositoryBootstrapFailure };

function okResult<T>(value: T): RepositoryBootstrapServiceResult<T> {
  return { status: "ok", value };
}

function refusedResult(failure: RepositoryBootstrapFailure): {
  readonly status: "refused";
  readonly failure: RepositoryBootstrapFailure;
} {
  return { status: "refused", failure };
}

export type RepositoryBootstrapCloneRunResult =
  | { readonly kind: "completed" }
  | {
      readonly kind: "failed";
      readonly code: "auth-failed" | "host-key-unverified" | "clone-failed";
      readonly message: string;
    }
  | { readonly kind: "cancelled" };

export interface RepositoryBootstrapCloneRunner {
  clone(input: {
    readonly remoteUrl: string;
    readonly transport: RepositoryCloneTransport;
    readonly stagingPath: string;
    readonly onProgress: (message: string) => void;
    readonly signal: AbortSignal;
  }): Promise<RepositoryBootstrapCloneRunResult>;
  verifyNonBareCheckout(stagingPath: string, signal: AbortSignal): Promise<boolean>;
  close(): void;
}

export interface RepositoryBootstrapCapsConfig {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface RepositoryBootstrapServiceOptions {
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly bindingReceiptStore: Pick<BindingReceiptStorePort, "issue">;
  readonly projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly homeDir: string;
  readonly cloneRunner?: RepositoryBootstrapCloneRunner;
  readonly caps?: Partial<RepositoryBootstrapCapsConfig>;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly clock?: () => string;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

interface OwnedBootstrapGitContext {
  readonly root: string;
  readonly templateDir: string;
  readonly hooksDir: string;
  readonly sshConfigPath: string;
}

interface OperationRecord {
  readonly operationId: RepositoryBootstrapOperationId;
  readonly windowId: WindowId;
  readonly transport: RepositoryCloneTransport;
  readonly destinationPath: string;
  readonly projectName: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly landedPaths: Set<string>;
  state: RepositoryBootstrapOperation;
  canonicalDestination?: string;
  landedBytes: number;
  landedCount: number;
  expiresAt: number;
}

function createOwnedBootstrapGitContext(): OwnedBootstrapGitContext {
  const root = mkdtempSync(join(tmpdir(), "octant-repo-bootstrap-git-"));
  const templateDir = join(root, "template");
  const hooksDir = join(root, "hooks");
  mkdirSync(templateDir, { recursive: true, mode: 0o700 });
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  const sshConfigPath = join(root, "gitconfig-ssh");
  writeFileSync(
    sshConfigPath,
    [
      "[core]",
      `\thooksPath = ${hooksDir}`,
      `\tfsmonitor = false`,
      "[protocol]",
      "\tallow = never",
      '[protocol "ssh"]',
      "\tallow = always",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { root, templateDir, hooksDir, sshConfigPath };
}

/**
 * Builds the non-interactive, fail-closed Git environment for one clone.
 * Repository hooks and templates are always suppressed, unsafe protocols are
 * blocked, SSH enforces `BatchMode=yes` and `StrictHostKeyChecking=yes` (never
 * auto-accepting unknown host keys), and `SSH_AUTH_SOCK` is passed only for
 * SSH clones.
 */
export function buildBootstrapCloneEnvironment(
  inherited: NodeJS.ProcessEnv,
  context: OwnedBootstrapGitContext,
  transport: RepositoryCloneTransport,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: context.templateDir,
    GIT_ALLOW_PROTOCOL: transport,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  if (transport === "ssh") {
    env.GIT_CONFIG_GLOBAL = context.sshConfigPath;
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes";
    const sshAuthSock = inherited.SSH_AUTH_SOCK;
    if (sshAuthSock !== undefined && sshAuthSock.trim() !== "") {
      env.SSH_AUTH_SOCK = sshAuthSock;
    }
  }
  return env;
}

/**
 * Builds the Git argument vector for one clone. Command-line `-c` overrides
 * suppress hooks, templates, fsmonitor, recursive submodules, and disallowed
 * protocols regardless of any user config on the host, and `--` separates
 * options from the validated remote URL.
 */
export function buildBootstrapCloneArgs(input: {
  readonly remoteUrl: string;
  readonly transport: RepositoryCloneTransport;
  readonly stagingPath: string;
  readonly hooksDir: string;
  readonly templateDir: string;
}): ReadonlyArray<string> {
  return [
    "-c",
    `core.hooksPath=${input.hooksDir}`,
    "-c",
    `init.templateDir=${input.templateDir}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.allow=never",
    "-c",
    `protocol.${input.transport}.allow=always`,
    ...(input.transport === "https" ? ["-c", "core.sshCommand=false"] : []),
    "clone",
    "--progress",
    "--origin=origin",
    "--",
    input.remoteUrl,
    input.stagingPath,
  ];
}

export function createLiveBootstrapCloneRunner(options?: {
  readonly gitExecutable?: string;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): RepositoryBootstrapCloneRunner {
  const gitExecutable = options?.gitExecutable ?? "git";
  const inherited = options?.inheritedEnvironment ?? process.env;
  const timeoutMs = options?.timeoutMs ?? CLONE_TIMEOUT_MS;
  const context = createOwnedBootstrapGitContext();
  const activeChildren = new Set<ReturnType<typeof nodeSpawn>>();

  return {
    clone: ({ remoteUrl, transport, stagingPath, onProgress, signal }) => {
      if (signal.aborted) return Promise.resolve({ kind: "cancelled" });
      const args = buildBootstrapCloneArgs({
        remoteUrl,
        transport,
        stagingPath,
        hooksDir: context.hooksDir,
        templateDir: context.templateDir,
      });
      const env = buildBootstrapCloneEnvironment(inherited, context, transport);
      return new Promise((resolve) => {
        let child: ReturnType<typeof nodeSpawn>;
        try {
          child = nodeSpawn(gitExecutable, [...args], {
            env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
          });
        } catch {
          resolve({
            kind: "failed",
            code: "clone-failed",
            message: "Git could not be started on this computer.",
          });
          return;
        }
        activeChildren.add(child);
        let settled = false;
        let cancelled = false;
        let timedOut = false;
        let outputBytes = 0;
        let stderrTail = "";
        let lineBuffer = "";
        let graceTimer: NodeJS.Timeout | undefined;

        const killTree = () => {
          terminateProcessTree(child);
          graceTimer ??= setTimeout(() => settle(null), KILL_GRACE_MS);
        };
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          killTree();
        }, timeoutMs);
        const onAbort = () => {
          cancelled = true;
          killTree();
        };
        signal.addEventListener("abort", onAbort, { once: true });

        const settle = (code?: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          signal.removeEventListener("abort", onAbort);
          activeChildren.delete(child);
          if (cancelled) {
            resolve({ kind: "cancelled" });
            return;
          }
          if (timedOut) {
            resolve({
              kind: "failed",
              code: "clone-failed",
              message: "Cloning the repository timed out.",
            });
            return;
          }
          if (code === 0) {
            resolve({ kind: "completed" });
            return;
          }
          const finalLine = sanitizeProgressLine(lineBuffer);
          if (finalLine !== "") {
            stderrTail = `${stderrTail}${finalLine}\n`.slice(-STDERR_TAIL_CHARS);
          }
          const failureCode = classifyBootstrapCloneStderr(stderrTail, transport);
          resolve({
            kind: "failed",
            code: failureCode,
            message: failureMessageForCode(failureCode, transport),
          });
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > OUTPUT_LIMIT_BYTES) killTree();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > OUTPUT_LIMIT_BYTES) {
            killTree();
            return;
          }
          lineBuffer += chunk.toString("utf8");
          const parts = lineBuffer.split(/\r\n|\r|\n/);
          lineBuffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = sanitizeProgressLine(part);
            if (line === "") continue;
            stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
            if (!settled) onProgress(line);
          }
        });
        child.once("error", () => settle(null));
        child.once("close", (code) => settle(code));
      });
    },
    verifyNonBareCheckout: async (stagingPath, signal) => {
      const bare = await runHostGit(
        ["-C", stagingPath, "rev-parse", "--is-bare-repository"],
        signal,
      );
      if (bare.exitCode !== 0 || bare.stdout.trim() !== "false") return false;
      const top = await runHostGit(["-C", stagingPath, "rev-parse", "--show-toplevel"], signal);
      if (top.exitCode !== 0) return false;
      try {
        return (await realpath(top.stdout.trim())) === (await realpath(stagingPath));
      } catch {
        return false;
      }
    },
    close: () => {
      for (const child of activeChildren) terminateProcessTree(child);
      activeChildren.clear();
      try {
        rmSync(context.root, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup on shutdown.
      }
    },
  };
}

export class RepositoryBootstrapService {
  readonly #readProject: (projectId: ProjectId) => Project | undefined;
  readonly #receipts: Pick<BindingReceiptStorePort, "issue">;
  readonly #roots: Pick<ProjectRootPort, "validate">;
  readonly #homeDir: string;
  readonly #cloneRunner: RepositoryBootstrapCloneRunner;
  readonly #caps: RepositoryBootstrapCapsConfig;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #operations = new Map<string, OperationRecord>();

  constructor(options: RepositoryBootstrapServiceOptions) {
    this.#readProject = options.readProject;
    this.#receipts = options.bindingReceiptStore;
    this.#roots = options.projectRootPort;
    this.#homeDir = options.homeDir;
    this.#cloneRunner = options.cloneRunner ?? createLiveBootstrapCloneRunner();
    this.#caps = {
      maxFiles: options.caps?.maxFiles ?? REPOSITORY_BOOTSTRAP_MAX_IGNORED_FILES,
      maxFileBytes: options.caps?.maxFileBytes ?? REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES,
      maxTotalBytes: options.caps?.maxTotalBytes ?? REPOSITORY_BOOTSTRAP_MAX_TOTAL_BYTES,
    };
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#now = options.now ?? Date.now;
    this.#uuid = options.uuid ?? randomUUID;
  }

  /** Inspects a local Code Project's `origin` remote and copyable plain gitignored files. */
  async inspect(
    request: RepositoryBootstrapInspectRequest,
    signal: AbortSignal,
  ): Promise<RepositoryBootstrapServiceResult<RepositoryBootstrapInspectResult>> {
    const projectResult = this.#requireCodeProject(request.projectId);
    if (projectResult.status === "refused") return projectResult;
    const project = projectResult.value;
    const rootResult = await this.#canonicalProjectRoot(project.binding.canonicalRoot);
    if (rootResult.status === "refused") return rootResult;
    const canonicalRoot = rootResult.value;

    const originRead = await runHostGit(
      ["-C", canonicalRoot, "remote", "get-url", "--", "origin"],
      signal,
    );
    const originUrl =
      originRead.exitCode === 0 && originRead.stdout.trim() !== ""
        ? originRead.stdout.trim()
        : undefined;
    const derived = deriveBootstrapCloneRemotes(originUrl);
    const repositoryName = defaultBootstrapFolderName(derived.repositoryName, project.name);

    const excludesArgs = await this.#globalExcludesArgs(signal);
    const ignoredRead = await runHostGit(
      [
        ...excludesArgs,
        "-C",
        canonicalRoot,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
        "-z",
      ],
      signal,
    );

    const ignoredFiles: RepositoryBootstrapIgnoredFile[] = [];
    let truncated = false;
    let omittedCount = 0;
    let omittedOversizedCount = 0;

    if (ignoredRead.exitCode === 0 && ignoredRead.stdout.length > 0) {
      const entries = ignoredRead.stdout.split("\0").filter((entry) => entry.length > 0);
      const rawFiles: string[] = [];
      const rawDirs: string[] = [];
      for (const entry of entries) {
        if (entry.endsWith("/")) rawDirs.push(entry.slice(0, -1));
        else rawFiles.push(entry);
      }

      // `git ls-files --directory` collapses untracked directories that hold
      // only ignored files (e.g. `apps/` when `apps/web/.env.local` exists in a
      // repo without tracked files under `apps/`). Walk only non-ignored
      // directories without following symlinks, stopping immediately at any
      // directory that itself matches `.gitignore` (`node_modules/`, `dist/`).
      const dirQueue: string[] = [...rawDirs];
      let visitedDirs = 0;
      const MAX_UNTRACKED_DIR_VISITS = 256;
      while (dirQueue.length > 0 && visitedDirs < MAX_UNTRACKED_DIR_VISITS) {
        const rawDir = dirQueue.shift();
        if (rawDir === undefined) break;
        const checkedDir = validateBootstrapRelativePath(rawDir);
        if (!checkedDir.ok) continue;
        const dirIgnored = await runHostGit(
          [
            ...excludesArgs,
            "-C",
            canonicalRoot,
            "check-ignore",
            "-q",
            "--",
            `${checkedDir.normalized}/`,
          ],
          signal,
        );
        if (dirIgnored.exitCode === 0) continue;
        visitedDirs += 1;
        const dirAbs = join(canonicalRoot, ...checkedDir.segments);
        const dirStat = await lstat(dirAbs).catch(() => undefined);
        if (dirStat === undefined || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
        const children = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const childRel = `${checkedDir.normalized}/${child.name}`;
          if (child.isDirectory()) {
            dirQueue.push(childRel);
          } else if (child.isFile()) {
            const fileIgnored = await runHostGit(
              [...excludesArgs, "-C", canonicalRoot, "check-ignore", "-q", "--", childRel],
              signal,
            );
            if (fileIgnored.exitCode === 0) rawFiles.push(childRel);
          }
        }
      }

      const uniqueSortedFiles = [...new Set(rawFiles)].sort();

      for (const rawEntry of uniqueSortedFiles) {
        const checked = validateBootstrapRelativePath(rawEntry);
        if (!checked.ok) continue;
        if (isOsJunkIgnoredFile(checked.normalized)) continue;

        const fullPath = join(canonicalRoot, ...checked.segments);
        let entryStat;
        try {
          entryStat = await lstat(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isSymbolicLink() || !entryStat.isFile()) continue;

        // Ensure no parent segment resolves outside the repository root.
        let resolved: string;
        try {
          resolved = await realpath(fullPath);
        } catch {
          continue;
        }
        if (resolved !== join(canonicalRoot, ...checked.segments)) continue;

        if (entryStat.size > this.#caps.maxFileBytes) {
          omittedOversizedCount += 1;
          truncated = true;
          continue;
        }
        if (ignoredFiles.length >= this.#caps.maxFiles) {
          omittedCount += 1;
          truncated = true;
          continue;
        }

        const secretGuardMatched =
          isBootstrapSensitiveIgnoredPath(checked.normalized) ||
          secretGuardRefusal(resolved) !== undefined;

        ignoredFiles.push({
          path: checked.normalized,
          bytes: entryStat.size,
          secretGuardMatched,
        });
      }
    }

    return okResult({
      projectId: project.id,
      projectName: project.name,
      sourcePath: canonicalRoot,
      repositoryName,
      defaultDestinationPath: `~/${repositoryName}`,
      remotes: derived.remotes,
      ignoredFiles,
      truncated,
      omittedCount,
      omittedOversizedCount,
      caps: this.#caps,
    });
  }

  /**
   * Reads one explicitly chosen gitignored plain file from a local Code Project.
   * Refuses symlinks, traversal, `.git/**`, non-ignored files, and files above the cap.
   */
  async readIgnoredFile(
    request: RepositoryBootstrapReadFileRequest,
    signal: AbortSignal,
  ): Promise<RepositoryBootstrapServiceResult<RepositoryBootstrapReadFileResult>> {
    const projectResult = this.#requireCodeProject(request.projectId);
    if (projectResult.status === "refused") return projectResult;
    const project = projectResult.value;
    const rootResult = await this.#canonicalProjectRoot(project.binding.canonicalRoot);
    if (rootResult.status === "refused") return rootResult;
    const canonicalRoot = rootResult.value;

    const checked = validateBootstrapRelativePath(request.relativePath);
    if (!checked.ok) {
      return refusedResult({
        code: "invalid",
        message: checked.message,
      });
    }

    // Confirm Git actually considers this path ignored in this repository.
    const excludesArgs = await this.#globalExcludesArgs(signal);
    const ignoreCheck = await runHostGit(
      [...excludesArgs, "-C", canonicalRoot, "check-ignore", "-q", "--", checked.normalized],
      signal,
    );
    if (ignoreCheck.exitCode !== 0) {
      return refusedResult({
        code: "invalid",
        message: "Only gitignored files can be read for repository bootstrap.",
      });
    }

    const fullPath = join(canonicalRoot, ...checked.segments);
    let handle;
    try {
      handle = await open(fullPath, NO_FOLLOW_READ_FLAGS);
    } catch {
      return refusedResult({
        code: "not-found",
        message: `Could not open ${checked.normalized}.`,
      });
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        return refusedResult({
          code: "invalid",
          message: `${checked.normalized} is not a regular file.`,
        });
      }
      const resolved = await realpath(fullPath).catch(() => "");
      if (resolved !== join(canonicalRoot, ...checked.segments)) {
        return refusedResult({
          code: "invalid",
          message: `${checked.normalized} escapes the repository root.`,
        });
      }
      if (info.size > this.#caps.maxFileBytes) {
        return refusedResult({
          code: "invalid",
          message: `${checked.normalized} exceeds the ${formatMiB(this.#caps.maxFileBytes)} per-file limit.`,
        });
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > this.#caps.maxFileBytes) {
        return refusedResult({
          code: "invalid",
          message: `${checked.normalized} exceeds the ${formatMiB(this.#caps.maxFileBytes)} per-file limit.`,
        });
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return okResult({
        relativePath: checked.normalized,
        bytes: bytes.byteLength,
        sha256,
        mode: info.mode & 0o777,
        contentBase64: bytes.toString("base64"),
      });
    } finally {
      await handle.close();
    }
  }

  /** Starts an asynchronous repository clone on the receiving host. */
  async startClone(
    windowId: WindowId,
    request: RepositoryBootstrapStartCloneRequest,
  ): Promise<RepositoryBootstrapServiceResult<RepositoryBootstrapOperationResponse>> {
    this.#purgeExpired();

    const existing = this.#operations.get(String(request.operationId));
    if (existing !== undefined) {
      if (String(existing.windowId) !== String(windowId)) {
        return refusedResult({
          code: "unauthorized",
          message: "Clone operation belongs to a different session.",
        });
      }
      return okResult({ operation: existing.state });
    }

    if (this.#operations.size >= MAX_ACTIVE_OPERATIONS) {
      return refusedResult({
        code: "unavailable",
        message: "Too many repository clones are active on this computer.",
      });
    }

    const validUrl = validateBootstrapCloneUrl(request.remoteUrl, request.transport);
    if (!validUrl.ok) {
      return refusedResult({
        code: "invalid-url",
        message: validUrl.message,
      });
    }

    const validDestination = validateBootstrapDestinationInput(request.destinationPath, {
      platform: this.#platform,
    });
    if (!validDestination.ok) {
      return refusedResult({
        code: "invalid",
        message: validDestination.message,
      });
    }

    const targetResult = await this.#prepareDestination(validDestination.trimmed);
    if (targetResult.status === "refused") return targetResult;
    const resolvedTarget = targetResult.value;
    const projectName =
      request.projectName?.trim() ||
      defaultBootstrapFolderName(basename(resolvedTarget.finalPath), "repository");

    const controller = new AbortController();
    const initialState: RepositoryBootstrapOperation = {
      state: "cloning",
      operationId: request.operationId,
      transport: request.transport,
      destinationPath: validDestination.trimmed,
      progressMessage: "Starting git clone…",
      updatedAt: this.#timestamp(),
    };

    let finishCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      finishCompletion = resolve;
    });

    const record: OperationRecord = {
      operationId: request.operationId,
      windowId,
      transport: request.transport,
      destinationPath: validDestination.trimmed,
      projectName,
      controller,
      completion,
      landedPaths: new Set(),
      state: initialState,
      landedBytes: 0,
      landedCount: 0,
      expiresAt: this.#now() + OPERATION_TTL_MS,
    };
    this.#operations.set(String(request.operationId), record);

    void this.#runClone(record, {
      remoteUrl: validUrl.normalizedUrl,
      transport: request.transport,
      parentDir: resolvedTarget.parentDir,
      finalPath: resolvedTarget.finalPath,
    }).finally(() => {
      finishCompletion();
    });

    return okResult({ operation: record.state });
  }

  /** Reads the current status of a clone operation owned by this caller. */
  cloneStatus(
    windowId: WindowId,
    request: RepositoryBootstrapCloneStatusRequest,
  ): RepositoryBootstrapServiceResult<RepositoryBootstrapOperationResponse> {
    this.#purgeExpired();
    const recordResult = this.#requireOperation(windowId, request.operationId);
    if (recordResult.status === "refused") return recordResult;
    return okResult({ operation: recordResult.value.state });
  }

  /** Cancels an active clone operation and cleans up its staging directory. */
  async cancelClone(
    windowId: WindowId,
    request: RepositoryBootstrapCancelCloneRequest,
  ): Promise<RepositoryBootstrapServiceResult<RepositoryBootstrapOperationResponse>> {
    this.#purgeExpired();
    const recordResult = this.#requireOperation(windowId, request.operationId);
    if (recordResult.status === "refused") return recordResult;
    const record = recordResult.value;
    if (record.state.state === "cloning") {
      record.controller.abort(new Error("cancelled"));
      await record.completion;
    }
    return okResult({ operation: record.state });
  }

  /**
   * Lands explicitly chosen ignored files into a freshly cloned repository root.
   * Refuses traversal, symlinks, `.git/**`, tracked/existing checkout files,
   * oversized payloads, and hash mismatches. Preserves the clone and returns
   * exact failed paths on partial copy.
   */
  async landFiles(
    windowId: WindowId,
    request: RepositoryBootstrapLandFilesRequest,
  ): Promise<RepositoryBootstrapServiceResult<RepositoryBootstrapLandFilesResult>> {
    this.#purgeExpired();
    const recordResult = this.#requireOperation(windowId, request.operationId);
    if (recordResult.status === "refused") return recordResult;
    const record = recordResult.value;
    if (record.state.state !== "cloned" || record.canonicalDestination === undefined) {
      return refusedResult({
        code: "invalid",
        message: "Files can only be copied after the repository clone completes.",
      });
    }

    const cloneRoot = await realpath(record.canonicalDestination).catch(() => undefined);
    if (cloneRoot === undefined || cloneRoot !== record.canonicalDestination) {
      return refusedResult({
        code: "unavailable",
        message: "The cloned repository folder is no longer available.",
      });
    }

    // Batch-check whether any requested path is tracked in the receiving clone's
    // checked-out branch so an ignored file from a source branch never overwrites
    // a committed file on the destination checkout.
    const validPaths: string[] = [];
    for (const file of request.files) {
      const checked = validateBootstrapRelativePath(file.relativePath);
      if (checked.ok) validPaths.push(checked.normalized);
    }
    const trackedPaths = new Set<string>();
    if (validPaths.length > 0) {
      const trackedRead = await runHostGit(
        ["-C", cloneRoot, "ls-files", "-z", "--", ...validPaths],
        new AbortController().signal,
      );
      if (trackedRead.exitCode !== 0) {
        return refusedResult({
          code: "unavailable",
          message: "Could not verify tracked files in the cloned repository.",
        });
      }
      for (const entry of trackedRead.stdout.split("\0")) {
        if (entry.length > 0) trackedPaths.add(entry);
      }
    }

    const landed: string[] = [];
    const failed: RepositoryBootstrapLandFileFailure[] = [];

    for (const file of request.files) {
      const checked = validateBootstrapRelativePath(file.relativePath);
      if (!checked.ok) {
        failed.push({
          relativePath: file.relativePath,
          reason: checked.reason,
          message: checked.message,
        });
        continue;
      }

      if (trackedPaths.has(checked.normalized)) {
        failed.push({
          relativePath: checked.normalized,
          reason: "invalid-path",
          message: "Refused to overwrite a file tracked in the cloned repository.",
        });
        continue;
      }

      if (record.landedCount + 1 > this.#caps.maxFiles) {
        failed.push({
          relativePath: checked.normalized,
          reason: "size-exceeded",
          message: `Cannot copy more than ${String(this.#caps.maxFiles)} files.`,
        });
        continue;
      }

      const content = Buffer.from(file.contentBase64, "base64");
      if (content.byteLength !== file.bytes) {
        failed.push({
          relativePath: checked.normalized,
          reason: "hash-mismatch",
          message: "Decoded file size does not match declared byte size.",
        });
        continue;
      }
      if (
        content.byteLength > this.#caps.maxFileBytes ||
        record.landedBytes + content.byteLength > this.#caps.maxTotalBytes
      ) {
        failed.push({
          relativePath: checked.normalized,
          reason: "size-exceeded",
          message: "File exceeds the bootstrap copy size limit.",
        });
        continue;
      }

      const actualSha = createHash("sha256").update(content).digest("hex");
      if (actualSha !== file.sha256) {
        failed.push({
          relativePath: checked.normalized,
          reason: "hash-mismatch",
          message: "File checksum did not match.",
        });
        continue;
      }

      const landOutcome = await this.#landSingleFile({
        cloneRoot,
        segments: checked.segments,
        content,
        mode: file.mode & 0o777,
        allowReplace: record.landedPaths.has(checked.normalized),
      });
      if (!landOutcome.ok) {
        failed.push({
          relativePath: checked.normalized,
          reason: landOutcome.reason,
          message: landOutcome.message,
        });
        continue;
      }

      record.landedPaths.add(checked.normalized);
      record.landedBytes += content.byteLength;
      record.landedCount += 1;
      record.expiresAt = this.#now() + OPERATION_TTL_MS;
      landed.push(checked.normalized);
    }

    return okResult({
      status: failed.length === 0 ? "landed" : "partial-copy",
      landed,
      failed,
    });
  }

  /** Cancels in-flight clones and cleans up owned temporary git config on shutdown. */
  close(): void {
    for (const record of this.#operations.values()) {
      if (record.state.state === "cloning") {
        record.controller.abort(new Error("server-shutdown"));
      }
    }
    this.#operations.clear();
    this.#cloneRunner.close();
  }

  async #runClone(
    record: OperationRecord,
    target: {
      readonly remoteUrl: string;
      readonly transport: RepositoryCloneTransport;
      readonly parentDir: string;
      readonly finalPath: string;
    },
  ): Promise<void> {
    // Allocate a unique server-owned staging directory via mkdtemp so cleanup
    // can never delete an unowned directory named by a client operationId.
    let stagingRoot: string | undefined;
    try {
      stagingRoot = await mkdtemp(join(target.parentDir, ".octant-clone-"));
      const stagingPath = join(stagingRoot, "repo");
      const result = await this.#cloneRunner.clone({
        remoteUrl: target.remoteUrl,
        transport: target.transport,
        stagingPath,
        onProgress: (message) => {
          if (record.state.state !== "cloning") return;
          record.state = {
            ...record.state,
            progressMessage: message,
            updatedAt: this.#timestamp(),
          };
          record.expiresAt = this.#now() + OPERATION_TTL_MS;
        },
        signal: record.controller.signal,
      });

      if (result.kind === "cancelled" || record.controller.signal.aborted) {
        record.state = {
          state: "cancelled",
          operationId: record.operationId,
          transport: record.transport,
          destinationPath: record.destinationPath,
          updatedAt: this.#timestamp(),
        };
        record.expiresAt = this.#now() + OPERATION_TTL_MS;
        return;
      }

      if (result.kind === "failed") {
        this.#failOperation(record, result.code, result.message);
        return;
      }

      const verified = await this.#cloneRunner.verifyNonBareCheckout(
        stagingPath,
        record.controller.signal,
      );
      if (!verified) {
        this.#failOperation(
          record,
          "clone-failed",
          "The cloned folder could not be verified as a Git working tree.",
        );
        return;
      }

      const destinationCheck = await this.#checkDestinationEmpty(target.finalPath);
      if (!destinationCheck.ok) {
        this.#failOperation(record, "destination-not-empty", destinationCheck.message);
        return;
      }
      if (destinationCheck.existsEmptyDir) {
        await rmdir(target.finalPath);
      }

      await rename(stagingPath, target.finalPath);
      const canonicalDestination = await realpath(target.finalPath);
      const canonicalBinding = await this.#roots.validate("code", canonicalDestination);
      const receipt = this.#receipts.issue({
        windowId: record.windowId,
        projectType: "code",
        canonicalBinding,
        now: this.#now(),
      });

      record.canonicalDestination = canonicalBinding.canonicalRoot;
      record.state = {
        state: "cloned",
        operationId: record.operationId,
        transport: record.transport,
        destinationPath: record.destinationPath,
        canonicalDestination: canonicalBinding.canonicalRoot,
        receiptId: receipt.receiptId,
        projectName: record.projectName,
        updatedAt: this.#timestamp(),
      };
      record.expiresAt = this.#now() + OPERATION_TTL_MS;
    } catch {
      if (record.state.state === "cloning") {
        this.#failOperation(
          record,
          "clone-failed",
          "Could not finish cloning the repository into the destination folder.",
        );
      }
    } finally {
      if (stagingRoot !== undefined) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  #failOperation(
    record: OperationRecord,
    code: RepositoryBootstrapFailureCode,
    message: string,
  ): void {
    record.state = {
      state: "failed",
      operationId: record.operationId,
      transport: record.transport,
      destinationPath: record.destinationPath,
      code,
      message,
      updatedAt: this.#timestamp(),
    };
    record.expiresAt = this.#now() + OPERATION_TTL_MS;
  }

  async #prepareDestination(
    destinationInput: string,
  ): Promise<
    RepositoryBootstrapServiceResult<{ readonly parentDir: string; readonly finalPath: string }>
  > {
    const isWindows = this.#platform === "win32";
    const splitSegments = (value: string) =>
      value.split(isWindows ? /[\\/]+/ : "/").filter((segment) => segment.length > 0);
    const isHomePrefixed =
      destinationInput.startsWith("~/") || (isWindows && destinationInput.startsWith("~\\"));

    let rawTarget: string;
    if (isHomePrefixed) {
      let canonicalHome: string;
      try {
        canonicalHome = await realpath(this.#homeDir);
      } catch {
        return refusedResult({
          code: "unavailable",
          message: "The home folder on this computer is not accessible.",
        });
      }
      const segments = splitSegments(destinationInput.slice(2));
      rawTarget = join(canonicalHome, ...segments);
      if (!isPathInside(canonicalHome, rawTarget) || rawTarget === canonicalHome) {
        return refusedResult({
          code: "invalid",
          message: "Destination folder must be a subfolder inside your home folder.",
        });
      }
    } else if (isAbsolute(destinationInput)) {
      rawTarget = destinationInput;
    } else {
      let canonicalHome: string;
      try {
        canonicalHome = await realpath(this.#homeDir);
      } catch {
        return refusedResult({
          code: "unavailable",
          message: "The home folder on this computer is not accessible.",
        });
      }
      const segments = splitSegments(destinationInput);
      rawTarget = join(canonicalHome, ...segments);
    }

    const targetCheck = await this.#checkDestinationEmpty(rawTarget);
    if (!targetCheck.ok) {
      return refusedResult({
        code: "destination-not-empty",
        message: targetCheck.message,
      });
    }

    const parentDir = dirname(rawTarget);
    try {
      await mkdir(parentDir, { recursive: true });
      const canonicalParent = await realpath(parentDir);
      return okResult({
        parentDir: canonicalParent,
        finalPath: join(canonicalParent, basename(rawTarget)),
      });
    } catch {
      return refusedResult({
        code: "unavailable",
        message: "Could not create or access the destination parent folder.",
      });
    }
  }

  async #checkDestinationEmpty(
    targetPath: string,
  ): Promise<
    | { readonly ok: true; readonly existsEmptyDir: boolean }
    | { readonly ok: false; readonly message: string }
  > {
    let info;
    try {
      info = await lstat(targetPath);
    } catch (error) {
      if (isNotFound(error)) return { ok: true, existsEmptyDir: false };
      return { ok: false, message: "Destination folder cannot be inspected." };
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        ok: false,
        message: "Destination path already exists and is not an empty folder.",
      };
    }
    try {
      const entries = await readdir(targetPath);
      if (entries.length > 0) {
        return {
          ok: false,
          message: "Destination folder already exists and is not empty.",
        };
      }
      return { ok: true, existsEmptyDir: true };
    } catch {
      return { ok: false, message: "Destination folder cannot be read." };
    }
  }

  async #landSingleFile(input: {
    readonly cloneRoot: string;
    readonly segments: ReadonlyArray<string>;
    readonly content: Buffer;
    readonly mode: number;
    readonly allowReplace: boolean;
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: RepositoryBootstrapLandFileFailure["reason"];
        readonly message: string;
      }
  > {
    // Walk and create each parent directory segment without following symlinks.
    let currentDir = input.cloneRoot;
    for (let index = 0; index < input.segments.length - 1; index += 1) {
      const segment = input.segments[index];
      if (segment === undefined) continue;
      const nextDir = join(currentDir, segment);
      let existing;
      try {
        existing = await lstat(nextDir);
      } catch (error) {
        if (!isNotFound(error)) {
          return {
            ok: false,
            reason: "write-failed",
            message: "Could not inspect destination parent folder.",
          };
        }
      }
      if (existing === undefined) {
        try {
          await mkdir(nextDir, { mode: 0o755 });
        } catch {
          return {
            ok: false,
            reason: "write-failed",
            message: "Could not create destination subfolder.",
          };
        }
      } else if (existing.isSymbolicLink() || !existing.isDirectory()) {
        return {
          ok: false,
          reason: "symlink-refused",
          message: "Refused to write through a symlink or non-directory parent.",
        };
      }
      const resolvedDir = await realpath(nextDir).catch(() => undefined);
      if (resolvedDir === undefined || !isPathInside(input.cloneRoot, resolvedDir)) {
        return {
          ok: false,
          reason: "symlink-refused",
          message: "Destination folder resolves outside the cloned repository.",
        };
      }
      currentDir = resolvedDir;
    }

    const fileName = input.segments.at(-1);
    if (fileName === undefined) {
      return { ok: false, reason: "invalid-path", message: "Missing file name." };
    }
    const targetPath = join(currentDir, fileName);
    const existingTarget = await lstat(targetPath).catch((error: unknown) =>
      isNotFound(error) ? undefined : "error",
    );
    if (existingTarget === "error") {
      return {
        ok: false,
        reason: "write-failed",
        message: "Could not inspect destination file path.",
      };
    }
    if (existingTarget !== undefined) {
      if (existingTarget.isSymbolicLink() || !existingTarget.isFile()) {
        return {
          ok: false,
          reason: "symlink-refused",
          message: "Refused to overwrite a symlink or non-regular file.",
        };
      }
      if (!input.allowReplace) {
        return {
          ok: false,
          reason: "invalid-path",
          message: "Refused to overwrite an existing file in the cloned repository.",
        };
      }
    }

    const parentStatBefore = await lstat(currentDir).catch(() => undefined);
    if (
      parentStatBefore === undefined ||
      parentStatBefore.isSymbolicLink() ||
      !parentStatBefore.isDirectory()
    ) {
      return {
        ok: false,
        reason: "symlink-refused",
        message: "Destination parent is not a regular directory.",
      };
    }

    const tempPath = join(currentDir, `.octant-copy-${this.#uuid().slice(0, 8)}`);
    let handle;
    try {
      handle = await open(tempPath, NO_FOLLOW_CREATE_WRITE_FLAGS, input.mode);
      // Confirm the parent directory still resolves inside the clone root and
      // keeps the same device/inode identity before writing payload bytes.
      const resolvedDuring = await realpath(currentDir).catch(() => undefined);
      const parentStatDuring = await lstat(currentDir).catch(() => undefined);
      if (
        resolvedDuring === undefined ||
        !isPathInside(input.cloneRoot, resolvedDuring) ||
        parentStatDuring === undefined ||
        parentStatDuring.dev !== parentStatBefore.dev ||
        parentStatDuring.ino !== parentStatBefore.ino
      ) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await rm(tempPath, { force: true }).catch(() => undefined);
        return {
          ok: false,
          reason: "symlink-refused",
          message: "Destination parent changed outside the cloned repository.",
        };
      }
      await handle.writeFile(input.content);
      await handle.chmod(input.mode);
    } catch {
      await rm(tempPath, { force: true }).catch(() => undefined);
      return {
        ok: false,
        reason: "write-failed",
        message: "Could not write copied file.",
      };
    } finally {
      await handle?.close().catch(() => undefined);
    }

    try {
      // Re-verify parent identity and containment right before placement.
      const resolvedParent = await realpath(currentDir);
      const parentStatAfter = await lstat(currentDir);
      if (
        !isPathInside(input.cloneRoot, resolvedParent) ||
        parentStatAfter.dev !== parentStatBefore.dev ||
        parentStatAfter.ino !== parentStatBefore.ino
      ) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        return {
          ok: false,
          reason: "symlink-refused",
          message: "Destination parent resolved outside the cloned repository.",
        };
      }
      const recheckTarget = await lstat(targetPath).catch((error: unknown) =>
        isNotFound(error) ? undefined : "error",
      );
      if (recheckTarget === "error") {
        await rm(tempPath, { force: true }).catch(() => undefined);
        return {
          ok: false,
          reason: "write-failed",
          message: "Could not verify destination file path before placement.",
        };
      }
      if (recheckTarget !== undefined) {
        if (recheckTarget.isSymbolicLink() || !recheckTarget.isFile()) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          return {
            ok: false,
            reason: "symlink-refused",
            message: "Refused to replace a symlink or non-regular file.",
          };
        }
        if (!input.allowReplace) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          return {
            ok: false,
            reason: "invalid-path",
            message: "Refused to overwrite an existing file in the cloned repository.",
          };
        }
      }
      if (!input.allowReplace) {
        // Atomic no-clobber placement via hard link + unlink so a racing file
        // or symlink at targetPath fails with EEXIST instead of overwriting.
        try {
          await link(tempPath, targetPath);
          await rm(tempPath, { force: true }).catch(() => undefined);
          return { ok: true };
        } catch (error: unknown) {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
          if (code === "EEXIST") {
            await rm(tempPath, { force: true }).catch(() => undefined);
            return {
              ok: false,
              reason: "invalid-path",
              message: "Refused to overwrite an existing file in the cloned repository.",
            };
          }
          if (code !== "EPERM" && code !== "EXDEV" && code !== "ENOTSUP") throw error;
        }
      }
      await rename(tempPath, targetPath);
      return { ok: true };
    } catch {
      await rm(tempPath, { force: true }).catch(() => undefined);
      return {
        ok: false,
        reason: "write-failed",
        message: "Could not place copied file into destination.",
      };
    }
  }

  /**
   * Resolves the user's effective global `core.excludesFile` without enabling
   * arbitrary global Git configuration during repository reads, so files ignored
   * only by the user's global excludes file remain discoverable and readable.
   */
  async #globalExcludesArgs(signal: AbortSignal): Promise<ReadonlyArray<string>> {
    const env: NodeJS.ProcessEnv = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] as const) {
      const value = this.#env[key];
      if (value !== undefined && value !== "") env[key] = value;
    }

    const configured = await new Promise<string | undefined>((resolve) => {
      nodeExecFile(
        "git",
        ["config", "--global", "--path", "--get", "core.excludesFile"],
        {
          encoding: "utf8",
          env,
          shell: false,
          signal,
          timeout: 3_000,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
            return;
          }
          const trimmed = stdout.trim();
          resolve(trimmed === "" ? undefined : trimmed);
        },
      );
    });
    if (configured !== undefined) {
      return ["-c", `core.excludesFile=${configured}`];
    }

    const xdgHome = this.#env.XDG_CONFIG_HOME;
    const defaultGlobalIgnore =
      xdgHome !== undefined && xdgHome !== ""
        ? join(xdgHome, "git", "ignore")
        : join(this.#homeDir, ".config", "git", "ignore");
    const info = await lstat(defaultGlobalIgnore).catch(() => undefined);
    if (info !== undefined && info.isFile()) {
      return ["-c", `core.excludesFile=${defaultGlobalIgnore}`];
    }
    return [];
  }

  #requireCodeProject(
    projectId: ProjectId,
  ): RepositoryBootstrapServiceResult<Extract<Project, { readonly type: "code" }>> {
    const project = this.#readProject(projectId);
    if (project === undefined || project.type !== "code") {
      return refusedResult({
        code: "not-found",
        message: "Code Project was not found.",
      });
    }
    return okResult(project);
  }

  async #canonicalProjectRoot(rootPath: string): Promise<RepositoryBootstrapServiceResult<string>> {
    try {
      const canonical = await realpath(rootPath);
      const info = await lstat(canonical);
      if (!info.isDirectory()) {
        return refusedResult({
          code: "unavailable",
          message: "The Code Project folder is not accessible.",
        });
      }
      return okResult(canonical);
    } catch {
      return refusedResult({
        code: "unavailable",
        message: "The Code Project folder is not accessible.",
      });
    }
  }

  #requireOperation(
    windowId: WindowId,
    operationId: RepositoryBootstrapOperationId,
  ): RepositoryBootstrapServiceResult<OperationRecord> {
    const record = this.#operations.get(String(operationId));
    if (record === undefined) {
      return refusedResult({
        code: "not-found",
        message: "Clone operation was not found or has expired.",
      });
    }
    if (String(record.windowId) !== String(windowId)) {
      return refusedResult({
        code: "unauthorized",
        message: "Clone operation belongs to a different session.",
      });
    }
    return okResult(record);
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [id, record] of this.#operations) {
      if (record.state.state !== "cloning" && now >= record.expiresAt) {
        this.#operations.delete(id);
      }
    }
  }

  #timestamp(): UtcTimestamp {
    return this.#clock() as UtcTimestamp;
  }
}

function terminateProcessTree(child: ReturnType<typeof nodeSpawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    void nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
  forceKill.unref();
}

function sanitizeProgressLine(raw: string): string {
  const withoutAnsi = raw
    // oxlint-disable-next-line no-control-regex -- strips terminal escape sequences.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // oxlint-disable-next-line no-control-regex -- strips residual control bytes.
    .replace(/\u001b./g, "")
    // oxlint-disable-next-line no-control-regex -- strips C0 and DEL bytes.
    .replace(/[\u0000-\u001f\u007f]/g, "");
  return withoutAnsi
    .replace(/\/\/[^/\s@]+@/g, "//[redacted]@")
    .trim()
    .slice(0, PROGRESS_LINE_CHARS);
}

function failureMessageForCode(
  code: "auth-failed" | "host-key-unverified" | "clone-failed",
  transport: RepositoryCloneTransport,
): string {
  if (code === "host-key-unverified") {
    return "SSH host key verification failed. Add the Git host to known_hosts on the destination computer, or switch to HTTPS.";
  }
  if (code === "auth-failed") {
    return transport === "ssh"
      ? "SSH authentication failed on the destination computer. Check your SSH key or switch to HTTPS."
      : "HTTPS authentication failed on the destination computer. Sign in to Git on that computer or switch to SSH.";
  }
  return "Could not clone the repository on the destination computer.";
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? String(mib) : mib.toFixed(1)} MiB`;
}

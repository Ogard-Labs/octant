import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveManagedRepositorySegments } from "@octant/domain";

const DEFAULT_CLONE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const STDERR_TAIL_CHARACTERS = 8 * 1024;
const PROGRESS_LINE_CHARACTERS = 160;
const ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "GH_CONFIG_DIR",
] as const;

/**
 * Server-owned Git context that suppresses every host-controlled Git entry
 * point (templates with hooks, global/system config, credential helpers)
 * while a managed clone or verification command runs.
 */
export interface OwnedGitContext {
  readonly templateDirectory: string;
  readonly globalConfigPath: string;
  readonly hooksDirectory: string;
}

export interface ManagedCloneChildProcess {
  readonly pid: number | undefined;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  /** Terminates the whole owned process tree, not only the direct child. */
  killTree(): void;
}

export interface ManagedCloneSpawnPort {
  spawn(
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): ManagedCloneChildProcess;
}

export type ManagedCloneFailureClassification = "unauthorized" | "not-found" | "network" | "failed";

export type ManagedCloneResult =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly classification: ManagedCloneFailureClassification }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

export type ManagedGitResult =
  | { readonly status: "completed"; readonly exitCode: number; readonly stdout: string }
  | { readonly status: "failed" }
  | { readonly status: "cancelled" }
  | { readonly status: "timeout" };

/**
 * Builds the only environment a managed clone/verification child may see:
 * an explicit allowlist (never tokens, never `GIT_*`/`GH_*` overrides, never
 * loader injection) plus server-owned Git suppression values. `gh` supplies
 * its stored credential through its own in-process git credential helper, so
 * no token ever appears in arguments, stdin, or this environment.
 */
export function managedCloneEnvironment(
  inherited: NodeJS.ProcessEnv,
  context: OwnedGitContext,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_TEMPLATE_DIR: context.templateDirectory,
    GIT_CONFIG_GLOBAL: context.globalConfigPath,
  };
  for (const name of ENVIRONMENT_ALLOWLIST)
    if (inherited[name] !== undefined) environment[name] = inherited[name];
  // gh resolves its stored credential through the host secure store; these
  // are session socket locations, not credentials, and only their narrow
  // expected forms are copied (mirrors the authenticated `gh` port).
  const sessionBus = inherited.DBUS_SESSION_BUS_ADDRESS;
  if (isSafeSessionBusAddress(sessionBus)) environment.DBUS_SESSION_BUS_ADDRESS = sessionBus;
  const runtimeDirectory = inherited.XDG_RUNTIME_DIR;
  if (isSafeRuntimeDirectory(runtimeDirectory)) environment.XDG_RUNTIME_DIR = runtimeDirectory;
  return environment;
}

function isSafeSessionBusAddress(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^unix:(?:path|abstract)=[A-Za-z0-9_./:=@+\-]+(?:,guid=[A-Za-z0-9._=\-]+)?$/.test(value)
  );
}

function isSafeRuntimeDirectory(value: string | undefined): value is string {
  return value !== undefined && /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value);
}

/** Creates the owned template/config/hooks context for live clones. */
export function createOwnedGitContext(): OwnedGitContext {
  const root = mkdtempSync(join(tmpdir(), "octant-managed-git-"));
  const templateDirectory = join(root, "template");
  const hooksDirectory = join(root, "hooks");
  mkdirSync(templateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(hooksDirectory, { recursive: true, mode: 0o700 });
  const globalConfigPath = join(root, "gitconfig");
  writeFileSync(
    globalConfigPath,
    [
      "[core]",
      `\thooksPath = ${hooksDirectory}`,
      "[protocol]",
      "\tallow = never",
      '[protocol "https"]',
      "\tallow = always",
      "[credential]",
      "\thelper =",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { templateDirectory, globalConfigPath, hooksDirectory };
}

export function createManagedCloneSpawnPort(): ManagedCloneSpawnPort {
  return {
    spawn: (executable, args, environment) => {
      const child = nodeSpawn(executable, [...args], {
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      return {
        pid: child.pid,
        onStdout: (listener) => child.stdout.on("data", listener),
        onStderr: (listener) => child.stderr.on("data", listener),
        onExit: (listener) => child.once("close", (code) => listener(code)),
        onError: (listener) => child.once("error", listener),
        killTree: () => terminateProcessTree(child),
      };
    },
  };
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

export class ManagedCloneProcessPort {
  readonly #ghExecutable: string;
  readonly #gitExecutable: string;
  readonly #inheritedEnvironment: NodeJS.ProcessEnv;
  readonly #context: OwnedGitContext;
  readonly #spawn: ManagedCloneSpawnPort;
  readonly #cloneTimeoutMs: number;
  readonly #gitTimeoutMs: number;
  readonly #activeChildren = new Set<ManagedCloneChildProcess>();

  constructor(options: {
    readonly ghExecutable: string;
    readonly gitExecutable: string;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
    readonly context: OwnedGitContext;
    readonly spawn?: ManagedCloneSpawnPort;
    readonly cloneTimeoutMs?: number;
    readonly gitTimeoutMs?: number;
  }) {
    this.#ghExecutable = options.ghExecutable;
    this.#gitExecutable = options.gitExecutable;
    this.#inheritedEnvironment = options.inheritedEnvironment ?? process.env;
    this.#context = options.context;
    this.#spawn = options.spawn ?? createManagedCloneSpawnPort();
    this.#cloneTimeoutMs = options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
    this.#gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  hooksDirectory(): string {
    return this.#context.hooksDirectory;
  }

  /**
   * Clones one confirmed repository into the reserved staging path using
   * fixed, token-free arguments. Progress is redacted and bounded before it
   * leaves this port; raw child output never does.
   */
  clone(
    input: { readonly owner: string; readonly name: string; readonly stagingPath: string },
    onProgress: (message: string) => void,
    signal: AbortSignal,
  ): Promise<ManagedCloneResult> {
    const segments = deriveManagedRepositorySegments({ owner: input.owner, name: input.name });
    if (segments.kind !== "derived") {
      return Promise.resolve({ kind: "failed", classification: "failed" });
    }
    if (signal.aborted) return Promise.resolve({ kind: "cancelled" });
    const args = [
      "repo",
      "clone",
      `${input.owner}/${input.name}`,
      input.stagingPath,
      "--",
      "--no-checkout",
      "--origin=origin",
    ];
    const environment = managedCloneEnvironment(this.#inheritedEnvironment, this.#context);
    return new Promise((resolve) => {
      let child: ManagedCloneChildProcess;
      try {
        child = this.#spawn.spawn(this.#ghExecutable, args, environment);
      } catch {
        resolve({ kind: "failed", classification: "failed" });
        return;
      }
      this.#activeChildren.add(child);
      let settled = false;
      let cancelled = false;
      let timedOut = false;
      let outputBytes = 0;
      let stderrTail = "";
      let lineBuffer = "";
      let graceTimer: NodeJS.Timeout | undefined;
      const killWithGrace = () => {
        child.killTree();
        graceTimer ??= setTimeout(() => settle(), KILL_GRACE_MS);
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killWithGrace();
      }, this.#cloneTimeoutMs);
      const onAbort = () => {
        cancelled = true;
        killWithGrace();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = (code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        signal.removeEventListener("abort", onAbort);
        this.#activeChildren.delete(child);
        if (cancelled) resolve({ kind: "cancelled" });
        else if (timedOut) resolve({ kind: "timeout" });
        else if (code === 0) resolve({ kind: "completed" });
        else resolve({ kind: "failed", classification: classifyCloneFailure(stderrTail) });
      };
      child.onStdout((chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > OUTPUT_LIMIT_BYTES) killWithGrace();
      });
      child.onStderr((chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > OUTPUT_LIMIT_BYTES) {
          killWithGrace();
          return;
        }
        lineBuffer += chunk.toString("utf8");
        const parts = lineBuffer.split(/\r\n|\r|\n/);
        lineBuffer = parts.pop() ?? "";
        for (const part of parts) {
          const message = sanitizeProgressLine(part);
          if (message === "") continue;
          stderrTail = `${stderrTail}${message}\n`.slice(-STDERR_TAIL_CHARACTERS);
          if (!settled) onProgress(message);
        }
      });
      child.onError(() => settle(null));
      child.onExit((code) => settle(code));
    });
  }

  /** Runs one local `git` verification command under the owned context. */
  runGit(args: readonly string[], signal: AbortSignal): Promise<ManagedGitResult> {
    if (signal.aborted) return Promise.resolve({ status: "cancelled" });
    const environment = managedCloneEnvironment(this.#inheritedEnvironment, this.#context);
    return new Promise((resolve) => {
      let child: ManagedCloneChildProcess;
      try {
        child = this.#spawn.spawn(this.#gitExecutable, [...args], environment);
      } catch {
        resolve({ status: "failed" });
        return;
      }
      this.#activeChildren.add(child);
      let settled = false;
      let cancelled = false;
      let timedOut = false;
      let stdout = "";
      let graceTimer: NodeJS.Timeout | undefined;
      const killWithGrace = () => {
        child.killTree();
        graceTimer ??= setTimeout(() => settle(), KILL_GRACE_MS);
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killWithGrace();
      }, this.#gitTimeoutMs);
      const onAbort = () => {
        cancelled = true;
        killWithGrace();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = (code?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        signal.removeEventListener("abort", onAbort);
        this.#activeChildren.delete(child);
        if (cancelled) resolve({ status: "cancelled" });
        else if (timedOut) resolve({ status: "timeout" });
        else if (code === undefined || code === null) resolve({ status: "failed" });
        else resolve({ status: "completed", exitCode: code, stdout });
      };
      child.onStdout((chunk) => {
        if (Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT_BYTES) {
          killWithGrace();
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.onStderr(() => {});
      child.onError(() => settle(null));
      child.onExit((code) => settle(code));
    });
  }

  /** Server shutdown owns and terminates every active managed child tree. */
  close(): void {
    for (const child of this.#activeChildren) child.killTree();
    this.#activeChildren.clear();
  }
}

function sanitizeProgressLine(raw: string): string {
  const withoutAnsi = raw
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  const redacted = withoutAnsi
    .replace(/\b(?:gh[opsru]|github_pat)_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\/\/[^/\s@]+@/g, "//[redacted]@");
  return redacted.trim().slice(0, PROGRESS_LINE_CHARACTERS);
}

function classifyCloneFailure(diagnostic: string): ManagedCloneFailureClassification {
  if (
    /bad credentials|http 401|authentication (?:required|failed)|not logged in|not authenticated|invalid token|token has expired|sso/i.test(
      diagnostic,
    )
  ) {
    return "unauthorized";
  }
  if (/could not resolve to a repository|http 404|repository not found/i.test(diagnostic)) {
    return "not-found";
  }
  if (
    /could not resolve host|network|connection|dial tcp|tls|timed? ?out|temporarily unavailable|service unavailable/i.test(
      diagnostic,
    )
  ) {
    return "network";
  }
  return "failed";
}

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GithubAuthenticationCommand } from "@octant/contracts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const INTERACTIVE_AUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const STATUS_OBSERVATION_TIMEOUT_MS = 5_000;
const SECURE_STORE_PROBE_TIMEOUT_MS = 5_000;
const MINIMUM_SUPPORTED_GH_VERSION = [2, 45, 0] as const;
const TOKEN_ENVIRONMENT_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
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

export interface GhAuthenticationCommandPort {
  run(
    arguments_: readonly string[],
    options: { readonly environment: NodeJS.ProcessEnv; readonly stdin?: string },
    signal: AbortSignal,
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr?: string }>;
  /**
   * Starts a bounded interactive login. It resolves early only after a
   * redacted device code is available; the owned child keeps running until it
   * completes or the server deadline terminates it.
   */
  beginInteractive?(
    arguments_: readonly string[],
    options: { readonly environment: NodeJS.ProcessEnv },
    signal: AbortSignal,
  ): Promise<GhInteractiveAuthenticationResult>;
  /** Proves the resolved executable is an allowlisted compatible gh version. */
  verifySupported?(
    options: { readonly environment: NodeJS.ProcessEnv },
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Releases every child owned by this server instance. */
  close?(): void;
}

type GhCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
};

type GhInteractiveAuthenticationResult =
  | { readonly kind: "completed"; readonly result: GhCommandResult }
  | {
      readonly kind: "device-flow";
      readonly userCode: string;
      /** Settles when the server-owned interactive child is no longer active. */
      readonly completion: Promise<void>;
    };

export type GhAuthenticationExecution =
  | { readonly kind: "completed" }
  | { readonly kind: "device-flow"; readonly userCode: string };

/**
 * Proves that an interactive gh setup can use host-managed secure credential
 * storage. A false or unproven result deliberately blocks setup before gh is
 * launched, so gh cannot create a plaintext hosts.yml fallback.
 */
export interface GhSecureStoragePort {
  isAvailable(signal: AbortSignal, environment: NodeJS.ProcessEnv): boolean | Promise<boolean>;
}

export type GhAuthenticationObservation =
  | {
      readonly kind: "observed";
      readonly accounts: readonly {
        readonly login: string;
        readonly source: string;
        readonly scopes: readonly string[];
        readonly gitProtocol: string;
      }[];
    }
  | { readonly kind: "external-token" | "unauthorized" | "rate-limited" | "unavailable" };

export class GhAuthenticationPort {
  readonly #command: GhAuthenticationCommandPort;
  readonly #inheritedEnvironment: NodeJS.ProcessEnv;
  readonly #secureStorage: GhSecureStoragePort;
  readonly #statusObservationTimeoutMs: number;
  #lifecycleActive = false;
  constructor(
    options: {
      readonly command?: GhAuthenticationCommandPort;
      readonly ghExecutable?: string;
      readonly inheritedEnvironment?: NodeJS.ProcessEnv;
      readonly secureStorage?: GhSecureStoragePort;
      readonly statusObservationTimeoutMs?: number;
    } = {},
  ) {
    this.#command = options.command ?? createGhAuthenticationCommandPort(options.ghExecutable);
    this.#inheritedEnvironment = options.inheritedEnvironment ?? process.env;
    this.#secureStorage = options.secureStorage ?? createGhSecureStoragePort();
    this.#statusObservationTimeoutMs =
      options.statusObservationTimeoutMs ?? STATUS_OBSERVATION_TIMEOUT_MS;
  }

  async observe(signal: AbortSignal): Promise<GhAuthenticationObservation> {
    if (hasExternalToken(this.#inheritedEnvironment)) return { kind: "external-token" };
    const environment = sanitizedEnvironment(this.#inheritedEnvironment);
    if (!(await this.#supportsResolvedExecutable(signal, environment)))
      return { kind: "unavailable" };
    let result: { readonly exitCode: number; readonly stdout: string; readonly stderr?: string };
    try {
      result = await withDeadline(
        (deadlineSignal) =>
          this.#command.run(
            ["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
            { environment },
            deadlineSignal,
          ),
        signal,
        this.#statusObservationTimeoutMs,
      );
    } catch {
      return { kind: "unavailable" };
    }
    if (result.exitCode !== 0) return classifyStatusFailure(result);
    return decodeStatus(result.stdout);
  }

  async execute(
    command: GithubAuthenticationCommand,
    signal: AbortSignal,
  ): Promise<GhAuthenticationExecution> {
    if (signal.aborted) throw abortReason(signal);
    if (hasExternalToken(this.#inheritedEnvironment)) throw new Error("external-token");
    if (this.#lifecycleActive) throw new Error("github-authentication-in-progress");
    this.#lifecycleActive = true;
    let retainsLifecycle = false;
    try {
      const environment = sanitizedEnvironment(this.#inheritedEnvironment);
      if (!(await this.#supportsResolvedExecutable(signal, environment))) {
        throw new Error("gh-cli-unsupported");
      }
      if (
        (command.kind === "setup" || command.kind === "refresh") &&
        !(await this.#secureStorageAvailable(signal, environment))
      ) {
        throw new Error("secure-storage-unavailable");
      }
      const arguments_ =
        command.kind === "setup"
          ? ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https"]
          : command.kind === "refresh"
            ? ["auth", "refresh", "--hostname", "github.com", "--scopes", "read:project"]
            : [
                "auth",
                "logout",
                "--hostname",
                "github.com",
                "--user",
                await this.#activeLoginForLogout(signal),
              ];
      if (
        (command.kind === "setup" || command.kind === "refresh") &&
        this.#command.beginInteractive !== undefined
      ) {
        const interactive = await this.#command.beginInteractive(
          arguments_,
          { environment },
          signal,
        );
        if (interactive.kind === "device-flow") {
          retainsLifecycle = true;
          void interactive.completion.then(
            () => this.#releaseLifecycle(),
            () => this.#releaseLifecycle(),
          );
          return { kind: "device-flow", userCode: interactive.userCode };
        }
        if (interactive.result.exitCode !== 0) throw new Error("gh-auth-failed");
        return { kind: "completed" };
      }
      const result = await withDeadline(
        (deadlineSignal) => this.#command.run(arguments_, { environment }, deadlineSignal),
        signal,
        INTERACTIVE_AUTH_TIMEOUT_MS,
      );
      if (result.exitCode !== 0) throw new Error("gh-auth-failed");
      return { kind: "completed" };
    } finally {
      if (!retainsLifecycle) this.#releaseLifecycle();
    }
  }

  /** Server shutdown owns and terminates any detached interactive `gh` child. */
  close(): void {
    this.#releaseLifecycle();
    this.#command.close?.();
  }

  async #supportsResolvedExecutable(
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    if (this.#command.verifySupported === undefined) return true;
    try {
      return await withDeadline(
        (deadlineSignal) => this.#command.verifySupported!({ environment }, deadlineSignal),
        signal,
        this.#statusObservationTimeoutMs,
      );
    } catch {
      return false;
    }
  }

  async #secureStorageAvailable(
    signal: AbortSignal,
    environment: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    try {
      return await this.#secureStorage.isAvailable(signal, environment);
    } catch {
      return false;
    }
  }

  async #activeLoginForLogout(signal: AbortSignal): Promise<string> {
    const observation = await this.observe(signal);
    if (observation.kind !== "observed" || observation.accounts.length !== 1)
      throw new Error("github-authentication-unavailable");
    return observation.accounts[0]!.login;
  }

  #releaseLifecycle(): void {
    this.#lifecycleActive = false;
  }
}

type GhStatusAccount =
  | {
      readonly kind: "healthy";
      readonly active: boolean;
      readonly login: string;
      readonly source: string;
      readonly scopes: readonly string[];
      readonly gitProtocol: string;
    }
  | {
      readonly kind: "error";
      readonly active: boolean;
      readonly error: unknown;
    };

function decodeStatus(stdout: string): GhAuthenticationObservation {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) return { kind: "unavailable" };
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    return { kind: "unavailable" };
  }
  if (!isRecord(root) || !hasExactKeys(root, ["hosts"]) || !isRecord(root.hosts))
    return { kind: "unavailable" };
  if (!Object.keys(root.hosts).every((host) => host === "github.com"))
    return { kind: "unavailable" };
  const hostAccounts = root.hosts["github.com"];
  // gh JSON mode exits zero without an active account and reports `{hosts:{}}`.
  // That is the ordinary reauthentication state, never an unavailable host.
  if (hostAccounts === undefined) return { kind: "unauthorized" };
  if (!Array.isArray(hostAccounts)) return { kind: "unavailable" };
  const decodedAccounts = hostAccounts.map(decodeStatusAccount);
  if (decodedAccounts.some((account) => account === undefined)) return { kind: "unavailable" };
  const activeAccounts = (decodedAccounts as readonly GhStatusAccount[]).filter(
    (account) => account.active,
  );
  // `gh auth status --json` can retain an active account with `{ state:
  // "error" }` even when the failed account check was transient.  Do not
  // prompt for destructive reauthentication while a valid credential is only
  // rate-limited or the GitHub API cannot be reached.
  const errorAccount = activeAccounts.find((account) => account.kind === "error");
  if (errorAccount !== undefined) {
    return classifyActiveAccountError(errorAccount.error);
  }
  const accounts = activeAccounts
    .filter(
      (account): account is Extract<GhStatusAccount, { readonly kind: "healthy" }> =>
        account.kind === "healthy",
    )
    .map((account) => ({
      login: account.login,
      source: account.source,
      scopes: account.scopes,
      gitProtocol: account.gitProtocol,
    }));
  return {
    kind: "observed",
    accounts,
  };
}

function decodeStatusAccount(value: unknown): GhStatusAccount | undefined {
  if (!isRecord(value) || typeof value.active !== "boolean") return undefined;
  if (value.state === "error") {
    if (
      !hasExactKeys(value, ["login", "active", "state", "gitProtocol"], ["error", "host"]) ||
      typeof value.login !== "string" ||
      typeof value.gitProtocol !== "string" ||
      (value.host !== undefined && value.host !== "github.com") ||
      (value.error !== undefined && typeof value.error !== "string")
    )
      return undefined;
    return { kind: "error", active: value.active, error: value.error };
  }
  if (
    !hasExactKeys(
      value,
      ["login", "active", "scopes", "tokenSource", "gitProtocol"],
      ["host", "state"],
    ) ||
    typeof value.login !== "string" ||
    typeof value.tokenSource !== "string" ||
    typeof value.gitProtocol !== "string" ||
    (value.host !== undefined && value.host !== "github.com") ||
    (value.state !== undefined && value.state !== "success")
  )
    return undefined;
  const rawScopes = Array.isArray(value.scopes)
    ? value.scopes
    : typeof value.scopes === "string"
      ? value.scopes.split(",")
      : undefined;
  if (rawScopes === undefined || rawScopes.some((scope) => typeof scope !== "string"))
    return undefined;
  return {
    kind: "healthy",
    active: value.active,
    login: value.login,
    source: normalizeCredentialSource(value.tokenSource),
    scopes: rawScopes
      .map(String)
      .map((scope) => scope.trim())
      .filter(Boolean),
    gitProtocol: value.gitProtocol,
  };
}

function classifyStatusFailure(result: {
  readonly exitCode: number;
  readonly stderr?: string;
}): GhAuthenticationObservation {
  const diagnostic = result.stderr ?? "";
  if (Buffer.byteLength(diagnostic, "utf8") > MAX_OUTPUT_BYTES) return { kind: "unavailable" };
  // `gh help exit-codes` reserves 4 for authentication required. A rate limit
  // is determined by the normalized diagnostic instead of overloading that
  // auth outcome.
  if (result.exitCode === 4) return { kind: "unauthorized" };
  return classifyStatusDiagnostic(diagnostic, "unavailable");
}

function classifyActiveAccountError(error: unknown): GhAuthenticationObservation {
  if (error === undefined) return { kind: "unauthorized" };
  if (typeof error !== "string" || Buffer.byteLength(error, "utf8") > MAX_OUTPUT_BYTES)
    return { kind: "unavailable" };
  return classifyStatusDiagnostic(error, "unauthorized");
}

function classifyStatusDiagnostic(
  diagnostic: string,
  fallback: "unauthorized" | "unavailable",
): GhAuthenticationObservation {
  if (/rate limit/i.test(diagnostic)) return { kind: "rate-limited" };
  if (
    /network|connection|could not resolve|dial tcp|timeout|temporarily unavailable|service unavailable|tls/i.test(
      diagnostic,
    )
  )
    return { kind: "unavailable" };
  if (
    /not logged in|not authenticated|authentication required|token has expired|bad credentials|invalid token|sso|http 401/i.test(
      diagnostic,
    )
  )
    return { kind: "unauthorized" };
  return { kind: fallback };
}

function hasExternalToken(environment: NodeJS.ProcessEnv): boolean {
  return TOKEN_ENVIRONMENT_NAMES.some((name) => {
    const token = environment[name];
    return token !== undefined && token !== "";
  });
}

function normalizeCredentialSource(source: string): string {
  // Current gh JSON reports a plaintext token source as its hosts.yml path.
  // Keep the credential path inside this adapter and pass only a closed source
  // category to the policy layer.
  return /(?:^|[\\/])hosts\.ya?ml$/i.test(source) ? "config-file" : source;
}
export function sanitizedEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const name of ENVIRONMENT_ALLOWLIST)
    if (inherited[name] !== undefined) environment[name] = inherited[name];
  // Secret Service discovers a host's user session through these values. They
  // are socket locations, not credentials; copy only their narrow, expected
  // forms so the gh child uses precisely the context that passed the probe.
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function createGhAuthenticationCommandPort(
  ghExecutable: string | undefined,
): GhAuthenticationCommandPort {
  if (ghExecutable === undefined || !resolvedExecutableIsUsable(ghExecutable)) {
    return unavailableGhAuthenticationCommandPort();
  }
  const lifecycle = new AbortController();
  const ownedChildren = new Set<ReturnType<typeof spawn>>();
  const run: GhAuthenticationCommandPort["run"] = (arguments_, options, signal) =>
    new Promise((resolve, reject) => {
      const combined = combineAbortSignals(signal, lifecycle.signal);
      const child = spawn(ghExecutable, [...arguments_], {
        env: options.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal: combined.signal,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      ownedChildren.add(child);
      let stdout = "";
      let stderr = "";
      const terminate = () => terminateProcessTree(child);
      combined.signal.addEventListener("abort", terminate, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stdout, "utf8") <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr, "utf8") <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        combined.signal.removeEventListener("abort", terminate);
        combined.cleanup();
        ownedChildren.delete(child);
        reject(error);
      });
      child.once("close", (code) => {
        combined.signal.removeEventListener("abort", terminate);
        combined.cleanup();
        ownedChildren.delete(child);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  return {
    run,
    beginInteractive: (arguments_, options, parentSignal) =>
      startGhInteractiveAuthentication(
        ghExecutable,
        arguments_,
        options,
        parentSignal,
        lifecycle.signal,
        ownedChildren,
      ),
    verifySupported: async (options, signal) => {
      const result = await run(["--version"], options, signal);
      return result.exitCode === 0 && supportedGhVersion(result.stdout);
    },
    close: () => {
      lifecycle.abort(new Error("server-shutdown"));
      for (const child of ownedChildren) terminateProcessTree(child);
    },
  };
}

function unavailableGhAuthenticationCommandPort(): GhAuthenticationCommandPort {
  return {
    run: async () => {
      throw new Error("gh-cli-unavailable");
    },
    verifySupported: async () => false,
  };
}

function resolvedExecutableIsUsable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const metadata = statSync(path);
    if (!metadata.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function supportedGhVersion(stdout: string): boolean {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) return false;
  const match = /^gh version (\d+)\.(\d+)\.(\d+)(?: \([^\r\n]+\))?\r?$/m.exec(stdout.trim());
  if (match === null) return false;
  const version = match.slice(1).map(Number);
  if (version.length !== 3 || version.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < MINIMUM_SUPPORTED_GH_VERSION.length; index += 1) {
    const current = version[index]!;
    const minimum = MINIMUM_SUPPORTED_GH_VERSION[index]!;
    if (current > minimum) return true;
    if (current < minimum) return false;
  }
  return true;
}

/**
 * Own an interactive `gh auth` process until its normal completion or a server
 * deadline. On a headless host, GitHub CLI emits a one-time device code before
 * waiting for browser confirmation; expose only that bounded code and a
 * pinned verification URL, never its raw output. The parent request can cancel
 * before the handoff is delivered. Once delivered, the server-owned interaction
 * remains bounded by `INTERACTIVE_AUTH_TIMEOUT_MS` so a normal HTTP response
 * does not prematurely kill the authentication it just enabled.
 */
function startGhInteractiveAuthentication(
  executable: string,
  arguments_: readonly string[],
  options: { readonly environment: NodeJS.ProcessEnv },
  parentSignal: AbortSignal,
  lifecycleSignal: AbortSignal,
  ownedChildren: Set<ReturnType<typeof spawn>>,
): Promise<GhInteractiveAuthenticationResult> {
  return new Promise((resolve, reject) => {
    if (parentSignal.aborted) {
      reject(abortReason(parentSignal));
      return;
    }
    if (lifecycleSignal.aborted) {
      reject(abortReason(lifecycleSignal));
      return;
    }
    const deadline = new AbortController();
    const child = spawn(executable, [...arguments_], {
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal: deadline.signal,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    ownedChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const terminate = () => terminateProcessTree(child);
    const abortForParent = () => deadline.abort(parentSignal.reason);
    const abortForLifecycle = () => deadline.abort(lifecycleSignal.reason);
    const timeout = setTimeout(
      () => deadline.abort(new Error("interactive-auth-deadline-exceeded")),
      INTERACTIVE_AUTH_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortForParent);
      lifecycleSignal.removeEventListener("abort", abortForLifecycle);
      deadline.signal.removeEventListener("abort", terminate);
      ownedChildren.delete(child);
    };
    parentSignal.addEventListener("abort", abortForParent, { once: true });
    lifecycleSignal.addEventListener("abort", abortForLifecycle, { once: true });
    deadline.signal.addEventListener("abort", terminate, { once: true });
    const emitDeviceFlow = () => {
      if (settled) return;
      const userCode = extractDeviceFlowCode(`${stdout}\n${stderr}`);
      if (userCode === undefined) return;
      settled = true;
      // The response now owns the handoff; retain the child only under its
      // server deadline, not the request lifecycle that has just completed.
      parentSignal.removeEventListener("abort", abortForParent);
      resolve({ kind: "device-flow", userCode, completion });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, "utf8") <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      emitDeviceFlow();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      emitDeviceFlow();
    });
    child.once("error", (error) => {
      cleanup();
      resolveCompletion();
      if (!settled) reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolveCompletion();
      if (!settled) {
        settled = true;
        resolve({ kind: "completed", result: { exitCode: code ?? 1, stdout, stderr } });
      }
    });
  });
}

export function extractDeviceFlowCode(output: string): string | undefined {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return undefined;
  const match =
    /(?:your\s+)?(?:one-time|device)(?:\s+your)?\s+code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output);
  return match === null ? undefined : match[1]!.toUpperCase();
}

function createGhSecureStoragePort(): GhSecureStoragePort {
  return {
    // Do not infer a usable store from the OS. Keychain can be locked and a
    // Linux host can have Secret Service available; each implementation below
    // performs a bounded store-specific operation before gh is allowed to
    // create a credential.
    isAvailable: async (signal, environment) => {
      if (signal.aborted) return false;
      if (process.platform === "darwin") {
        return await probeMacKeychain(signal, environment);
      }
      if (process.platform === "linux") return await probeSecretService(signal, environment);
      return false;
    },
  };
}

async function probeMacKeychain(
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const account = `octant-probe-${randomUUID()}`;
  const service = "octant-secure-storage-probe";
  const secret = `octant-${randomUUID()}`;
  let stored = false;
  try {
    const added = await runBounded(
      "security",
      ["add-generic-password", "-a", account, "-s", service, "-w", secret, "-U"],
      signal,
      environment,
    );
    if (added.exitCode !== 0) return false;
    stored = true;
    const read = await runBounded(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      signal,
      environment,
    );
    if (read.exitCode !== 0 || read.stdout.trim() !== secret) return false;
    const cleared = await runBounded(
      "security",
      ["delete-generic-password", "-a", account, "-s", service],
      signal,
      environment,
    );
    stored = false;
    return cleared.exitCode === 0;
  } catch {
    return false;
  } finally {
    if (stored) {
      try {
        await runBounded(
          "security",
          ["delete-generic-password", "-a", account, "-s", service],
          signal,
          environment,
        );
      } catch {
        // The value is a random, non-credential probe. A failed cleanup still
        // makes this setup attempt fail closed above.
      }
    }
  }
}

async function probeSecretService(
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const nonce = randomUUID();
  const secret = `octant-${randomUUID()}`;
  const attributes = ["service", "octant-secure-storage-probe", "nonce", nonce] as const;
  try {
    const stored = await runBounded(
      "secret-tool",
      ["store", "--label", "Octant secure storage probe", ...attributes],
      signal,
      environment,
      secret,
    );
    if (stored.exitCode !== 0) return false;
    const read = await runBounded("secret-tool", ["lookup", ...attributes], signal, environment);
    return read.exitCode === 0 && read.stdout.trim() === secret;
  } catch {
    return false;
  } finally {
    // The nonce scopes cleanup to this one short-lived, non-credential probe.
    try {
      await runBounded("secret-tool", ["clear", ...attributes], signal, environment);
    } catch {
      // A failed cleanup makes this particular setup attempt fail closed above;
      // the random probe has no GitHub credential material.
    }
  }
}

async function runBounded(
  executable: string,
  arguments_: readonly string[],
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  return await withDeadline(
    (deadlineSignal) =>
      new Promise((resolve, reject) => {
        const child = spawn(executable, [...arguments_], {
          env: environment,
          stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"],
          shell: false,
          signal: deadlineSignal,
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(stdout, "utf8") <= MAX_OUTPUT_BYTES)
            stdout += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
        if (stdin !== undefined) child.stdin?.end(stdin);
      }),
    signal,
    SECURE_STORE_PROBE_TIMEOUT_MS,
  );
}

function combineAbortSignals(
  first: AbortSignal,
  second: AbortSignal,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController();
  const abortFirst = () => controller.abort(first.reason);
  const abortSecond = () => controller.abort(second.reason);
  if (first.aborted) abortFirst();
  else first.addEventListener("abort", abortFirst, { once: true });
  if (second.aborted) abortSecond();
  else second.addEventListener("abort", abortSecond, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      first.removeEventListener("abort", abortFirst);
      second.removeEventListener("abort", abortSecond);
    },
  };
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (parentSignal.aborted) throw abortReason(parentSignal);
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("deadline-exceeded")), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operation-aborted");
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    void spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

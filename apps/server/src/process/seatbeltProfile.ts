/**
 * Shared confinement builder for Octant-spawned tool and provider subprocesses.
 *
 * Tool launchers that execute arbitrary code — Code terminal shells
 * (`terminalProcessPort`; design doc historically named `shellService`), the
 * project-confined test runner, and Git helpers — must prepare launches through
 * this module so policies cannot drift. On macOS this is the Seatbelt
 * `sandbox-exec` profile; on Linux it is a rootless Bubblewrap namespace.
 * Missing the platform runtime fails closed; there is no unconfined fallback.
 *
 * Network egress is materialized as OS `none` | `allow` only. The finer
 * `provider-endpoints-only` host allowlist is enforced by Octant-owned
 * brokered tools, not by a local egress proxy in V1.
 *
 * Native macOS sandbox-exec probes remain packaged/native validation evidence;
 * Linux CI covers profile string generation and Bubblewrap launch construction.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { buildLinuxConfinementLaunch, DEFAULT_BWRAP_PATH } from "./linuxConfinement";
import type { OsNetworkEgress } from "./threadEgressPolicy";

export class SeatbeltConfinementError extends Error {
  override readonly name = "SeatbeltConfinementError";

  constructor(
    readonly reason: "incompatible" | "invalid-configuration",
    message: string,
  ) {
    super(message);
  }
}

export interface SeatbeltProfileInput {
  /** Exactly one bound filesystem root the process may write (unless writeBoundRoot is false). */
  readonly boundRoot: string;
  /** Private temporary directory the process may write. */
  readonly temporaryDirectory: string;
  /** Extra write roots (provider managed homes). Bound root + temp remain the tool baseline. */
  readonly additionalWriteRoots?: ReadonlyArray<string>;
  readonly readRoots?: ReadonlyArray<string>;
  readonly networkEgress: OsNetworkEgress;
  readonly allowProcessExec?: boolean;
  readonly allowProcessFork?: boolean;
  /**
   * Programs that stay executable when `allowProcessExec` is false: the
   * confined program itself and its script interpreter. See
   * {@link confinedExecutableExecPaths}.
   */
  readonly execAllowPaths?: ReadonlyArray<string>;
  readonly allowFileReadStar?: boolean;
  readonly writeBoundRoot?: boolean;
  /**
   * Extra read denials kept alongside the defaults instead of replacing them.
   *
   * Use this for a shared parent whose siblings belong to other authority
   * scopes: the deny covers the whole subpath, including directories created
   * after this profile was generated, and the caller's own read/write roots
   * beneath it are re-allowed by the later allow rules.
   */
  readonly additionalDenyReadPaths?: ReadonlyArray<string>;
  /**
   * Extra write denials emitted after the bound-root and temporary-directory
   * grants and before `additionalWriteRoots`.
   *
   * A shared parent that happens to sit under the temporary directory is
   * otherwise writable through that ancestor grant, so denying the subpath here
   * and re-allowing this launch's own directory below keeps sibling scopes
   * unreachable for writes as well as reads.
   */
  readonly additionalDenyWritePaths?: ReadonlyArray<string>;
  readonly privateHomeAllowPaths?: ReadonlyArray<string>;
  readonly extraRules?: ReadonlyArray<string>;
  readonly homeDirectory?: string;
  readonly usersDirectory?: string;
}

export interface WrapCommandInSandboxExecInput {
  readonly sandboxPath: string;
  readonly profile: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

export interface ConfinedProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface SeatbeltConfinementPrepareInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly boundRoot: string;
  readonly temporaryDirectory: string;
  readonly networkEgress: OsNetworkEgress;
  readonly additionalWriteRoots?: ReadonlyArray<string>;
  readonly readRoots?: ReadonlyArray<string>;
  readonly allowProcessExec?: boolean;
  readonly allowProcessFork?: boolean;
  readonly allowFileReadStar?: boolean;
  readonly writeBoundRoot?: boolean;
  /** See {@link SeatbeltProfileInput.additionalDenyReadPaths}. */
  readonly additionalDenyReadPaths?: ReadonlyArray<string>;
  /** See {@link SeatbeltProfileInput.additionalDenyWritePaths}. */
  readonly additionalDenyWritePaths?: ReadonlyArray<string>;
  readonly privateHomeAllowPaths?: ReadonlyArray<string>;
  readonly extraRules?: ReadonlyArray<string>;
}

export interface SeatbeltConfinementPort {
  readonly prepare: (input: SeatbeltConfinementPrepareInput) => ConfinedProcessLaunch;
}

export interface SeatbeltConfinementOptions {
  readonly platform?: NodeJS.Platform;
  /** Override the runtime path: `sandbox-exec` on macOS, `bwrap` on Linux. */
  readonly sandboxPath?: string;
  readonly homeDirectory?: string;
  readonly usersDirectory?: string;
  /** `PATH` used to resolve a `#!/usr/bin/env` interpreter; defaults to the host's. */
  readonly interpreterSearchPath?: string;
}

export interface RequireSandboxExecInput {
  readonly platform: NodeJS.Platform;
  readonly sandboxPath: string;
}

export interface PrivateHomeDenyReadRulesInput {
  readonly allowedPaths: ReadonlyArray<string>;
  readonly homeDirectory?: string;
  readonly usersDirectory?: string;
}

const DEFAULT_SANDBOX_PATH = "/usr/bin/sandbox-exec";
/**
 * Paths that must remain unreadable even for toolchain launches that need the
 * broad `file-read*` rule. The latter is a compatibility escape hatch for
 * runtimes such as Git and provider CLIs, not authority to inspect credentials
 * or the host's private system state. Exact launch roots are re-allowed below
 * these denials, so legitimate project/runtime reads remain available.
 */
const DEFAULT_DENY_READ_PATHS = [
  "/Volumes",
  "/Network",
  "/etc/ssh",
  "/var/root",
  "/Library/Keychains",
  "/private",
] as const;
const MAX_PRIVATE_DENY_RULES = 4_096;

export function escapeSeatbeltPath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function seatbeltAllowRule(operation: "file-read*" | "file-write*", path: string): string {
  return `(allow ${operation} (subpath "${escapeSeatbeltPath(path)}"))`;
}

export function seatbeltDenyRule(operation: "file-read*" | "file-write*", path: string): string {
  return `(deny ${operation} (subpath "${escapeSeatbeltPath(path)}"))`;
}

export function seatbeltExecRule(path: string): string {
  return `(allow process-exec (literal "${escapeSeatbeltPath(path)}"))`;
}

const SHEBANG_BYTES = 512;

/**
 * The programs a launch has to exec before the confined process exists: the
 * program itself and, for a `#!` script, its interpreter. Seatbelt judges the
 * launch exec too, so a profile that denies `process-exec` outright made
 * `sandbox-exec` refuse to start the very program it was confining; every
 * Chat and Plan launch of a Seatbelt-confined provider died with "Operation
 * not permitted" before speaking a byte of protocol (observed with Pi 0.84.1
 * under `--no-tools`, whose entry point is `#!/usr/bin/env node`). Seatbelt
 * matches literals against the resolved path, so each entry is listed with its
 * real path as well. Listing these adds no reach: the confined process already
 * is that program, and every further exec is still judged against this list.
 */
export function confinedExecutableExecPaths(
  executable: string,
  searchPath: string | undefined,
): ReadonlyArray<string> {
  const paths = new Set<string>();
  const add = (path: string) => {
    paths.add(path);
    try {
      paths.add(realpathSync(path));
    } catch {
      // A missing program keeps its literal; the launch reports the failure.
    }
  };
  add(executable);
  const interpreter = shebangInterpreter(executable);
  if (interpreter !== undefined) {
    add(interpreter.command);
    if (interpreter.program !== undefined) {
      const resolved = resolveOnSearchPath(interpreter.program, searchPath);
      if (resolved !== undefined) add(resolved);
    }
  }
  return [...paths];
}

function shebangInterpreter(
  executable: string,
): { readonly command: string; readonly program?: string } | undefined {
  let header: string;
  try {
    const descriptor = openSync(executable, "r");
    try {
      const buffer = Buffer.alloc(SHEBANG_BYTES);
      const read = readSync(descriptor, buffer, 0, SHEBANG_BYTES, 0);
      header = buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
  if (!header.startsWith("#!")) return undefined;
  const [command, ...rest] = header.slice(2).split(/\r?\n/, 1)[0]!.trim().split(/\s+/);
  if (command === undefined || !isAbsolute(command)) return undefined;
  if (basename(command) !== "env") return { command };
  const program = envInterpreterOperand(rest);
  return program === undefined ? { command } : { command, program };
}

// `env` names the interpreter after its own options and any `NAME=value`
// assignments, so `#!/usr/bin/env -u NODE_OPTIONS FORCE_COLOR=0 node` still
// resolves to `node`. Picking the first non-flag token instead selects an
// unset name or an assignment, and the generated allowlist then omits the
// interpreter and blocks the launch.
function envInterpreterOperand(tokens: ReadonlyArray<string>): string | undefined {
  // These carry a separate operand that is not the interpreter. `-S` and
  // `--split-string` are excluded on purpose: their operand opens the command.
  const optionsTakingOperand = new Set(["-u", "--unset", "-P", "-C", "--chdir"]);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    index += optionsTakingOperand.has(token) ? 2 : 1;
  }
  // An assignment can only precede the interpreter, never follow it.
  while (index < tokens.length && /^[^=/\s]+=/.test(tokens[index]!)) index += 1;
  return tokens[index];
}

function resolveOnSearchPath(program: string, searchPath: string | undefined): string | undefined {
  if (program.includes("/")) return isAbsolute(program) ? program : undefined;
  for (const directory of (searchPath ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, program);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

export function privateHomeDenyReadRules(
  input: PrivateHomeDenyReadRulesInput,
): ReadonlyArray<string> {
  const home = realpathSync(input.homeDirectory ?? homedir());
  const users = realpathSync(input.usersDirectory ?? dirname(home));
  const allowed = [
    ...new Set(
      input.allowedPaths.filter((path) => existsSync(path)).map((path) => realpathSync(path)),
    ),
  ];
  const rules: string[] = [];
  const visit = (directory: string) => {
    const descendants = allowed.filter(
      (path) => path === directory || path.startsWith(`${directory}${sep}`),
    );
    if (descendants.some((path) => path === directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const childAllowed = descendants.some(
        (path) => path === child || path.startsWith(`${child}${sep}`),
      );
      if (!childAllowed) rules.push(seatbeltDenyRule("file-read*", child));
      else if (entry.isDirectory()) visit(child);
      if (rules.length > MAX_PRIVATE_DENY_RULES) {
        throw new SeatbeltConfinementError(
          "incompatible",
          "Seatbelt private-path confinement profile is too large.",
        );
      }
    }
  };
  visit(users);
  return rules;
}

export function buildDenyDefaultSeatbeltProfile(input: SeatbeltProfileInput): string {
  assertAbsolute(input.boundRoot, "bound root");
  assertAbsolute(input.temporaryDirectory, "temporary directory");
  const additionalWriteRoots = input.additionalWriteRoots ?? [];
  for (const path of additionalWriteRoots) assertAbsolute(path, "additional write root");
  const readRoots = input.readRoots ?? [];
  for (const path of readRoots) assertAbsolute(path, "read root");
  // Seatbelt is last-match-wins and the launch-root allow rules below are
  // emitted after the DEFAULT_DENY_READ_PATHS deny rules. A root equal to or
  // an ancestor of a denied path (e.g. /Library, /private, or /) would win
  // and reopen the whole denied subtree, including /Library/Keychains, so
  // every launch root must be refused before it reaches that allow list.
  // Descendants (the temporary directory always resolves under
  // /private/var) are unaffected and stay allowed.
  for (const path of [
    ...readRoots,
    input.boundRoot,
    input.temporaryDirectory,
    ...additionalWriteRoots,
  ]) {
    assertNotAncestorOfDeniedPath(path, "launch root");
  }

  const writeBoundRoot = input.writeBoundRoot !== false;
  const allowProcessExec = input.allowProcessExec !== false;
  const allowProcessFork = input.allowProcessFork !== false;
  // The sensitive boundary is not a default a caller can swap out. It was
  // reachable as `denyReadPaths`, where an empty array replaced every entry and
  // left `allowFileReadStar` granting the Keychain and the rest of the private
  // system state. Callers extend the boundary through `additionalDenyReadPaths`
  // and never narrow it.
  const denyReadPaths = [...DEFAULT_DENY_READ_PATHS, ...(input.additionalDenyReadPaths ?? [])];
  for (const path of input.additionalDenyReadPaths ?? [])
    assertAbsolute(path, "additional deny read path");
  const additionalDenyWritePaths = input.additionalDenyWritePaths ?? [];
  for (const path of additionalDenyWritePaths) assertAbsolute(path, "additional deny write path");
  const privateAllowPaths = input.privateHomeAllowPaths ?? [
    input.boundRoot,
    input.temporaryDirectory,
    ...additionalWriteRoots,
    ...readRoots,
  ];

  const privateRules =
    privateAllowPaths.length === 0
      ? []
      : privateHomeDenyReadRules({
          allowedPaths: privateAllowPaths,
          ...(input.homeDirectory === undefined ? {} : { homeDirectory: input.homeDirectory }),
          ...(input.usersDirectory === undefined ? {} : { usersDirectory: input.usersDirectory }),
        });

  const lines = [
    "(version 1)",
    "(deny default)",
    ...(allowProcessExec
      ? ["(allow process-exec)"]
      : uniqueAbsolutePaths(input.execAllowPaths ?? []).map(seatbeltExecRule)),
    ...(allowProcessFork ? ["(allow process-fork)"] : []),
    "(allow signal (target self))",
    "(allow sysctl-read)",
    ...(input.networkEgress === "allow" ? ["(allow network*)"] : []),
    ...(input.allowFileReadStar === true ? ["(allow file-read*)"] : []),
    ...denyReadPaths.map((path) => seatbeltDenyRule("file-read*", path)),
    ...privateRules,
    // The launch roots are re-allowed under every denial above, `file-read*`
    // included. Skipping them there left the `/private` denial covering the
    // temporary directory, which macOS resolves beneath `/private/var`, so the
    // broad-read escape hatch that exists for Git and provider CLIs took away
    // the one directory those runtimes always need.
    ...uniqueAbsolutePaths([
      ...readRoots,
      input.boundRoot,
      input.temporaryDirectory,
      ...additionalWriteRoots,
    ]).map((path) => seatbeltAllowRule("file-read*", path)),
    ...(writeBoundRoot ? [seatbeltAllowRule("file-write*", input.boundRoot)] : []),
    seatbeltAllowRule("file-write*", input.temporaryDirectory),
    ...additionalDenyWritePaths.map((path) => seatbeltDenyRule("file-write*", path)),
    ...additionalWriteRoots.map((path) => seatbeltAllowRule("file-write*", path)),
    '(allow file-write-data (literal "/dev/null"))',
    ...(input.extraRules ?? []),
  ];
  return lines.join("\n");
}

export function wrapCommandInSandboxExec(
  input: WrapCommandInSandboxExecInput,
): ConfinedProcessLaunch {
  if (!isAbsolute(input.sandboxPath)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Seatbelt sandbox-exec path must be absolute.",
    );
  }
  if (!isAbsolute(input.executable)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Seatbelt-confined executable path must be absolute.",
    );
  }
  const profile = input.profile.endsWith("\n") ? input.profile : `${input.profile}\n`;
  return {
    command: input.sandboxPath,
    args: ["-p", profile, "--", input.executable, ...input.args],
  };
}

export function requireSandboxExec(input: RequireSandboxExecInput): void {
  if (input.platform !== "darwin") {
    throw new SeatbeltConfinementError(
      "incompatible",
      "Seatbelt confinement requires the macOS sandbox-exec runtime.",
    );
  }
  if (!isAbsolute(input.sandboxPath)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Seatbelt sandbox-exec path must be absolute.",
    );
  }
  try {
    accessSync(input.sandboxPath, constants.X_OK);
  } catch {
    throw new SeatbeltConfinementError(
      "incompatible",
      "Seatbelt confinement requires an executable sandbox-exec.",
    );
  }
}

export function makeSeatbeltConfinementLive(
  options: SeatbeltConfinementOptions = {},
): SeatbeltConfinementPort {
  const platform = options.platform ?? process.platform;
  const sandboxPath =
    options.sandboxPath ?? (platform === "darwin" ? DEFAULT_SANDBOX_PATH : DEFAULT_BWRAP_PATH);
  return {
    prepare: (input) => {
      if (platform === "darwin") {
        return prepareDarwinSeatbelt(input, { ...options, sandboxPath });
      }
      if (platform === "linux") {
        return buildLinuxConfinementLaunch(input, { bwrapPath: sandboxPath });
      }
      throw new SeatbeltConfinementError(
        "incompatible",
        "Confinement is supported only on macOS and Linux.",
      );
    },
  };
}

function prepareDarwinSeatbelt(
  input: SeatbeltConfinementPrepareInput,
  options: SeatbeltConfinementOptions,
): ConfinedProcessLaunch {
  const sandboxPath = options.sandboxPath ?? DEFAULT_SANDBOX_PATH;
  requireSandboxExec({ platform: "darwin", sandboxPath });
  const privateHomeAllowPaths = input.privateHomeAllowPaths ?? [
    input.boundRoot,
    input.temporaryDirectory,
    ...(input.additionalWriteRoots ?? []),
    ...(input.readRoots ?? []),
  ];
  const profile = buildDenyDefaultSeatbeltProfile({
    boundRoot: input.boundRoot,
    temporaryDirectory: input.temporaryDirectory,
    networkEgress: input.networkEgress,
    ...(input.additionalWriteRoots === undefined
      ? {}
      : { additionalWriteRoots: input.additionalWriteRoots }),
    ...(input.readRoots === undefined ? {} : { readRoots: input.readRoots }),
    ...(input.allowProcessExec === undefined ? {} : { allowProcessExec: input.allowProcessExec }),
    ...(input.allowProcessExec === false
      ? {
          execAllowPaths: confinedExecutableExecPaths(
            input.executable,
            options.interpreterSearchPath ?? process.env.PATH,
          ),
        }
      : {}),
    ...(input.allowProcessFork === undefined ? {} : { allowProcessFork: input.allowProcessFork }),
    ...(input.allowFileReadStar === undefined
      ? {}
      : { allowFileReadStar: input.allowFileReadStar }),
    ...(input.writeBoundRoot === undefined ? {} : { writeBoundRoot: input.writeBoundRoot }),
    ...(input.additionalDenyReadPaths === undefined
      ? {}
      : { additionalDenyReadPaths: input.additionalDenyReadPaths }),
    ...(input.additionalDenyWritePaths === undefined
      ? {}
      : { additionalDenyWritePaths: input.additionalDenyWritePaths }),
    privateHomeAllowPaths,
    ...(input.extraRules === undefined ? {} : { extraRules: input.extraRules }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    ...(options.usersDirectory === undefined ? {} : { usersDirectory: options.usersDirectory }),
  });
  return wrapCommandInSandboxExec({
    sandboxPath,
    profile,
    executable: input.executable,
    args: input.args,
  });
}

function assertAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      `Seatbelt ${label} must be an absolute path.`,
    );
  }
}

function assertNotAncestorOfDeniedPath(path: string, label: string): void {
  const prefix = path.endsWith(sep) ? path : `${path}${sep}`;
  for (const denied of DEFAULT_DENY_READ_PATHS) {
    if (path === denied || denied.startsWith(prefix)) {
      throw new SeatbeltConfinementError(
        "invalid-configuration",
        `Seatbelt ${label} "${path}" is equal to or an ancestor of the denied sensitive path "${denied}"; its read-allow rule would be emitted after that denial and reopen the whole subtree.`,
      );
    }
  }
}

function uniqueAbsolutePaths(paths: ReadonlyArray<string>): string[] {
  return [...new Set(paths)];
}

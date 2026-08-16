/**
 * Shared macOS Seatbelt profile builder for Octant-spawned tool and provider
 * subprocesses.
 *
 * Tool launchers that execute arbitrary code — Code terminal shells
 * (`terminalProcessPort`; design doc historically named `shellService`), the
 * project-confined test runner, and Git helpers — must prepare launches through
 * this module so profiles cannot drift. Missing `sandbox-exec` fails closed;
 * there is no unconfined fallback.
 *
 * Network egress is materialized as OS `none` | `allow` only. The finer
 * `provider-endpoints-only` host allowlist is enforced by Octant-owned
 * brokered tools, not by a local egress proxy in V1.
 *
 * Native macOS sandbox-exec probes remain packaged/native validation evidence;
 * Linux CI unit-tests profile string generation and egress mapping.
 */
import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
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
  readonly allowFileReadStar?: boolean;
  readonly writeBoundRoot?: boolean;
  readonly denyReadPaths?: ReadonlyArray<string>;
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
  readonly allowProcessFork?: boolean;
  readonly allowFileReadStar?: boolean;
  readonly writeBoundRoot?: boolean;
  readonly privateHomeAllowPaths?: ReadonlyArray<string>;
  readonly extraRules?: ReadonlyArray<string>;
}

export interface SeatbeltConfinementPort {
  readonly prepare: (input: SeatbeltConfinementPrepareInput) => ConfinedProcessLaunch;
}

export interface SeatbeltConfinementOptions {
  readonly platform?: NodeJS.Platform;
  readonly sandboxPath?: string;
  readonly homeDirectory?: string;
  readonly usersDirectory?: string;
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
const DEFAULT_DENY_READ_PATHS = ["/Volumes", "/Network"] as const;
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

  const writeBoundRoot = input.writeBoundRoot !== false;
  const allowProcessExec = input.allowProcessExec !== false;
  const allowProcessFork = input.allowProcessFork !== false;
  const denyReadPaths = input.denyReadPaths ?? [...DEFAULT_DENY_READ_PATHS];
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
    ...(allowProcessExec ? ["(allow process-exec)"] : []),
    ...(allowProcessFork ? ["(allow process-fork)"] : []),
    "(allow signal (target self))",
    "(allow sysctl-read)",
    ...(input.networkEgress === "allow" ? ["(allow network*)"] : []),
    ...(input.allowFileReadStar === true ? ["(allow file-read*)"] : []),
    ...denyReadPaths.map((path) => seatbeltDenyRule("file-read*", path)),
    ...privateRules,
    ...uniqueAbsolutePaths([
      ...readRoots,
      ...(input.allowFileReadStar === true
        ? []
        : [input.boundRoot, input.temporaryDirectory, ...additionalWriteRoots]),
    ]).map((path) => seatbeltAllowRule("file-read*", path)),
    ...(writeBoundRoot ? [seatbeltAllowRule("file-write*", input.boundRoot)] : []),
    seatbeltAllowRule("file-write*", input.temporaryDirectory),
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
  const sandboxPath = options.sandboxPath ?? DEFAULT_SANDBOX_PATH;
  return {
    prepare: (input) => {
      requireSandboxExec({ platform, sandboxPath });
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
        ...(input.allowProcessFork === undefined
          ? {}
          : { allowProcessFork: input.allowProcessFork }),
        ...(input.allowFileReadStar === undefined
          ? {}
          : { allowFileReadStar: input.allowFileReadStar }),
        ...(input.writeBoundRoot === undefined ? {} : { writeBoundRoot: input.writeBoundRoot }),
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
    },
  };
}

function assertAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      `Seatbelt ${label} must be an absolute path.`,
    );
  }
}

function uniqueAbsolutePaths(paths: ReadonlyArray<string>): string[] {
  return [...new Set(paths)];
}

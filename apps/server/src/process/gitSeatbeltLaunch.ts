import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  makeSeatbeltConfinementLive,
  SeatbeltConfinementError,
  type ConfinedProcessLaunch,
  type SeatbeltConfinementPort,
  seatbeltAllowRule,
  seatbeltAllowLiteralMetadataRule,
} from "./seatbeltProfile";
import type { OsNetworkEgress } from "./threadEgressPolicy";

export interface GitSeatbeltLaunchOptions {
  readonly confinement: SeatbeltConfinementPort;
  /**
   * The platform `confinement` confines for, which is the dialect these rules
   * have to be written in — not the platform this process happens to run on.
   * Deriving it from the host emits Seatbelt literals into a Bubblewrap
   * launch, which refuses any rule it cannot express, so the launch fails
   * before it runs. Callers take it from `createGitSeatbeltConfinement`, which
   * resolved it for the port it built.
   */
  readonly platform: NodeJS.Platform;
  readonly gitExecutable: string;
  readonly checkoutRoot: string;
  readonly args: ReadonlyArray<string>;
  readonly temporaryDirectory: string;
  readonly networkEgress: OsNetworkEgress;
  /**
   * Whether this launch may write the out-of-root worktree metadata. It
   * defaults to **false**: these rules are appended last and Seatbelt resolves
   * by last matching rule, so a write allow emitted here outranks whatever
   * posture the caller set on the launch itself — including Plan's, which 0009
   * keeps read-only always. A caller that genuinely writes that metadata opts
   * in and says why; a caller that forgets is confined rather than widened.
   */
  readonly writable?: boolean;
  /**
   * Directories this launch may write besides the bound root.
   *
   * Naming one is not only a permission. On Linux a shared host temporary root
   * is replaced by a private tmpfs rather than bound, so a directory the caller
   * created under it does not exist for the confined process at all until it is
   * named here. Mounts are applied shallowest first, so the bind lands inside
   * that tmpfs.
   */
  readonly additionalWriteRoots?: ReadonlyArray<string>;
}

export interface GitSeatbeltPortOptions {
  readonly confinement?: SeatbeltConfinementPort;
  readonly platform?: NodeJS.Platform;
  readonly sandboxPath?: string;
  readonly gitExecutable?: string;
  readonly temporaryDirectory?: string;
  readonly networkEgress?: OsNetworkEgress;
  readonly seatbeltHomeDirectory?: string;
  readonly seatbeltUsersDirectory?: string;
}

export function resolveGitExecutable(
  explicit?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const candidate = explicit ?? (platform === "darwin" ? developerGitExecutable() : "/usr/bin/git");
  if (!isAbsolute(candidate)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Git executable path must be absolute for Seatbelt confinement.",
    );
  }
  return candidate;
}

let developerGit: string | undefined;

// `/usr/bin/git` on macOS is the Xcode shim. Inside Seatbelt it cannot write
// its xcrun cache, so it re-runs xcodebuild on every call (seconds per
// command). Resolve the real toolchain binary once, outside the sandbox.
function developerGitExecutable(): string {
  if (developerGit !== undefined) return developerGit;
  developerGit = "/usr/bin/git";
  try {
    const found = execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (isAbsolute(found) && found !== "/usr/bin/git" && existsSync(found)) developerGit = found;
  } catch {
    // Command Line Tools may be missing; the shim is still a valid fallback.
  }
  return developerGit;
}

/** Exact files the macOS git shim reads through xcode-select. Last-match extraRules. */
export const MACOS_GIT_SHIM_READ_PATHS = [
  "/private/var/select/developer_dir",
  "/private/var/db/xcode_select_link",
] as const;

export function gitShimExtraRules(platform: NodeJS.Platform): ReadonlyArray<string> {
  if (platform !== "darwin") return [];
  return MACOS_GIT_SHIM_READ_PATHS.map((path) => `(allow file-read* (literal "${path}"))`);
}

export interface GitLinkedWorktreeMetadataOptions {
  /**
   * Whether the launch may write the out-of-root metadata. Staging, committing
   * and checkpoint restore do; observing history does not. It defaults to
   * false because these rules are appended last, and Seatbelt resolves by last
   * matching rule: a write allow here overrides a caller's own write deny on
   * the same path, so a launch that asked to stay read-only would silently
   * receive write authority over the parent repository's entire .git — refs,
   * objects and hooks included.
   */
  readonly writable?: boolean;
}

/**
 * A linked worktree's .git file points at the main repository's
 * .git/worktrees/<name>, outside the bound root. Allow that metadata and its
 * commondir so git can see it is a repository, without opening the parent
 * working tree.
 */
export function gitLinkedWorktreeMetadataRules(
  checkoutRoot: string,
  options: GitLinkedWorktreeMetadataOptions = {},
): ReadonlyArray<string> {
  let gitdir: string | undefined;
  try {
    const text = readFileSync(join(checkoutRoot, ".git"), "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    const raw = match?.[1];
    if (raw === undefined || raw === "") return [];
    gitdir = isAbsolute(raw) ? raw : join(checkoutRoot, raw);
  } catch {
    return [];
  }
  const roots = [gitdir];
  try {
    const common = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    if (common !== "") roots.push(isAbsolute(common) ? common : join(gitdir, common));
  } catch {
    // Ordinary repositories have no commondir file.
  }
  return roots.flatMap((path) => [
    seatbeltAllowRule("file-read*", path),
    ...(options.writable === true ? [seatbeltAllowRule("file-write*", path)] : []),
    ...ancestorMetadataRules(path),
  ]);
}

/**
 * Metadata for every ancestor directory of an out-of-root metadata path.
 *
 * Git canonicalises these paths component by component, and the rules above
 * allow each path as a subtree — which says nothing about the directories
 * above it. Under the profile's `/private` and home denies the walk stops at
 * the first ancestor it cannot stat (`fatal: Invalid path '/private':
 * Operation not permitted`) and the confined command never reaches the
 * repository.
 */
function ancestorMetadataRules(path: string): ReadonlyArray<string> {
  const rules: string[] = [];
  let directory = dirname(path);
  while (directory !== "/" && directory !== dirname(directory)) {
    rules.push(seatbeltAllowLiteralMetadataRule(directory));
    directory = dirname(directory);
  }
  return rules;
}

export function createGitSeatbeltConfinement(options: GitSeatbeltPortOptions = {}): {
  readonly confinement: SeatbeltConfinementPort;
  readonly platform: NodeJS.Platform;
  readonly gitExecutable: string;
  readonly temporaryDirectory: string;
  readonly networkEgress: OsNetworkEgress;
} {
  const platform = options.platform ?? process.platform;
  return {
    platform,
    confinement:
      options.confinement ??
      makeSeatbeltConfinementLive({
        platform,
        ...(options.sandboxPath === undefined ? {} : { sandboxPath: options.sandboxPath }),
        ...(options.seatbeltHomeDirectory === undefined
          ? {}
          : { homeDirectory: options.seatbeltHomeDirectory }),
        ...(options.seatbeltUsersDirectory === undefined
          ? {}
          : { usersDirectory: options.seatbeltUsersDirectory }),
      }),
    gitExecutable: resolveGitExecutable(options.gitExecutable, platform),
    temporaryDirectory:
      options.temporaryDirectory ??
      process.env.TMPDIR ??
      process.env.TMP ??
      process.env.TEMP ??
      "/tmp",
    networkEgress: options.networkEgress ?? "allow",
  };
}

export function prepareGitSeatbeltLaunch(options: GitSeatbeltLaunchOptions): ConfinedProcessLaunch {
  if (!isAbsolute(options.checkoutRoot)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Git checkout root must be absolute for Seatbelt confinement.",
    );
  }
  const binaryDirectory = dirname(options.gitExecutable);
  const extraRules = [
    ...gitShimExtraRules(options.platform),
    ...gitLinkedWorktreeMetadataRules(options.checkoutRoot, {
      writable: options.writable ?? false,
    }),
  ];
  return options.confinement.prepare({
    executable: options.gitExecutable,
    args: options.args,
    boundRoot: options.checkoutRoot,
    temporaryDirectory: options.temporaryDirectory,
    networkEgress: options.networkEgress,
    allowFileReadStar: true,
    readRoots: [
      options.checkoutRoot,
      options.temporaryDirectory,
      binaryDirectory,
      dirname(binaryDirectory),
    ],
    ...(options.additionalWriteRoots === undefined
      ? {}
      : { additionalWriteRoots: options.additionalWriteRoots }),
    ...(extraRules.length === 0 ? {} : { extraRules }),
  });
}

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

export interface GitLinkedWorktreeMetadataPaths {
  /** Out-of-root directories git has to read to see a linked worktree. */
  readonly readPaths: ReadonlyArray<string>;
  /** The same paths when the launch may write refs and objects. */
  readonly writePaths: ReadonlyArray<string>;
}

/**
 * A linked worktree's .git file points at the main repository's
 * .git/worktrees/<name>, outside the bound root. Resolve that gitdir and its
 * commondir as plain paths so each confinement backend can translate them:
 * Seatbelt writes them as rules, Bubblewrap binds them directly — its mounts
 * create the bind-target ancestors the Darwin profile has to spell out.
 *
 * The marker is a file anyone with write access to the checkout can rewrite,
 * so only Git's reciprocal linked-worktree record earns an out-of-root grant:
 * the pointer has to land inside a "worktrees" directory, that gitdir has to
 * carry a "gitdir" file pointing back at this marker, and its "commondir" has
 * to resolve to the main repository's .git. This is the same proof
 * gitHistoryMetadata requires; without it a rewritten marker could name any
 * existing directory and the confinement layer would expose it — writable for
 * a mutation launch — outside the authorized checkout.
 */
export function gitLinkedWorktreeMetadataPaths(
  checkoutRoot: string,
  options: GitLinkedWorktreeMetadataOptions = {},
): GitLinkedWorktreeMetadataPaths {
  try {
    const marker = join(checkoutRoot, ".git");
    const stat = lstatSync(marker);
    if (stat.isSymbolicLink() || !stat.isFile()) return { readPaths: [], writePaths: [] };
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(marker, "utf8"));
    const raw = match?.[1];
    if (raw === undefined || raw === "") return { readPaths: [], writePaths: [] };
    const gitdir = realpathSync(isAbsolute(raw) ? raw : resolve(checkoutRoot, raw));
    if (basename(dirname(gitdir)) !== "worktrees") return { readPaths: [], writePaths: [] };
    const backlink = realpathSync(resolve(gitdir, readGitPointerSync(join(gitdir, "gitdir"))));
    if (backlink !== realpathSync(marker)) return { readPaths: [], writePaths: [] };
    const commonDirectory = realpathSync(
      resolve(gitdir, readGitPointerSync(join(gitdir, "commondir"))),
    );
    if (commonDirectory !== dirname(dirname(gitdir))) return { readPaths: [], writePaths: [] };
    const roots = [gitdir, commonDirectory];
    return {
      readPaths: roots,
      writePaths: options.writable === true ? roots : [],
    };
  } catch {
    return { readPaths: [], writePaths: [] };
  }
}

function readGitPointerSync(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid Git metadata pointer");
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(4097);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("Oversized Git metadata pointer");
    return bytes.subarray(0, bytesRead).toString("utf8").trimEnd();
  } finally {
    closeSync(fd);
  }
}

/**
 * Seatbelt form of `gitLinkedWorktreeMetadataPaths`: subtree rules plus the
 * ancestor metadata entries the Darwin profile needs for the path walk.
 */
export function gitLinkedWorktreeMetadataRules(
  checkoutRoot: string,
  options: GitLinkedWorktreeMetadataOptions = {},
): ReadonlyArray<string> {
  const metadata = gitLinkedWorktreeMetadataPaths(checkoutRoot, options);
  return metadata.readPaths.flatMap((path) => [
    seatbeltAllowRule("file-read*", path),
    ...(metadata.writePaths.includes(path) ? [seatbeltAllowRule("file-write*", path)] : []),
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
  const writable = options.writable ?? false;
  const linkedMetadata = gitLinkedWorktreeMetadataPaths(options.checkoutRoot, { writable });
  const extraRules =
    options.platform === "darwin"
      ? [
          ...gitShimExtraRules(options.platform),
          ...gitLinkedWorktreeMetadataRules(options.checkoutRoot, { writable }),
        ]
      : [];
  // A bind target that does not exist refuses the whole launch on Linux, so
  // only paths the filesystem confirmed are offered to it.
  const bindableReadPaths = linkedMetadata.readPaths.filter(existsSync);
  const bindableWritePaths = linkedMetadata.writePaths.filter(existsSync);
  const additionalWriteRoots = [
    ...(options.additionalWriteRoots ?? []),
    ...(options.platform === "darwin" ? [] : bindableWritePaths),
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
      // On non-Seatbelt backends the same metadata is a bind, not a rule:
      // Bubblewrap creates the mount's ancestors itself.
      ...(options.platform === "darwin" ? [] : bindableReadPaths),
    ],
    ...(additionalWriteRoots.length === 0 ? {} : { additionalWriteRoots }),
    ...(extraRules.length === 0 ? {} : { extraRules }),
  });
}

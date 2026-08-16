import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  makeSeatbeltConfinementLive,
  SeatbeltConfinementError,
  type ConfinedProcessLaunch,
  type SeatbeltConfinementPort,
} from "./seatbeltProfile";
import type { OsNetworkEgress } from "./threadEgressPolicy";

export interface GitSeatbeltLaunchOptions {
  readonly confinement: SeatbeltConfinementPort;
  readonly gitExecutable: string;
  readonly checkoutRoot: string;
  readonly args: ReadonlyArray<string>;
  readonly temporaryDirectory: string;
  readonly networkEgress: OsNetworkEgress;
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

export interface GitGlobalConfigReadRootsOptions {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Reads a config file for include resolution; undefined when unreadable. */
  readonly readConfig?: (path: string) => string | undefined;
}

// Git treats a permission error on its global config as fatal, so the
// confinement must let it read the user's own Git config even though the
// rest of the home directory stays private. Files pulled in through
// `[include]`/`[includeIf]` are part of that config and denied the same way,
// so they are followed to a bounded depth.
export function gitGlobalConfigReadRoots(
  options: GitGlobalConfigReadRootsOptions = {},
): ReadonlyArray<string> {
  const home = options.home ?? homedir();
  const xdgConfigHome = (options.env ?? process.env).XDG_CONFIG_HOME;
  const readConfig = options.readConfig ?? readConfigFile;
  const roots = [
    join(home, ".gitconfig"),
    join(
      xdgConfigHome !== undefined && isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : join(home, ".config"),
      "git",
    ),
  ];
  const visited = new Set<string>();
  const included: string[] = [];
  const visit = (file: string, depth: number) => {
    if (depth > MAX_GIT_CONFIG_INCLUDE_DEPTH || visited.has(file)) return;
    visited.add(file);
    const text = readConfig(file);
    if (text === undefined) return;
    for (const path of gitConfigIncludePaths(text, dirname(file), home)) {
      if (!roots.includes(path) && !included.includes(path)) included.push(path);
      visit(path, depth + 1);
    }
  };
  visit(roots[0]!, 0);
  visit(join(roots[1]!, "config"), 0);
  return [...roots, ...included];
}

const MAX_GIT_CONFIG_INCLUDE_DEPTH = 4;

function readConfigFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `path` values under `[include]` / `[includeIf "..."]`, resolved like Git does. */
export function gitConfigIncludePaths(
  text: string,
  configDirectory: string,
  home: string,
): ReadonlyArray<string> {
  const paths: string[] = [];
  let inInclude = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s+/, "");
    if (line.startsWith("[")) {
      inInclude = /^\[\s*include(?:if\b|\s*\])/i.test(line);
      continue;
    }
    if (!inInclude) continue;
    const match = /^path\s*=\s*(.+?)\s*$/i.exec(line);
    if (match === null) continue;
    const value = match[1]!.replace(/^"(.*)"$/, "$1");
    if (value === "") continue;
    const expanded = value.startsWith("~/") ? join(home, value.slice(2)) : value;
    paths.push(isAbsolute(expanded) ? expanded : join(configDirectory, expanded));
  }
  return paths;
}

export function createGitSeatbeltConfinement(options: GitSeatbeltPortOptions = {}): {
  readonly confinement: SeatbeltConfinementPort;
  readonly gitExecutable: string;
  readonly temporaryDirectory: string;
  readonly networkEgress: OsNetworkEgress;
} {
  const platform = options.platform ?? process.platform;
  return {
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
      ...gitGlobalConfigReadRoots(),
    ],
  });
}

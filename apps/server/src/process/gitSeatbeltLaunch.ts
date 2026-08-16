import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

// Git treats a permission error on its global config as fatal, so the
// confinement must let it read the user's own Git config even though the
// rest of the home directory stays private.
export function gitGlobalConfigReadRoots(
  home: string = homedir(),
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
): ReadonlyArray<string> {
  return [
    join(home, ".gitconfig"),
    join(
      xdgConfigHome !== undefined && isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : join(home, ".config"),
      "git",
    ),
  ];
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

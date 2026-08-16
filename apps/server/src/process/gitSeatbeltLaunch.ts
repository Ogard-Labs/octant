import { dirname, isAbsolute } from "node:path";
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

export function resolveGitExecutable(explicit?: string): string {
  const candidate = explicit ?? "/usr/bin/git";
  if (!isAbsolute(candidate)) {
    throw new SeatbeltConfinementError(
      "invalid-configuration",
      "Git executable path must be absolute for Seatbelt confinement.",
    );
  }
  return candidate;
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
    gitExecutable: resolveGitExecutable(options.gitExecutable),
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
    ],
  });
}

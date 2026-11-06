import { isAbsolute, join, resolve } from "node:path";
import {
  desktopWindowStorageDirectory,
  readStoredDesktopDataChoice,
  resolveDesktopHostRole,
  type DesktopDataChoice,
  type DesktopIdentity,
} from "@octant/host-runtime";

/**
 * Which host this command-line tool talks to, decided once at startup.
 *
 * `octant` owns its host and may start it. `octant-nightly` attaches to
 * Octant's host on the person's real data and never starts, stops or migrates
 * a host there. When Nightly's stored Data choice is Separate test data, it
 * attaches to Nightly's own test host instead, on its folder and port.
 */
export type CliHostTarget =
  | {
      readonly kind: "own-host";
      readonly environment: Readonly<Record<string, string | undefined>>;
    }
  | {
      readonly kind: "octant-host";
      readonly environment: Readonly<Record<string, string | undefined>>;
    }
  | {
      readonly kind: "test-host";
      readonly environment: Readonly<Record<string, string | undefined>>;
      readonly serverPort: number;
    }
  | { readonly kind: "refused"; readonly message: string };

export interface CliHostLocation {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads the stored Data choice; tests replace the file read. */
  readonly readDataChoice?: (windowStorageDirectory: string) => DesktopDataChoice;
}

export function resolveCliHostTarget(
  identity: DesktopIdentity,
  location: CliHostLocation,
): CliHostTarget {
  if (identity.mayStartHost) return { kind: "own-host", environment: location.env };
  // An explicit data folder is the developer's own choice, as for `octant`;
  // the stored choice is not read and nothing about the folder is assumed.
  if (location.env.OCTANT_DATA_DIR !== undefined && location.env.OCTANT_DATA_DIR !== "")
    return { kind: "octant-host", environment: location.env };
  const readChoice = location.readDataChoice ?? readStoredDesktopDataChoice;
  let choice: DesktopDataChoice;
  try {
    choice = readChoice(
      desktopWindowStorageDirectory(identity, "", desktopAppDataDirectory(location)),
    );
  } catch {
    choice = "octant";
  }
  if (choice !== "test-data") return { kind: "octant-host", environment: location.env };
  if (location.platform !== "darwin")
    return {
      kind: "refused",
      message: `${identity.productName}'s separate test data is available on macOS only. Set Data to Octant's data in ${identity.productName}'s Settings to use ${identity.commandName} with Octant.`,
    };
  const role = resolveDesktopHostRole(identity, choice, location);
  if (role.kind !== "test-host") return { kind: "octant-host", environment: location.env };
  const explicitPort = location.env.OCTANT_SERVER_PORT;
  const serverPort =
    explicitPort !== undefined && /^\d+$/.test(explicitPort)
      ? Number(explicitPort)
      : role.serverPort;
  return {
    kind: "test-host",
    serverPort,
    environment: {
      ...location.env,
      OCTANT_DATA_DIR: role.dataDirectory,
      OCTANT_SERVER_PORT: String(serverPort),
    },
  };
}

/** Electron's appData folder, where each desktop app keeps its window storage. */
export function desktopAppDataDirectory(location: {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string {
  if (location.platform === "darwin") return join(location.home, "Library", "Application Support");
  const xdg = location.env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg !== "" && isAbsolute(xdg)
    ? resolve(xdg)
    : join(location.home, ".config");
}

/** Why a command found no host, in the words of the host this tool attaches to. */
export function hostNotRunningMessage(identity: DesktopIdentity, target: CliHostTarget): string {
  if (target.kind === "test-host")
    return `${identity.productName}'s test host is not running. Open ${identity.productName} with Data set to Separate test data to start it; ${identity.commandName} never starts a host.`;
  return `Octant is not running on this host. Open Octant, or start its host with \`octant server start\`; ${identity.commandName} never starts a host on Octant's data.`;
}

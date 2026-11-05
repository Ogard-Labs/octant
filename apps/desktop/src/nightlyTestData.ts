import { closeSync, constants, openSync, readSync } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  DESKTOP_DATA_CHOICE_FILE,
  decodeDesktopDataChoice,
  desktopDataDirectoriesOverlap,
  encodeDesktopDataChoice,
  resolveDesktopHostRole,
  type DesktopDataChoice,
  type DesktopHostRole,
  type DesktopIdentity,
} from "@octant/host-runtime";
import type { KeychainServiceFamily } from "./keychainCredentialStore";

const MAX_CHOICE_BYTES = 1_024;

/**
 * Reads the Data choice from Nightly's window storage at startup. A missing,
 * oversized, linked or unreadable file is Octant's data, the safe default.
 */
export function readStoredDesktopDataChoice(windowStorageDirectory: string): DesktopDataChoice {
  let descriptor: number;
  try {
    descriptor = openSync(
      join(windowStorageDirectory, DESKTOP_DATA_CHOICE_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return "octant";
  }
  try {
    const bytes = Buffer.alloc(MAX_CHOICE_BYTES + 1);
    const read = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (read > MAX_CHOICE_BYTES) return "octant";
    return decodeDesktopDataChoice(bytes.subarray(0, read).toString("utf8"));
  } catch {
    return "octant";
  } finally {
    closeSync(descriptor);
  }
}

/** Stores the choice for the next launch; the running process keeps its role. */
export async function storeDesktopDataChoice(
  windowStorageDirectory: string,
  choice: DesktopDataChoice,
): Promise<void> {
  await mkdir(windowStorageDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(windowStorageDirectory, `.data-choice-${randomUUID()}.json`);
  try {
    await writeFile(temporary, encodeDesktopDataChoice(choice), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(windowStorageDirectory, DESKTOP_DATA_CHOICE_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The Electron home that both apps' default data folders derive from. */
export function desktopHomeDirectory(appDataDirectory: string, platform: NodeJS.Platform): string {
  // Electron appData is ~/Library/Application Support on macOS and ~/.config on Linux.
  return platform === "darwin"
    ? resolve(appDataDirectory, "..", "..")
    : resolve(appDataDirectory, "..");
}

/** The process's host role, read once from the stored choice. */
export function resolveStartupHostRole(options: {
  readonly identity: DesktopIdentity;
  readonly windowStorageDirectory: string;
  readonly appDataDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}): DesktopHostRole {
  if (options.identity.testHost === null) return { kind: "octant-host" };
  return resolveDesktopHostRole(
    options.identity,
    readStoredDesktopDataChoice(options.windowStorageDirectory),
    {
      platform: options.platform,
      home: desktopHomeDirectory(options.appDataDirectory, options.platform),
      env: options.env,
    },
  );
}

export type HostOwningStartup =
  | {
      readonly kind: "start";
      /** Undefined keeps Octant's own default data folder. */
      readonly configuredDataDirectory: string | undefined;
      readonly serverPort: number | undefined;
      readonly logsDirectory: string | undefined;
      readonly keychainServiceFamily: KeychainServiceFamily;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * What the host-owning desktop may start. A Nightly process that reaches it
 * without a test-host role (its choice changed or became unreadable after the
 * entry read it) refuses: Nightly never falls back to Octant's data folder or
 * port. Linux refuses too, because its Secret Service items carry no store
 * scope and would be shared with Octant's. Only an explicit `OCTANT_DATA_DIR`,
 * a developer's own choice, bypasses the overlap refusal.
 */
export function resolveHostOwningStartup(options: {
  readonly identity: DesktopIdentity;
  readonly role: DesktopHostRole;
  readonly platform: NodeJS.Platform;
  readonly appDataDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): HostOwningStartup {
  const explicit = options.env.OCTANT_DATA_DIR;
  if (options.identity.testHost === null)
    return {
      kind: "start",
      configuredDataDirectory: explicit,
      serverPort: undefined,
      logsDirectory: undefined,
      keychainServiceFamily: "octant",
    };
  if (options.role.kind !== "test-host")
    return {
      kind: "refused",
      message:
        "Octant Nightly refused to start a host: separate test data is no longer selected. Open Octant Nightly again.",
    };
  if (options.platform !== "darwin")
    return {
      kind: "refused",
      message:
        "Octant Nightly refused to start its test host: separate test data is available on macOS only.",
    };
  const home = desktopHomeDirectory(options.appDataDirectory, options.platform);
  if (
    explicit === undefined &&
    desktopDataDirectoriesOverlap(options.role.dataDirectory, octantDefaultDataDirectory(home))
  )
    return {
      kind: "refused",
      message:
        "Octant Nightly refused to start its test host: its test data folder overlaps Octant's data folder.",
    };
  return {
    kind: "start",
    configuredDataDirectory: explicit ?? options.role.dataDirectory,
    serverPort: options.role.serverPort,
    logsDirectory: join(home, "Library", "Logs", options.identity.productName),
    keychainServiceFamily: options.role.keychainServiceFamily,
  };
}

/**
 * Octant's default macOS data folder, named without touching it: resolving it
 * through the host-runtime resolver would create the folder.
 */
function octantDefaultDataDirectory(home: string): string {
  return join(home, "Library", "Application Support", "Octant");
}

/** Separate test data is offered only where its credentials stay apart. */
export function nightlyTestDataSupported(
  identity: DesktopIdentity,
  platform: NodeJS.Platform,
): boolean {
  return identity.testHost !== null && platform === "darwin";
}

export type TestDataRemoval =
  | { readonly kind: "removed" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "refused";
      readonly reason: "test-host-running" | "not-nightly" | "unsafe-folder";
    }
  | { readonly kind: "failed" };

/**
 * Moves Nightly's test data folder to the Trash. Only while Nightly uses
 * Octant's data, so the test host is not running, and only the fixed folder
 * its identity names: no caller chooses what is removed.
 */
export async function removeNightlyTestData(options: {
  readonly role: DesktopHostRole;
  readonly identity: DesktopIdentity;
  readonly platform: NodeJS.Platform;
  readonly appDataDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly trashItem: (path: string) => Promise<void>;
}): Promise<TestDataRemoval> {
  if (options.role.kind === "test-host") return { kind: "refused", reason: "test-host-running" };
  if (
    options.role.kind !== "octant-client" ||
    !nightlyTestDataSupported(options.identity, options.platform)
  )
    return { kind: "refused", reason: "not-nightly" };
  const target = resolveDesktopHostRole(options.identity, "test-data", {
    platform: options.platform,
    home: desktopHomeDirectory(options.appDataDirectory, options.platform),
    env: options.env,
  });
  if (target.kind !== "test-host") return { kind: "refused", reason: "not-nightly" };
  const home = desktopHomeDirectory(options.appDataDirectory, options.platform);
  if (desktopDataDirectoriesOverlap(target.dataDirectory, octantDefaultDataDirectory(home)))
    return { kind: "refused", reason: "unsafe-folder" };
  let metadata;
  try {
    metadata = await lstat(target.dataDirectory);
  } catch {
    return { kind: "absent" };
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    return { kind: "refused", reason: "unsafe-folder" };
  try {
    await options.trashItem(target.dataDirectory);
    return { kind: "removed" };
  } catch {
    return { kind: "failed" };
  }
}

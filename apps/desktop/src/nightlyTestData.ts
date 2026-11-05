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

/**
 * Nightly's test host never shares Octant's folder. Only an explicit
 * `OCTANT_DATA_DIR`, a developer's own choice, bypasses this.
 */
export function refuseTestDataInsideOctantData(options: {
  readonly role: DesktopHostRole;
  readonly octantDataDirectory: string;
  readonly explicitDataDirectory: string | undefined;
}): { readonly kind: "apart" } | { readonly kind: "refused"; readonly message: string } {
  if (options.role.kind !== "test-host" || options.explicitDataDirectory !== undefined)
    return { kind: "apart" };
  return desktopDataDirectoriesOverlap(options.role.dataDirectory, options.octantDataDirectory)
    ? {
        kind: "refused",
        message:
          "Octant Nightly refused to start its test host: its test data folder overlaps Octant's data folder.",
      }
    : { kind: "apart" };
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
  readonly octantDataDirectory: string;
  readonly trashItem: (path: string) => Promise<void>;
}): Promise<TestDataRemoval> {
  if (options.role.kind === "test-host") return { kind: "refused", reason: "test-host-running" };
  if (options.role.kind !== "octant-client" || options.identity.testHost === null)
    return { kind: "refused", reason: "not-nightly" };
  const target = resolveDesktopHostRole(options.identity, "test-data", {
    platform: options.platform,
    home: desktopHomeDirectory(options.appDataDirectory, options.platform),
    env: options.env,
  });
  if (target.kind !== "test-host") return { kind: "refused", reason: "not-nightly" };
  if (desktopDataDirectoriesOverlap(target.dataDirectory, options.octantDataDirectory))
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

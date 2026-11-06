import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_FOLDER_ENVIRONMENT,
  DESKTOP_DATA_CHOICE_FILE,
  decodeOwnerReceipt,
  KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT,
  decodeDesktopDataChoice,
  desktopDataDirectoriesOverlap,
  encodeDesktopDataChoice,
  resolveDesktopHostRole,
  type DesktopDataChoice,
  type DesktopHostRole,
  type DesktopIdentity,
} from "@octant/host-runtime";
import type { NightlyDataState } from "@octant/contracts/app-updates";
import type { KeychainServiceFamily } from "./keychainCredentialStore";

const MAX_CHOICE_BYTES = 1_024;

/**
 * Reads the Data choice from Nightly's window storage at startup. A missing,
 * oversized, linked, non-regular or unreadable file is Octant's data, the safe
 * default. It opens without blocking, so a FIFO put there cannot hang launch.
 */
export function readStoredDesktopDataChoice(windowStorageDirectory: string): DesktopDataChoice {
  let descriptor: number;
  try {
    descriptor = openSync(
      join(windowStorageDirectory, DESKTOP_DATA_CHOICE_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return "octant";
  }
  try {
    if (!fstatSync(descriptor).isFile()) return "octant";
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
      /** Added to the host child's environment; empty for Octant. */
      readonly hostEnvironment: Readonly<Record<string, string>>;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * What the host-owning desktop may start. A Nightly process that reaches it
 * without a test-host role (its choice changed or became unreadable after the
 * entry read it) refuses: Nightly never falls back to Octant's data folder or
 * port. Only an explicit `OCTANT_DATA_DIR`, a developer's own choice, bypasses
 * the overlap refusal. On Linux its Secret Service items name their own
 * `service` values, because those items carry no store scope.
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
      hostEnvironment: {},
    };
  if (options.role.kind !== "test-host")
    return {
      kind: "refused",
      message:
        "Octant Nightly refused to start a host: separate test data is no longer selected. Open Octant Nightly again.",
    };
  if (options.platform !== "darwin" && options.platform !== "linux")
    return {
      kind: "refused",
      message:
        "Octant Nightly refused to start its test host: separate test data is available on macOS and Linux only.",
    };
  const home = desktopHomeDirectory(options.appDataDirectory, options.platform);
  if (
    explicit === undefined &&
    desktopDataDirectoriesOverlap(
      options.role.dataDirectory,
      octantDefaultDataDirectory(home, options.platform, options.env),
    )
  )
    return {
      kind: "refused",
      message:
        "Octant Nightly refused to start its test host: its test data folder overlaps Octant's data folder.",
    };
  const logsDirectory =
    options.platform === "darwin"
      ? join(home, "Library", "Logs", options.identity.productName)
      : join(
          xdgDirectory(options.env.XDG_STATE_HOME, home, ".local/state"),
          "octant-nightly",
          "logs",
        );
  return {
    kind: "start",
    configuredDataDirectory: explicit ?? options.role.dataDirectory,
    serverPort: options.role.serverPort,
    logsDirectory,
    keychainServiceFamily: options.role.keychainServiceFamily,
    // Its service log, Keychain names and default folder (`~/Octant Nightly`
    // for Work and Code without a Project and the artifact mirror) are its own.
    hostEnvironment: {
      OCTANT_LOGS_DIR: logsDirectory,
      [KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]: options.role.keychainServiceFamily,
      [DEFAULT_FOLDER_ENVIRONMENT]: join(home, options.identity.productName),
    },
  };
}

/**
 * Octant's default data folder, named without touching it: resolving it
 * through the host-runtime resolver would create the folder.
 */
function octantDefaultDataDirectory(
  home: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "Octant")
    : join(xdgDirectory(env.XDG_DATA_HOME, home, ".local/share"), "octant");
}

/** The same XDG rule the host-runtime path resolver applies. */
function xdgDirectory(value: string | undefined, home: string, fallback: string): string {
  return value !== undefined && value !== "" && value.trim() === value && isAbsolute(value)
    ? resolve(value)
    : join(home, fallback);
}

/** Separate test data is offered only where its credentials stay apart. */
export function nightlyTestDataSupported(
  identity: DesktopIdentity,
  platform: NodeJS.Platform,
): boolean {
  return identity.testHost !== null && (platform === "darwin" || platform === "linux");
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
  /**
   * Linux: removes the test host's Secret Service items, which live outside
   * the folder. Required there; Removal fails closed without it.
   */
  readonly clearTestDataSecrets?: () => Promise<void>;
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
  const octant = octantDefaultDataDirectory(home, options.platform, options.env);
  if (desktopDataDirectoriesOverlap(target.dataDirectory, octant))
    return { kind: "refused", reason: "unsafe-folder" };
  const clearSecrets = async (): Promise<boolean> => {
    if (options.platform !== "linux") return true;
    if (options.clearTestDataSecrets === undefined) return false;
    try {
      await options.clearTestDataSecrets();
      return true;
    } catch {
      return false;
    }
  };
  let metadata;
  try {
    metadata = await lstat(target.dataDirectory);
  } catch {
    // Test-data items can outlive their folder; they go as well.
    return (await clearSecrets()) ? { kind: "absent" } : { kind: "failed" };
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    return { kind: "refused", reason: "unsafe-folder" };
  // A linked ancestor would make the fixed name reach another folder.
  let real: string;
  try {
    real = await realpath(target.dataDirectory);
  } catch {
    return { kind: "refused", reason: "unsafe-folder" };
  }
  if (
    real !== resolve(target.dataDirectory) ||
    desktopDataDirectoriesOverlap(real, await realpath(octant).catch(() => octant))
  )
    return { kind: "refused", reason: "unsafe-folder" };
  // A client and the test host exclude each other through the single-instance
  // lock; a live owner receipt still refuses, for a host started another way.
  if (await testHostOwnerAlive(real)) return { kind: "refused", reason: "test-host-running" };
  // The items go first: a failure keeps the folder, so Remove can be retried.
  if (!(await clearSecrets())) return { kind: "failed" };
  try {
    await options.trashItem(target.dataDirectory);
    return { kind: "removed" };
  } catch {
    return { kind: "failed" };
  }
}

async function testHostOwnerAlive(dataDirectory: string): Promise<boolean> {
  let pid: number;
  try {
    pid = decodeOwnerReceipt(await readFile(join(dataDirectory, "run", "owner.json"), "utf8")).pid;
  } catch {
    // No receipt, or one no host could have written: nothing owns the folder.
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A relaunch asked for from Settings applies only to the quit it starts:
 * `app.relaunch()` runs once that quit is certain, and a cancelled quit
 * forgets the request, so a later ordinary quit does not relaunch.
 */
export function createRelaunchIntent(options: {
  readonly quit: () => void;
  readonly relaunch: () => void;
}) {
  let requested = false;
  return {
    request: () => {
      requested = true;
      options.quit();
    },
    quitAccepted: () => {
      if (!requested) return;
      requested = false;
      options.relaunch();
    },
    quitCancelled: () => {
      requested = false;
    },
  };
}

/**
 * Nightly's Data setting, owned by its main process. The renderer can only
 * choose between the two fixed values, ask for a relaunch, or ask to remove
 * the fixed test folder; it never names a folder, a port or a role.
 */
export function createNightlyDataControl(options: {
  readonly identity: DesktopIdentity;
  readonly role: DesktopHostRole;
  readonly platform: NodeJS.Platform;
  readonly appDataDirectory: string;
  readonly windowStorageDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly trashItem: (path: string) => Promise<void>;
  readonly clearTestDataSecrets?: () => Promise<void>;
  /** Starts a quit that relaunches once it is certain. */
  readonly requestRelaunch: () => void;
}) {
  const running: DesktopDataChoice = options.role.kind === "test-host" ? "test-data" : "octant";
  const testDataDirectory = (): string | undefined => {
    const target = resolveDesktopHostRole(options.identity, "test-data", {
      platform: options.platform,
      home: desktopHomeDirectory(options.appDataDirectory, options.platform),
      env: options.env,
    });
    return target.kind === "test-host" ? target.dataDirectory : undefined;
  };
  const state = async (removal?: NightlyDataState["removal"]): Promise<NightlyDataState> => {
    const directory = testDataDirectory();
    let testDataPresent = false;
    if (directory !== undefined) {
      try {
        testDataPresent = (await lstat(directory)).isDirectory();
      } catch {
        testDataPresent = false;
      }
    }
    return {
      running,
      chosen: readStoredDesktopDataChoice(options.windowStorageDirectory),
      testDataPresent,
      ...(removal === undefined ? {} : { removal }),
    };
  };
  return {
    state: () => state(),
    choose: async (value: unknown): Promise<NightlyDataState> => {
      if (value !== "octant" && value !== "test-data")
        throw new TypeError("Octant Nightly rejected an invalid Data choice.");
      await storeDesktopDataChoice(options.windowStorageDirectory, value);
      return state();
    },
    remove: async (): Promise<NightlyDataState> => {
      const outcome = await removeNightlyTestData(options);
      return state(outcome.kind === "refused" ? outcome.reason : outcome.kind);
    },
    /** Relaunches only when the stored choice differs from this launch's role. */
    relaunch: (): { readonly kind: "relaunching" | "unchanged" } => {
      if (readStoredDesktopDataChoice(options.windowStorageDirectory) === running)
        return { kind: "unchanged" };
      options.requestRelaunch();
      return { kind: "relaunching" };
    },
  };
}

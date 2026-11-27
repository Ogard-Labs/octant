import { lstat, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  desktopDataDirectoriesOverlap,
  type DesktopHostRole,
} from "@octant/host-runtime/desktop-identity";
import {
  NIGHTLY_OCTANT_IMPORT_STAGES,
  type NightlyOctantImportKeys,
  type NightlyOctantImportOutcome,
  type NightlyOctantImportPreferences,
  type NightlyOctantImportPreview,
} from "@octant/contracts/app-updates";
import { desktopHomeDirectory, octantDefaultDataDirectory } from "./nightlyTestData";

export const LAST_OCTANT_IMPORT_FILE = "last-octant-import.json";
const STORE_FILE = "octant.sqlite3";
const MAX_RECORD_BYTES = 1_024;
const MAX_MAINTENANCE_OUTPUT_BYTES = 256 * 1_024;

export interface MaintenanceRun {
  /** `null` when the process could not run or was stopped. */
  readonly exitCode: number | null;
  readonly stdout: string;
}

type ServerRefusal = Extract<NightlyOctantImportOutcome, { kind: "refused" }>["reason"];
const SERVER_REFUSALS: ReadonlyArray<string> = [
  "octant-missing",
  "octant-newer",
  "busy",
  "unsafe-folder",
  "unreadable-event",
];

/**
 * Reads the import command's JSON report. Anything that is not exactly one of
 * its three outcomes is a failed maintenance step: the desktop never guesses
 * that an import happened.
 */
export function decodeImportReport(
  run: MaintenanceRun,
):
  | { readonly kind: "imported"; readonly report: ImportedReport }
  | { readonly kind: "refused"; readonly reason: ServerRefusal }
  | { readonly kind: "failed"; readonly stage: (typeof NIGHTLY_OCTANT_IMPORT_STAGES)[number] } {
  const failed = { kind: "failed", stage: "maintenance" } as const;
  if (Buffer.byteLength(run.stdout) > MAX_MAINTENANCE_OUTPUT_BYTES) return failed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return failed;
  }
  if (!isRecord(parsed)) return failed;
  if (parsed.kind === "refused") {
    return typeof parsed.reason === "string" && SERVER_REFUSALS.includes(parsed.reason)
      ? { kind: "refused", reason: parsed.reason as ServerRefusal }
      : failed;
  }
  if (parsed.kind === "failed") {
    return typeof parsed.stage === "string" &&
      (NIGHTLY_OCTANT_IMPORT_STAGES as ReadonlyArray<string>).includes(parsed.stage)
      ? {
          kind: "failed",
          stage: parsed.stage as (typeof NIGHTLY_OCTANT_IMPORT_STAGES)[number],
        }
      : failed;
  }
  if (parsed.kind !== "imported" || run.exitCode !== 0) return failed;
  const counts = parsed.counts;
  if (
    !isRecord(counts) ||
    !isCount(counts.events) ||
    !isCount(counts.threads) ||
    !isCount(counts.contentRows) ||
    !isCount(counts.settled) ||
    !Array.isArray(parsed.conflicts) ||
    !Array.isArray(parsed.kept)
  )
    return failed;
  return {
    kind: "imported",
    report: {
      counts: {
        events: counts.events,
        threads: counts.threads,
        contentRows: counts.contentRows,
        settled: counts.settled,
      },
      conflicts: parsed.conflicts.length,
      heldBack: parsed.kept.length,
    },
  };
}

interface ImportedReport {
  readonly counts: {
    readonly events: number;
    readonly threads: number;
    readonly contentRows: number;
    readonly settled: number;
  };
  readonly conflicts: number;
  readonly heldBack: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Runs one maintenance command to the end and returns its output. The command
 * prints only fixed, secret-free reports; its output is capped, and a run that
 * outlasts `timeoutMs` is stopped and reported as not run.
 */
export function runMaintenanceProcess(
  spec: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
  },
  timeoutMs: number,
): Promise<MaintenanceRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(spec.command, [...spec.args], {
      env: spec.env,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_MAINTENANCE_OUTPUT_BYTES) stdout += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

/** The end of the newest finished import, read from Nightly's window storage. */
export async function readLastOctantImport(
  windowStorageDirectory: string,
): Promise<string | undefined> {
  const path = join(windowStorageDirectory, LAST_OCTANT_IMPORT_FILE);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > MAX_RECORD_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || Object.keys(parsed).length !== 1) return undefined;
    const importedAt = parsed.importedAt;
    return typeof importedAt === "string" && !Number.isNaN(Date.parse(importedAt))
      ? importedAt
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeLastOctantImport(windowStorageDirectory: string, at: Date): Promise<void> {
  await mkdir(windowStorageDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(windowStorageDirectory, `.last-octant-import-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify({ importedAt: at.toISOString() }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(windowStorageDirectory, LAST_OCTANT_IMPORT_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Both folders the import names, resolved by the main process alone. */
function importFolders(options: {
  readonly role: DesktopHostRole;
  readonly platform: NodeJS.Platform;
  readonly appDataDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}):
  | { readonly kind: "folders"; readonly octant: string; readonly nightly: string }
  | { readonly kind: "refused"; readonly reason: "not-test-host" | "unsafe-folder" } {
  if (options.role.kind !== "test-host") return { kind: "refused", reason: "not-test-host" };
  // A developer's explicit folder is not the fixed one the import protects.
  if (options.env.OCTANT_DATA_DIR !== undefined)
    return { kind: "refused", reason: "unsafe-folder" };
  const octant = octantDefaultDataDirectory(
    desktopHomeDirectory(options.appDataDirectory, options.platform),
    options.platform,
    options.env,
  );
  if (desktopDataDirectoriesOverlap(options.role.dataDirectory, octant))
    return { kind: "refused", reason: "unsafe-folder" };
  return { kind: "folders", octant, nightly: options.role.dataDirectory };
}

async function octantStorePresent(octant: string): Promise<boolean> {
  try {
    const folder = await lstat(octant);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return false;
    const store = await lstat(join(octant, STORE_FILE));
    return store.isFile() && !store.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Nightly's "Import from Octant", owned by its main process. The renderer can
 * only ask, and the one thing it passes is whether to copy keys: both folders
 * come from the fixed identity, never from a request.
 */
export function createNightlyOctantImportControl(options: {
  readonly role: DesktopHostRole;
  readonly platform: NodeJS.Platform;
  readonly appDataDirectory: string;
  readonly windowStorageDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  /** Stops Nightly's own host; rejects when it cannot. */
  readonly stopHost: () => Promise<void>;
  /** Starts Nightly's own host again and refreshes its windows' authority. */
  readonly startHost: () => Promise<void>;
  /**
   * Reloads every Nightly window but the one that asked, which keeps its
   * summary on screen and offers its own reload.
   */
  readonly reloadOtherWindows: (requester: number) => void;
  /** Runs the packaged maintenance entry with Nightly's folder as the data folder. */
  readonly runMaintenance: (args: ReadonlyArray<string>) => Promise<MaintenanceRun>;
  readonly copyKeys: (input: {
    readonly octantDataDirectory: string;
    readonly runMaintenance: (args: ReadonlyArray<string>) => Promise<MaintenanceRun>;
  }) => Promise<NightlyOctantImportKeys>;
  readonly copyPreferences: (input: {
    readonly octantDataDirectory: string;
    readonly overwrite: boolean;
  }) => Promise<NightlyOctantImportPreferences>;
}) {
  let running = false;
  const folders = () => importFolders(options);
  return {
    preview: async (): Promise<NightlyOctantImportPreview> => {
      const resolved = folders();
      const lastImportedAt = await readLastOctantImport(options.windowStorageDirectory);
      return {
        octantDataPresent:
          resolved.kind === "folders" && (await octantStorePresent(resolved.octant)),
        ...(lastImportedAt === undefined ? {} : { lastImportedAt }),
      };
    },
    import: async (copyKeys: unknown, requester: number): Promise<NightlyOctantImportOutcome> => {
      if (typeof copyKeys !== "boolean")
        throw new TypeError("Octant Nightly rejected an invalid import request.");
      const resolved = folders();
      if (resolved.kind === "refused") return { kind: "refused", reason: resolved.reason };
      if (!(await octantStorePresent(resolved.octant)))
        return { kind: "refused", reason: "octant-missing" };
      if (running) return { kind: "refused", reason: "busy" };
      running = true;
      try {
        const firstImport =
          (await readLastOctantImport(options.windowStorageDirectory)) === undefined;
        try {
          await options.stopHost();
        } catch {
          return { kind: "failed", stage: "stop-host" };
        }
        let outcome: NightlyOctantImportOutcome;
        try {
          outcome = await importWithHostStopped({
            options,
            octant: resolved.octant,
            copyKeys,
            firstImport,
          });
        } catch {
          outcome = { kind: "failed", stage: "maintenance" };
        }
        try {
          await options.startHost();
        } catch {
          // The data is safe either way; Nightly says its host did not start.
          return { kind: "failed", stage: "start-host" };
        }
        options.reloadOtherWindows(requester);
        return outcome;
      } finally {
        running = false;
      }
    },
  };
}

async function importWithHostStopped(input: {
  readonly options: Parameters<typeof createNightlyOctantImportControl>[0];
  readonly octant: string;
  readonly copyKeys: boolean;
  readonly firstImport: boolean;
}): Promise<NightlyOctantImportOutcome> {
  const { options, octant } = input;
  const run = await options.runMaintenance(["import-octant", "--from", octant]);
  const report = decodeImportReport(run);
  if (report.kind !== "imported") return report;
  // The merged store is committed: record it before the optional copies, so a
  // failure in either never hides that the import happened.
  await writeLastOctantImport(options.windowStorageDirectory, options.now()).catch(() => undefined);
  const keys: NightlyOctantImportKeys = input.copyKeys
    ? await options
        .copyKeys({ octantDataDirectory: octant, runMaintenance: options.runMaintenance })
        .catch((): NightlyOctantImportKeys => ({ status: "unavailable", reason: "cannot-list" }))
    : { status: "not-requested" };
  const preferences = await options
    .copyPreferences({ octantDataDirectory: octant, overwrite: input.firstImport })
    .catch((): NightlyOctantImportPreferences => ({ status: "unavailable", reason: "failed" }));
  return { kind: "imported", ...report.report, keys, preferences };
}

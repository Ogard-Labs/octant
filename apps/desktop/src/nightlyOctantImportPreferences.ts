import { cp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NightlyOctantImportPreferences } from "@octant/contracts/app-updates";

/**
 * The renderer `localStorage` keys that come over from Octant, each with why.
 * A key not listed here never leaves Octant's storage: drafts, read cursors,
 * dismissed notices, caches and per-window layout name state of one install
 * or one window and would mislead the other. An entry ending in `*` names a
 * family of keys that share the prefix.
 */
export const COPIED_WINDOW_PREFERENCES: ReadonlyArray<{
  readonly key: string;
  readonly reason: string;
}> = [
  { key: "octant.keybindings.v1", reason: "The person's own shortcuts." },
  { key: "octant.models.favorites.v1", reason: "Favorite models." },
  { key: "octant.models.recent.v1", reason: "Recently used models." },
  { key: "octant.models.last-choice.v1", reason: "The model last chosen." },
  { key: "octant.editor-preferences.v1", reason: "Editor choices." },
  { key: "octant.code.diff-layout.v1", reason: "Diff layout." },
  { key: "octant.code.diff-ignore-whitespace.v1", reason: "Diff whitespace choice." },
  { key: "octant.composer.while-turn-runs.v1", reason: "What sending does during a turn." },
  { key: "octant.theme-mode", reason: "Light, dark or system appearance." },
  { key: "octant.shell.sidebar-collapsed.v1", reason: "Sidebar layout." },
  { key: "octant.sidebar.activity-view.v1*", reason: "Sidebar activity view per mode." },
  { key: "octant.sidebar.row-properties.v1*", reason: "Sidebar row properties." },
  { key: "octant.sidebar.row-age-default.v1", reason: "Sidebar row age default." },
  { key: "octant.code.project-view-preferences.v1", reason: "Code Project view choices." },
  { key: "octant.work.project-view-preferences.v1", reason: "Work Project view choices." },
];

/** One preference is a few hundred bytes; a larger value is not one. */
const MAX_VALUE_BYTES = 256 * 1_024;

export function isCopiedWindowPreference(key: string): boolean {
  return COPIED_WINDOW_PREFERENCES.some((entry) =>
    entry.key.endsWith("*") ? key.startsWith(entry.key.slice(0, -1)) : key === entry.key,
  );
}

/** Keeps the allowlisted string values and nothing else. */
export function selectWindowPreferences(
  storage: Readonly<Record<string, unknown>>,
): ReadonlyArray<readonly [string, string]> {
  const selected: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(storage)) {
    if (
      isCopiedWindowPreference(key) &&
      typeof value === "string" &&
      Buffer.byteLength(value) <= MAX_VALUE_BYTES
    )
      selected.push([key, value]);
  }
  return selected;
}

/** The origin packaged windows load from, so Nightly's storage matches Octant's. */
export const PACKAGED_RENDERER_ORIGIN = "file://";

/**
 * Copies the allowlisted window preferences from Octant's renderer storage
 * into Nightly's. Octant's `Local Storage` folder is copied to a scratch
 * folder and read there, so nothing is ever written into Octant's folder and
 * a running Octant keeps its files. Keys written since Octant last flushed to
 * disk may be missing. A later import never replaces a preference Nightly has
 * (`overwrite` is false); the first one does.
 */
export async function copyOctantWindowPreferences(input: {
  readonly octantDataDirectory: string;
  /**
   * One fixed folder in Nightly's own storage, emptied before and after each
   * run. It is fixed because Electron keeps every `session.fromPath` session
   * for the life of the process: a folder per import would leak one each time.
   */
  readonly scratchDirectory: string;
  /** The origin Nightly's windows load from. */
  readonly rendererOrigin: () => string | undefined;
  readonly overwrite: boolean;
  /** Reads every key of the storage folder copied into `userDataCopy`. */
  readonly readStorage: (userDataCopy: string) => Promise<Readonly<Record<string, unknown>>>;
  readonly writeStorage: (
    entries: ReadonlyArray<readonly [string, string]>,
    overwrite: boolean,
  ) => Promise<number>;
}): Promise<NightlyOctantImportPreferences> {
  if (input.rendererOrigin() !== PACKAGED_RENDERER_ORIGIN)
    return { status: "unavailable", reason: "origin-differs" };
  const source = join(input.octantDataDirectory, "Local Storage");
  try {
    const metadata = await lstat(source);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      return { status: "unavailable", reason: "octant-storage-missing" };
  } catch {
    return { status: "unavailable", reason: "octant-storage-missing" };
  }
  const scratch = input.scratchDirectory;
  try {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    // LOCK belongs to the process that holds it; the copy starts unlocked.
    await cp(source, join(scratch, "Local Storage"), {
      recursive: true,
      filter: (path) => !path.endsWith("/LOCK"),
    });
    // A page for the hidden window to load; file:// pages share one origin.
    await writeFile(join(scratch, "blank.html"), "<!doctype html><title>Octant</title>");
    const entries = selectWindowPreferences(await input.readStorage(scratch));
    const copied = entries.length === 0 ? 0 : await input.writeStorage(entries, input.overwrite);
    return { status: "copied", copied };
  } catch {
    return { status: "unavailable", reason: "failed" };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

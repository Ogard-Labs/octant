import { opendirSync, type Dir } from "node:fs";
import { join } from "node:path";

/**
 * How much of a checkout the language tools' offer looks at before a turn
 * starts. Canonical: docs/design/language-services.md (Agent read rules).
 *
 * The scan runs synchronously while a Code turn's tools are composed, so it
 * reads names only, breadth first, and stops at the first file a server
 * covers or when the bounds run out. Two thousand names six folders deep is a
 * few milliseconds of directory reads and gets past an ordinary project's
 * configuration files into its sources; a checkout whose covered files lie
 * beyond that is not offered the tools, which is the cheaper mistake.
 */
export const MAX_CODE_LANGUAGE_COVERAGE_ENTRIES = 2_000;
export const MAX_CODE_LANGUAGE_COVERAGE_DEPTH = 6;

/**
 * Hidden folders (`.git`, `.venv`, `.next`) and installed dependencies hold
 * no source the agent edits, and are large enough to spend the whole bound.
 */
function skipsFolder(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/**
 * Whether any of these folders holds a file whose name `covered` accepts,
 * within the bounds. A folder that cannot be opened is passed over, a link is
 * never followed, and a scan that runs out of bounds answers false: the
 * offer is left out rather than made for a checkout nobody looked at.
 */
export function foldersHoldCoveredFile(
  roots: ReadonlyArray<string>,
  covered: (fileName: string) => boolean,
  bounds: { readonly entries: number; readonly depth: number } = {
    entries: MAX_CODE_LANGUAGE_COVERAGE_ENTRIES,
    depth: MAX_CODE_LANGUAGE_COVERAGE_DEPTH,
  },
): boolean {
  let remaining = bounds.entries;
  const queue: Array<{ readonly path: string; readonly depth: number }> = roots.map((path) => ({
    path,
    depth: 0,
  }));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    let folder: Dir;
    try {
      folder = opendirSync(next.path);
    } catch {
      continue;
    }
    try {
      for (let entry = folder.readSync(); entry !== null; entry = folder.readSync()) {
        remaining -= 1;
        if (remaining < 0) return false;
        if (entry.isFile() && covered(entry.name)) return true;
        if (entry.isDirectory() && next.depth < bounds.depth && !skipsFolder(entry.name)) {
          queue.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
        }
      }
    } catch {
      // A folder removed while it was read has nothing more to offer.
    } finally {
      folder.closeSync();
    }
  }
  return false;
}

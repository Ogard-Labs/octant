import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_DATA_CHOICE_FILE,
  decodeDesktopDataChoice,
  type DesktopDataChoice,
} from "./desktopIdentity";

const MAX_CHOICE_BYTES = 1_024;

/**
 * Reads Nightly's stored Data choice from its window storage. A missing,
 * oversized, linked, non-regular or unreadable file is Octant's data, the safe
 * default. It opens without blocking, so a FIFO put there cannot hang a
 * launch. The desktop and `octant-nightly` both read it through here, so the
 * two never disagree about which host Nightly's data choice names.
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

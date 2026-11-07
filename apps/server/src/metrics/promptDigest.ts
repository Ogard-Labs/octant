import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A keyed digest of a prompt: lowercase hex HMAC-SHA-256 of the text with its
 * whitespace normalized (trimmed, runs collapsed to one space), so the same
 * prompt pasted with different spacing digests the same. The key is the host's
 * own, so a digest cannot be matched against a guessed prompt on another machine.
 */
export function digestPrompt(key: Uint8Array, text: string): string {
  return createHmac("sha256", key).update(text.trim().replace(/\s+/g, " ")).digest("hex");
}

/**
 * The host's prompt-digest key, made once from random bytes and kept in a
 * private file beside the host's other state. Never journaled or logged.
 *
 * The key is written to a temporary file in the same folder and put in place
 * whole, so a reader never sees a partial file: `link` when there is none (an
 * existing key always wins), `rename` over a stored file that is not a valid
 * key, such as the empty one a crash can leave. No digest was ever recorded
 * under an invalid key, so replacing it loses nothing. Returns nothing when the
 * folder cannot be written, so a host with a read-only data folder records
 * turns without digests instead of failing.
 */
export function openPromptDigestKey(path: string): Uint8Array | undefined {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stored = readStoredKey(path);
    if (stored !== undefined) return stored;
    writeFileSync(temporary, `${randomBytes(KEY_BYTES).toString("hex")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (existsSync(path)) {
      renameSync(temporary, path);
    } else {
      try {
        linkSync(temporary, path);
      } catch (error) {
        // Another start made the key first; that one stays.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    chmodSync(path, 0o600);
    return readStoredKey(path);
  } catch {
    return undefined;
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing was written there, or the folder is unusable; the key outcome stands.
    }
  }
}

function readStoredKey(path: string): Uint8Array | undefined {
  try {
    const stored = readFileSync(path, "utf8").trim();
    return KEY_PATTERN.test(stored) ? Buffer.from(stored, "hex") : undefined;
  } catch {
    return undefined;
  }
}

/** The digest function a host hands its turn services, or nothing without a usable key. */
export function openPromptDigester(path: string): ((text: string) => string) | undefined {
  const key = openPromptDigestKey(path);
  return key === undefined ? undefined : (text) => digestPrompt(key, text);
}

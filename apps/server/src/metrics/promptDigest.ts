import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Returns nothing when the file cannot be read or written, so a host with a
 * read-only data folder records turns without digests instead of failing.
 */
export function openPromptDigestKey(path: string): Uint8Array | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${randomBytes(KEY_BYTES).toString("hex")}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    chmodSync(path, 0o600);
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

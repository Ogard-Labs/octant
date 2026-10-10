/**
 * Write a new update feed public key into the desktop source.
 *
 * `OCTANT_UPDATE_PUBLIC_KEY` (stable) and `OCTANT_UPDATE_PREVIEW_PUBLIC_KEY`
 * (preview and candidate) are compiled in on purpose: the app trusts only the
 * keys it shipped with, never one loaded at runtime. That makes this write
 * release-critical. A line-oriented `sed` stopped matching once the formatter
 * split the constant across two lines, and the release wizard still reported
 * success, which would have shipped the old key. So this replaces the string
 * literal wherever the formatter put it, reads the file back, and refuses
 * loudly when the new key is not there.
 *
 *   bun scripts/write-update-public-key.ts <path to appUpdateFeed.ts> <base64 SPKI key> [stable|preview]
 *
 * The ring defaults to stable, which is the key the release wizard mints.
 */

import { createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const UPDATE_PUBLIC_KEY_CONSTANTS = {
  stable: "OCTANT_UPDATE_PUBLIC_KEY",
  preview: "OCTANT_UPDATE_PREVIEW_PUBLIC_KEY",
} as const;

export type UpdateKeyRing = keyof typeof UPDATE_PUBLIC_KEY_CONSTANTS;

// Matches the declaration across any whitespace, including the line break the
// formatter inserts, and captures the literal's contents so only the key moves.
function declaration(constant: string): RegExp {
  return new RegExp(`(export const ${constant}\\s*=\\s*)"([^"\\n]*)"`, "g");
}

export type KeyReplacement =
  | { readonly status: "replaced"; readonly source: string }
  | { readonly status: "refused"; readonly reason: string };

export type KeyWrite =
  | { readonly status: "written" }
  | { readonly status: "refused"; readonly reason: string };

function isEd25519PublicKey(publicKey: string): boolean {
  // Buffer's base64 decoder skips characters it does not understand, so a
  // valid key with a trailing `\` or quote would pass and then break the
  // TypeScript string it is written into. Only canonical base64 is accepted.
  const bytes = Buffer.from(publicKey, "base64");
  if (bytes.toString("base64") !== publicKey) return false;
  try {
    const key = createPublicKey({
      key: bytes,
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function replaceUpdatePublicKey(
  source: string,
  publicKey: string,
  ring: UpdateKeyRing = "stable",
): KeyReplacement {
  const constant = UPDATE_PUBLIC_KEY_CONSTANTS[ring];
  if (!isEd25519PublicKey(publicKey)) {
    return { status: "refused", reason: "the new value is not a base64 Ed25519 SPKI public key" };
  }
  const declarations = [...source.matchAll(declaration(constant))].length;
  if (declarations !== 1) {
    return {
      status: "refused",
      reason: `expected one string declaration of ${constant}, found ${declarations}`,
    };
  }
  return {
    status: "replaced",
    source: source.replace(
      declaration(constant),
      (_match, prefix: string) => `${prefix}"${publicKey}"`,
    ),
  };
}

export async function writeUpdatePublicKey(
  path: string,
  publicKey: string,
  ring: UpdateKeyRing = "stable",
): Promise<KeyWrite> {
  const constant = UPDATE_PUBLIC_KEY_CONSTANTS[ring];
  const replacement = replaceUpdatePublicKey(await readFile(path, "utf8"), publicKey, ring);
  if (replacement.status === "refused") return replacement;
  await writeFile(path, replacement.source);
  // Read back rather than trust the write: this is the check the old sed lacked.
  const written = [...(await readFile(path, "utf8")).matchAll(declaration(constant))];
  if (written.length !== 1 || written[0]?.[2] !== publicKey) {
    return { status: "refused", reason: `${constant} does not hold the new key after writing` };
  }
  return { status: "written" };
}

if (import.meta.main) {
  const [path, publicKey, ring = "stable"] = process.argv.slice(2);
  if (path === undefined || publicKey === undefined || (ring !== "stable" && ring !== "preview")) {
    console.error(
      "usage: bun scripts/write-update-public-key.ts <appUpdateFeed.ts> <public key> [stable|preview]",
    );
    process.exit(2);
  }
  const result = await writeUpdatePublicKey(path, publicKey, ring);
  if (result.status === "refused") {
    console.error(
      `Could not write ${UPDATE_PUBLIC_KEY_CONSTANTS[ring]} into ${path}: ${result.reason}.`,
    );
    process.exit(1);
  }
}

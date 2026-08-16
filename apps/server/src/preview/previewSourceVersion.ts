import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Schema } from "effect";
import { UtcTimestamp } from "@octant/contracts";
import { ContentSha256, type PreviewSourceVersion } from "@octant/contracts/previews";

export type { PreviewSourceVersion };

type Timestamp = typeof UtcTimestamp.Type;
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeSha256 = Schema.decodeUnknownSync(ContentSha256);

export type PreviewSourceVersionResult =
  | { readonly ok: true; readonly sourceVersion: PreviewSourceVersion }
  | { readonly ok: false; readonly code: "unavailable" };

/**
 * Compute a content-addressed source version for a file. The version is the
 * SHA-256 of the file bytes plus the byte size and an observation timestamp.
 * Two files with identical bytes produce identical versions regardless of
 * path or mtime, so a moved or renamed source is still recognized as the
 * same content.
 */
export function computePreviewSourceVersion(absolutePath: string): PreviewSourceVersionResult {
  try {
    const bytes = readFileSync(absolutePath);
    const info = statSync(absolutePath);
    const contentSha256 = decodeSha256(createHash("sha256").update(bytes).digest("hex"));
    return {
      ok: true,
      sourceVersion: {
        contentSha256,
        byteSize: info.size,
        observedAt: toUtc(new Date()),
      },
    };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

/**
 * Synchronous variant for callers that already hold the file bytes (e.g.,
 * the chunk pipeline that reads once and reuses the buffer).
 */
export function computePreviewSourceVersionFromBytes(
  bytes: Uint8Array,
  observedAt: Date = new Date(),
): PreviewSourceVersion {
  const contentSha256 = decodeSha256(createHash("sha256").update(bytes).digest("hex"));
  return {
    contentSha256,
    byteSize: bytes.byteLength,
    observedAt: toUtc(observedAt),
  };
}

export function samePreviewSourceVersion(
  a: PreviewSourceVersion,
  b: PreviewSourceVersion,
): boolean {
  return a.contentSha256 === b.contentSha256 && a.byteSize === b.byteSize;
}

function toUtc(date: Date): Timestamp {
  return decodeTimestamp(date.toISOString());
}

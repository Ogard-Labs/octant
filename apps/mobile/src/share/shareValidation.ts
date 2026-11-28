import { ATTACHMENT_MEDIA_TYPE_PATTERN, UNKNOWN_ATTACHMENT_MEDIA_TYPE } from "@octant/contracts";
import {
  isSafeShareFileName,
  isShareExpired,
  isShareUuid,
  parseShareManifestV1,
  SHARE_INLINE_TEXT_MAX_CHARS,
  SHARE_MANIFEST_FILE_NAME,
  SHARE_MAX_ITEM_BYTES,
  SHARE_MAX_ITEMS,
  SHARE_MAX_TOTAL_BYTES,
  utf8Bytes,
} from "./shareManifest";

export type CleanableImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type SniffedMediaType =
  | { readonly kind: "cleanable-image"; readonly mediaType: CleanableImageMediaType }
  | { readonly kind: "uncleanable-image"; readonly mediaType: string }
  | { readonly kind: "file"; readonly mediaType: "application/pdf" }
  | { readonly kind: "unknown" };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const ISO_BMFF_IMAGE_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "avif",
  "avis",
]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.byteLength < start + length) return "";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[start + i] ?? 0);
  }
  return out;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 512);
  let sample = "";
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) return false;
    sample += String.fromCharCode(byte);
  }
  const trimmed = sample.trimStart().toLowerCase();
  if (trimmed.startsWith("<svg")) return true;
  return (
    (trimmed.startsWith("<?xml") || trimmed.startsWith("<!doctype svg")) && trimmed.includes("<svg")
  );
}

/**
 * Re-reads the file's type from its leading bytes instead of trusting the
 * sharing app's declared MIME type. Cleanable images match the host's metadata
 * stripper (`imageMetadataRemoval.ts`); every other image format is flagged as
 * uncleanable so it can never slip past metadata removal as an opaque file.
 */
export function sniffMediaTypeFromBytes(bytes: Uint8Array): SniffedMediaType {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "cleanable-image", mediaType: "image/jpeg" };
  }
  if (
    bytes.byteLength >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    return { kind: "cleanable-image", mediaType: "image/png" };
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { kind: "cleanable-image", mediaType: "image/webp" };
  }
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { kind: "cleanable-image", mediaType: "image/gif" };
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (ISO_BMFF_IMAGE_BRANDS.has(brand)) {
      const mediaType = brand.startsWith("avif") || brand === "avis" ? "image/avif" : "image/heic";
      return { kind: "uncleanable-image", mediaType };
    }
  }
  if (
    bytes.byteLength >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return { kind: "uncleanable-image", mediaType: "image/tiff" };
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { kind: "uncleanable-image", mediaType: "image/bmp" };
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  ) {
    return { kind: "uncleanable-image", mediaType: "image/x-icon" };
  }
  if (looksLikeSvg(bytes)) {
    return { kind: "uncleanable-image", mediaType: "image/svg+xml" };
  }
  if (ascii(bytes, 0, 5) === "%PDF-") {
    return { kind: "file", mediaType: "application/pdf" };
  }
  return { kind: "unknown" };
}

export type StagedItemRefusalReason =
  | "empty"
  | "too-large"
  | "uncleanable-image"
  | "too-many-items"
  | "total-too-large";

export type StagedFileClassification =
  | { readonly status: "ok"; readonly kind: "image" | "file"; readonly mediaType: string }
  | {
      readonly status: "refused";
      readonly reason: "empty" | "too-large" | "uncleanable-image";
      readonly message: string;
    };

export const SHARE_REFUSAL_MESSAGES = {
  empty: "The shared file is empty.",
  tooLarge: "The shared file is larger than 10 MB.",
  uncleanableImage:
    "Octant cannot remove metadata from this image format, so it cannot be attached.",
  tooManyItems: `You can share at most ${SHARE_MAX_ITEMS} items at once.`,
  totalTooLarge: "Shared items together are larger than 40 MB.",
  expired: "The shared items expired after a day and were removed.",
  invalidStaging: "The shared items were incomplete or invalid and were removed.",
} as const;

export function classifyStagedFile(input: {
  readonly declaredType: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}): StagedFileClassification {
  if (input.bytes.byteLength === 0) {
    return { status: "refused", reason: "empty", message: SHARE_REFUSAL_MESSAGES.empty };
  }
  if (input.bytes.byteLength > SHARE_MAX_ITEM_BYTES) {
    return { status: "refused", reason: "too-large", message: SHARE_REFUSAL_MESSAGES.tooLarge };
  }
  const sniffed = sniffMediaTypeFromBytes(input.bytes);
  if (sniffed.kind === "cleanable-image") {
    return { status: "ok", kind: "image", mediaType: sniffed.mediaType };
  }
  if (sniffed.kind === "uncleanable-image") {
    return {
      status: "refused",
      reason: "uncleanable-image",
      message: SHARE_REFUSAL_MESSAGES.uncleanableImage,
    };
  }
  const declared = input.declaredType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  // Any item declared as an image whose bytes are not one of the four formats
  // the host strips is refused rather than downgraded to an uncleaned byte stream.
  if (declared.startsWith("image/")) {
    return {
      status: "refused",
      reason: "uncleanable-image",
      message: SHARE_REFUSAL_MESSAGES.uncleanableImage,
    };
  }
  if (sniffed.kind === "file") {
    return { status: "ok", kind: "file", mediaType: sniffed.mediaType };
  }
  const mediaType = ATTACHMENT_MEDIA_TYPE_PATTERN.test(declared)
    ? declared
    : UNKNOWN_ATTACHMENT_MEDIA_TYPE;
  return { status: "ok", kind: "file", mediaType };
}

export interface ShareStagingFolderEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface ShareStagingFileStat {
  readonly exists: boolean;
  readonly isRegularFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly sizeBytes: number;
}

export interface ShareStagingFs {
  readonly available: boolean;
  readonly listShareFolders: () => Promise<ReadonlyArray<ShareStagingFolderEntry>>;
  readonly statFile: (folder: string, fileName: string) => Promise<ShareStagingFileStat>;
  readonly readTextFile: (folder: string, fileName: string) => Promise<string | undefined>;
  readonly readBinaryFile: (folder: string, fileName: string) => Promise<Uint8Array | undefined>;
  readonly deleteShareFolder: (folder: string) => Promise<void>;
  readonly deleteAllShares: () => Promise<void>;
}

export interface ValidatedStagedAttachment {
  readonly kind: "image" | "file";
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ValidatedStagedShare {
  readonly id: string;
  readonly createdAt: string;
  readonly textParts: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<ValidatedStagedAttachment>;
  /** Policy refusals (uncleanable image, >10 MiB, empty, >16 items); share stays so the person sees why and can Discard. */
  readonly refusal?: {
    readonly reason: StagedItemRefusalReason;
    readonly message: string;
  };
}

export type ValidateStagedShareResult =
  | { readonly status: "ok"; readonly share: ValidatedStagedShare }
  | { readonly status: "expired" }
  | { readonly status: "invalid"; readonly reason: string };

/**
 * Validates one staged share folder strictly: UUID folder name, non-symlink
 * manifest and regular files, matching sizes, age <= 1 day, and byte-level
 * MIME recheck. Structural tampering or expiry deletes the folder immediately.
 */
export async function validateStagedShare(input: {
  readonly entry: ShareStagingFolderEntry;
  readonly fs: ShareStagingFs;
  readonly nowMs: number;
}): Promise<ValidateStagedShareResult> {
  const { entry, fs, nowMs } = input;
  const rejectAndDelete = async (reason: string): Promise<ValidateStagedShareResult> => {
    await fs.deleteShareFolder(entry.name);
    return { status: "invalid", reason };
  };

  if (entry.isSymbolicLink || !entry.isDirectory || !isShareUuid(entry.name)) {
    return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
  }

  const manifestStat = await fs.statFile(entry.name, SHARE_MANIFEST_FILE_NAME);
  if (!manifestStat.exists || manifestStat.isSymbolicLink || !manifestStat.isRegularFile) {
    return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
  }

  const manifestText = await fs.readTextFile(entry.name, SHARE_MANIFEST_FILE_NAME);
  if (manifestText === undefined) {
    return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(manifestText);
  } catch {
    return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
  }

  const parsed = parseShareManifestV1(rawJson);
  if (parsed.status === "invalid") {
    return rejectAndDelete(parsed.reason);
  }
  const { manifest } = parsed;
  if (manifest.id.toLowerCase() !== entry.name.toLowerCase()) {
    return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
  }
  if (isShareExpired(manifest.createdAt, nowMs)) {
    await fs.deleteShareFolder(entry.name);
    return { status: "expired" };
  }

  const textParts: string[] = [];
  const attachments: ValidatedStagedAttachment[] = [];
  let refusal: ValidatedStagedShare["refusal"];
  let totalBytes = 0;

  if (manifest.items.length > SHARE_MAX_ITEMS) {
    refusal = { reason: "too-many-items", message: SHARE_REFUSAL_MESSAGES.tooManyItems };
  }

  for (const item of manifest.items) {
    totalBytes += item.bytes;
    if (item.kind === "text") {
      if (item.bytes === 0) {
        refusal ??= { reason: "empty", message: SHARE_REFUSAL_MESSAGES.empty };
        continue;
      }
      if (item.bytes > SHARE_MAX_ITEM_BYTES) {
        refusal ??= { reason: "too-large", message: SHARE_REFUSAL_MESSAGES.tooLarge };
        continue;
      }
      if (item.text.length <= SHARE_INLINE_TEXT_MAX_CHARS) {
        textParts.push(item.text);
      } else {
        const displayName = item.name.toLowerCase().endsWith(".txt")
          ? item.name
          : `${item.name}.txt`;
        attachments.push({
          kind: "file",
          displayName,
          mediaType: "text/plain",
          bytes: utf8Bytes(item.text),
        });
      }
      continue;
    }

    if (item.kind === "link") {
      textParts.push(item.url);
      continue;
    }

    if (!isSafeShareFileName(item.fileName)) {
      return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
    }
    const stat = await fs.statFile(entry.name, item.fileName);
    if (!stat.exists || stat.isSymbolicLink || !stat.isRegularFile) {
      return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
    }
    if (stat.sizeBytes !== item.bytes) {
      return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
    }
    if (stat.sizeBytes === 0) {
      refusal ??= { reason: "empty", message: SHARE_REFUSAL_MESSAGES.empty };
      continue;
    }
    if (stat.sizeBytes > SHARE_MAX_ITEM_BYTES) {
      refusal ??= { reason: "too-large", message: SHARE_REFUSAL_MESSAGES.tooLarge };
      continue;
    }
    const bytes = await fs.readBinaryFile(entry.name, item.fileName);
    if (bytes === undefined || bytes.byteLength !== item.bytes) {
      return rejectAndDelete(SHARE_REFUSAL_MESSAGES.invalidStaging);
    }
    const classified = classifyStagedFile({
      declaredType: item.declaredType,
      name: item.name,
      bytes,
    });
    if (classified.status === "refused") {
      refusal ??= { reason: classified.reason, message: classified.message };
      continue;
    }
    attachments.push({
      kind: classified.kind,
      displayName: item.name,
      mediaType: classified.mediaType,
      bytes,
    });
  }

  if (totalBytes > SHARE_MAX_TOTAL_BYTES) {
    refusal ??= { reason: "total-too-large", message: SHARE_REFUSAL_MESSAGES.totalTooLarge };
  }

  return {
    status: "ok",
    share: {
      id: manifest.id,
      createdAt: manifest.createdAt,
      textParts,
      attachments,
      ...(refusal === undefined ? {} : { refusal }),
    },
  };
}

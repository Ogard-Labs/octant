import {
  COMPOSER_IMAGE_MEDIA_TYPES,
  MAX_COMPOSER_ATTACHMENT_BYTES,
} from "./composerAttachmentCapability";

/** One clipboard image the composer refused, with the reason to show. */
export interface RejectedPastedImage {
  readonly displayName: string;
  readonly reason: string;
}

export interface PastedImageSelection {
  readonly files: ReadonlyArray<File>;
  readonly rejected: ReadonlyArray<RejectedPastedImage>;
}

/**
 * Minimal structural view of a paste event's clipboard. Typed structurally so
 * the pure collector can be exercised without a DOM `DataTransfer`.
 */
export interface ComposerClipboard {
  readonly files?: ArrayLike<File> | undefined;
  readonly items?: ArrayLike<{ readonly kind: string; getAsFile(): File | null }> | undefined;
  readonly types?: ReadonlyArray<string> | undefined;
}

/**
 * Extract pasteable images from a clipboard payload.
 *
 * Images arrive as ordinary attachments, so they are held to the same
 * allow-list and byte bound as a chosen file — a screenshot pasted from the OS
 * is not a privileged path. Anything outside those bounds is returned as a
 * rejection with a reason instead of being silently dropped, and non-image
 * clipboard content yields no files at all so ordinary text paste is
 * untouched.
 */
export function collectPastedImages(
  clipboard: ComposerClipboard | null | undefined,
  options: {
    readonly allowedMediaTypes?: ReadonlyArray<string>;
    readonly maxBytes?: number;
  } = {},
): PastedImageSelection {
  if (clipboard === null || clipboard === undefined) return { files: [], rejected: [] };
  const allowed = new Set(options.allowedMediaTypes ?? COMPOSER_IMAGE_MEDIA_TYPES);
  const maxBytes = options.maxBytes ?? MAX_COMPOSER_ATTACHMENT_BYTES;
  const files: File[] = [];
  const rejected: RejectedPastedImage[] = [];
  const seen = new Set<File>();

  for (const file of clipboardFiles(clipboard)) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.type.startsWith("image/")) continue;
    const displayName = pastedImageName(file);
    if (!allowed.has(file.type)) {
      rejected.push({
        displayName,
        reason: `${file.type} images cannot be attached.`,
      });
      continue;
    }
    if (file.size <= 0) {
      rejected.push({ displayName, reason: "The pasted image is empty." });
      continue;
    }
    if (file.size > maxBytes) {
      rejected.push({ displayName, reason: "The pasted image is too large to attach." });
      continue;
    }
    files.push(file);
  }
  return { files, rejected };
}

/**
 * Whether a paste carried image content the composer would consume. Used to
 * decide whether to consume the paste; a clipboard that also carries text is
 * left to the browser when no image survived the bounds check.
 */
export function clipboardHasImage(clipboard: ComposerClipboard | null | undefined): boolean {
  if (clipboard === null || clipboard === undefined) return false;
  for (const file of clipboardFiles(clipboard)) {
    if (file.type.startsWith("image/")) return true;
  }
  return false;
}

/**
 * A clipboard image usually has no name. Naming it here keeps the pending
 * attachment chip, its remove button's accessible name, and any failure
 * message referring to the same thing.
 */
export function pastedImageName(file: File): string {
  const name = file.name.trim();
  if (name.length > 0) return name;
  const extension = file.type.slice("image/".length).split("+")[0] ?? "png";
  return `Pasted image.${extension}`;
}

function clipboardFiles(clipboard: ComposerClipboard): ReadonlyArray<File> {
  const collected: File[] = [];
  const direct = clipboard.files;
  if (direct !== undefined) {
    for (let index = 0; index < direct.length; index += 1) {
      const file = direct[index];
      if (file !== undefined && file !== null) collected.push(file);
    }
  }
  const items = clipboard.items;
  if (items !== undefined) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined || item === null || item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file !== null && !collected.includes(file)) collected.push(file);
    }
  }
  return collected;
}

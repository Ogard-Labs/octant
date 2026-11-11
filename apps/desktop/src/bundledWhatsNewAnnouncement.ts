import type { BundledWhatsNewAnnouncement } from "@octant/contracts/desktop-bridge";
import { dirname, join } from "node:path";

/**
 * The one feature announcement a release may bundle beside its notes.
 *
 * Read from disk, never from a network. Anything wrong with it (bad JSON, an
 * unknown field, a name that could leave the folder, a picture that is too
 * large or not the format its name claims) means "no announcement": a release
 * file must never turn into an error dialog.
 */
export const BUNDLED_ANNOUNCEMENT_FILENAME = "whats-new-announcement.json" as const;

export const MAX_ANNOUNCEMENT_FILE_CHARS = 8_192;
export const MAX_ANNOUNCEMENT_TITLE_CHARS = 80;
export const MAX_ANNOUNCEMENT_BODY_CHARS = 600;
export const MAX_ANNOUNCEMENT_ACTION_CHARS = 32;
export const MAX_ANNOUNCEMENT_PICTURE_ALT_CHARS = 160;
/** Large enough for a screenshot, small enough to cross IPC as a data URL. */
export const MAX_ANNOUNCEMENT_PICTURE_BYTES = 524_288;

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "title",
  "body",
  "actionLabel",
  "picture",
  "pictureAlt",
]);

/**
 * A bare file name in the resources folder. No separator and no leading dot,
 * so the name cannot point anywhere but a sibling of the announcement.
 */
const PICTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|webp)$/i;

export interface ParsedAnnouncement {
  readonly title: string;
  readonly body: string;
  readonly actionLabel?: string;
  readonly pictureName?: string;
  readonly pictureAlt?: string;
}

export function parseAnnouncementFile(raw: string): ParsedAnnouncement | undefined {
  if (raw.length === 0 || raw.length > MAX_ANNOUNCEMENT_FILE_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(parsed));
  if (Object.keys(record).some((key) => !ALLOWED_KEYS.has(key))) return undefined;
  if (record.schemaVersion !== 1) return undefined;
  const title = boundedText(record.title, MAX_ANNOUNCEMENT_TITLE_CHARS);
  const body = boundedText(record.body, MAX_ANNOUNCEMENT_BODY_CHARS);
  if (title === undefined || body === undefined) return undefined;
  const actionLabel = optionalText(record.actionLabel, MAX_ANNOUNCEMENT_ACTION_CHARS);
  const pictureAlt = optionalText(record.pictureAlt, MAX_ANNOUNCEMENT_PICTURE_ALT_CHARS);
  if (actionLabel === null || pictureAlt === null) return undefined;
  let pictureName: string | undefined;
  if (record.picture !== undefined) {
    if (typeof record.picture !== "string" || !PICTURE_NAME.test(record.picture)) return undefined;
    pictureName = record.picture;
  }
  return {
    title,
    body,
    ...(actionLabel === undefined ? {} : { actionLabel }),
    ...(pictureName === undefined ? {} : { pictureName }),
    ...(pictureAlt === undefined ? {} : { pictureAlt }),
  };
}

/** The picture's media type when its leading bytes match its name, else undefined. */
export function pictureMediaType(name: string, bytes: Uint8Array): string | undefined {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? "image/png"
      : undefined;
  }
  if (extension === "jpg" || extension === "jpeg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff]) ? "image/jpeg" : undefined;
  }
  if (extension === "webp") {
    return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
      ? "image/webp"
      : undefined;
  }
  return undefined;
}

export async function loadBundledAnnouncement(options: {
  readonly announcementPath: string;
  readonly readFile: (path: string) => Promise<string>;
  readonly readBytes: (path: string) => Promise<Uint8Array>;
}): Promise<BundledWhatsNewAnnouncement | undefined> {
  let parsed: ParsedAnnouncement | undefined;
  try {
    parsed = parseAnnouncementFile(await options.readFile(options.announcementPath));
  } catch {
    return undefined;
  }
  if (parsed === undefined) return undefined;
  let picture: BundledWhatsNewAnnouncement["picture"];
  if (parsed.pictureName !== undefined) {
    try {
      const bytes = await options.readBytes(
        join(dirname(options.announcementPath), parsed.pictureName),
      );
      const mediaType =
        bytes.byteLength === 0 || bytes.byteLength > MAX_ANNOUNCEMENT_PICTURE_BYTES
          ? undefined
          : pictureMediaType(parsed.pictureName, bytes);
      if (mediaType === undefined) return undefined;
      picture = {
        dataUrl: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
        ...(parsed.pictureAlt === undefined ? {} : { alt: parsed.pictureAlt }),
      };
    } catch {
      return undefined;
    }
  }
  return {
    title: parsed.title,
    body: parsed.body,
    ...(parsed.actionLabel === undefined ? {} : { actionLabel: parsed.actionLabel }),
    ...(picture === undefined ? {} : { picture }),
  };
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 || text.length > max ? undefined : text;
}

/** Undefined when absent, null when present but invalid. */
function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return boundedText(value, max) ?? null;
}

function startsWith(bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

import type { BundledWhatsNewAnnouncement } from "@octant/contracts/desktop-bridge";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The feature announcements a release may bundle beside its notes: one to five,
 * shown in a row.
 *
 * Read from disk, never from a network. Anything wrong with the file as a whole
 * (bad JSON, an unknown top-level field, a wrong shape) means "no
 * announcements". In a version 2 file an entry that is wrong by itself (an
 * unknown field, a text over its limit, a bad picture name, a picture that is
 * missing, too large or not the format its name claims) is skipped and the
 * valid ones still show. A release file must never turn into an error dialog.
 *
 * Version 1 is one announcement object and stays valid as a list of one.
 */
export const BUNDLED_ANNOUNCEMENT_FILENAME = "whats-new-announcement.json" as const;

/**
 * Five entries at their limits, pretty-printed, with the worst ordinary JSON
 * escaping (a quote or a newline costs two characters): about 3,000 characters
 * an entry, so 16,384 leaves room for the wrapper too. The earlier single
 * entry was held to 8,192 for the same reasons. It is a ceiling on what is
 * read, not on what is shown: each field keeps its own limit below.
 */
export const MAX_ANNOUNCEMENT_FILE_CHARS = 16_384;
/** More valid entries than this are not shown; the first five win. */
export const MAX_ANNOUNCEMENTS = 5;
export const MAX_ANNOUNCEMENT_TITLE_CHARS = 80;
export const MAX_ANNOUNCEMENT_BODY_CHARS = 600;
export const MAX_ANNOUNCEMENT_ACTION_CHARS = 32;
export const MAX_ANNOUNCEMENT_PICTURE_ALT_CHARS = 160;
/** Large enough for a screenshot, small enough to cross IPC as a data URL. */
export const MAX_ANNOUNCEMENT_PICTURE_BYTES = 524_288;

const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "title",
  "body",
  "actionLabel",
  "picture",
  "pictureAlt",
]);
const VERSION_1_KEYS: ReadonlySet<string> = new Set(["schemaVersion", ...ENTRY_KEYS]);
const VERSION_2_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "announcements"]);

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

/**
 * The announcements a file names, in order, or an empty list when the file is
 * not valid as a whole. Pictures are not read here, so an entry whose picture
 * is missing is still listed; the loader skips it. Entries beyond what can be
 * shown are not trimmed here for the same reason: the fifth valid one is only
 * known after pictures are read.
 */
export function parseAnnouncementFile(raw: string): ReadonlyArray<ParsedAnnouncement> {
  if (raw.length === 0 || raw.length > MAX_ANNOUNCEMENT_FILE_CHARS) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(parsed));
  if (record.schemaVersion === 1) {
    if (Object.keys(record).some((key) => !VERSION_1_KEYS.has(key))) return [];
    const entry = parseEntry(record);
    return entry === undefined ? [] : [entry];
  }
  if (record.schemaVersion === 2) {
    if (Object.keys(record).some((key) => !VERSION_2_KEYS.has(key))) return [];
    if (!Array.isArray(record.announcements)) return [];
    const entries: ParsedAnnouncement[] = [];
    for (const candidate of record.announcements as ReadonlyArray<unknown>) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const entryRecord: Readonly<Record<string, unknown>> = Object.fromEntries(
        Object.entries(candidate),
      );
      if (Object.keys(entryRecord).some((key) => !ENTRY_KEYS.has(key))) continue;
      const entry = parseEntry(entryRecord);
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  }
  return [];
}

function parseEntry(record: Readonly<Record<string, unknown>>): ParsedAnnouncement | undefined {
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

/**
 * Reads at most `maxBytes` of a file and returns what it read plus one byte
 * when the file is longer, so a caller can refuse an oversized file without
 * ever loading it whole.
 */
export async function readAtMost(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The announcements to show, in order: at most `MAX_ANNOUNCEMENTS`, each with
 * its picture already read. Pictures are read one entry at a time and only
 * until enough entries are ready, so an entry that will not be shown never has
 * its picture opened. Undefined when nothing is valid.
 */
export async function loadBundledAnnouncements(options: {
  readonly announcementPath: string;
  /** Must return at most `maxBytes + 1` bytes; see `readAtMost`. */
  readonly readBounded: (path: string, maxBytes: number) => Promise<Uint8Array>;
}): Promise<ReadonlyArray<BundledWhatsNewAnnouncement> | undefined> {
  let parsed: ReadonlyArray<ParsedAnnouncement>;
  try {
    // The cap is in bytes of the file; the parser's character cap still holds.
    const bytes = await options.readBounded(options.announcementPath, MAX_ANNOUNCEMENT_FILE_CHARS);
    if (bytes.byteLength > MAX_ANNOUNCEMENT_FILE_CHARS) return undefined;
    parsed = parseAnnouncementFile(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  const ready: BundledWhatsNewAnnouncement[] = [];
  for (const entry of parsed) {
    if (ready.length >= MAX_ANNOUNCEMENTS) break;
    const loaded = await loadEntry(entry, dirname(options.announcementPath), options.readBounded);
    if (loaded !== undefined) ready.push(loaded);
  }
  return ready.length === 0 ? undefined : ready;
}

async function loadEntry(
  entry: ParsedAnnouncement,
  folder: string,
  readBounded: (path: string, maxBytes: number) => Promise<Uint8Array>,
): Promise<BundledWhatsNewAnnouncement | undefined> {
  let picture: BundledWhatsNewAnnouncement["picture"];
  if (entry.pictureName !== undefined) {
    try {
      const bytes = await readBounded(
        join(folder, entry.pictureName),
        MAX_ANNOUNCEMENT_PICTURE_BYTES,
      );
      const mediaType =
        bytes.byteLength === 0 || bytes.byteLength > MAX_ANNOUNCEMENT_PICTURE_BYTES
          ? undefined
          : pictureMediaType(entry.pictureName, bytes);
      if (mediaType === undefined) return undefined;
      picture = {
        dataUrl: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
        ...(entry.pictureAlt === undefined ? {} : { alt: entry.pictureAlt }),
      };
    } catch {
      return undefined;
    }
  }
  return {
    title: entry.title,
    body: entry.body,
    ...(entry.actionLabel === undefined ? {} : { actionLabel: entry.actionLabel }),
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

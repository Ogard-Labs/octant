import { MOBILE_ATTACHMENT_MAX_BYTES } from "@octant/client-runtime";
import {
  ATTACHMENT_MEDIA_TYPE_PATTERN,
  MAX_CHAT_TURN_ATTACHMENTS,
  MAX_CODE_TURN_ATTACHMENTS,
  MAX_WORK_TURN_ATTACHMENTS,
} from "@octant/contracts";

/** Phone-only share staging manifest version. Never sent to a host. */
export const SHARE_MANIFEST_VERSION = 1 as const;
export const SHARE_MANIFEST_FILE_NAME = "manifest.json";
export const SHARE_APP_GROUP_DEFAULT = "group.app.octant.mobile.share";

/** Staging bounds enforced by both the native share targets and the app reader. */
export const SHARE_MAX_ITEMS = 16;
export const SHARE_MAX_ITEM_BYTES = MOBILE_ATTACHMENT_MAX_BYTES;
export const SHARE_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const SHARE_MAX_STAGED_SHARES = 5;
export const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SHARE_INLINE_TEXT_MAX_CHARS = 20_000;

export const SHARE_TURN_ATTACHMENT_LIMITS = {
  chat: MAX_CHAT_TURN_ATTACHMENTS,
  work: MAX_WORK_TURN_ATTACHMENTS,
  code: MAX_CODE_TURN_ATTACHMENTS,
} as const;

const SHARE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface ShareManifestTextItemV1 {
  readonly kind: "text";
  readonly name: string;
  readonly declaredType: "text/plain";
  readonly bytes: number;
  readonly text: string;
}

export interface ShareManifestLinkItemV1 {
  readonly kind: "link";
  readonly name: string;
  readonly declaredType: "text/uri-list" | "text/plain";
  readonly bytes: number;
  readonly url: string;
}

export interface ShareManifestFileItemV1 {
  readonly kind: "file";
  readonly name: string;
  readonly declaredType: string;
  readonly bytes: number;
  readonly fileName: string;
}

export type ShareManifestItemV1 =
  | ShareManifestTextItemV1
  | ShareManifestLinkItemV1
  | ShareManifestFileItemV1;

export interface ShareManifestV1 {
  readonly version: typeof SHARE_MANIFEST_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly items: ReadonlyArray<ShareManifestItemV1>;
}

export type ShareManifestParseResult =
  | { readonly status: "ok"; readonly manifest: ShareManifestV1 }
  | { readonly status: "invalid"; readonly reason: string };

const MANIFEST_KEYS = new Set(["version", "id", "createdAt", "items"]);
const TEXT_ITEM_KEYS = new Set(["kind", "name", "declaredType", "bytes", "text"]);
const LINK_ITEM_KEYS = new Set(["kind", "name", "declaredType", "bytes", "url"]);
const FILE_ITEM_KEYS = new Set(["kind", "name", "declaredType", "bytes", "fileName"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

export function isShareUuid(value: string): boolean {
  return SHARE_UUID_PATTERN.test(value);
}

/** Single path segment inside a share folder; refuses separators, traversal, and manifest overwrite. */
export function isSafeShareFileName(fileName: string): boolean {
  if (fileName.length === 0 || fileName.length > 255) return false;
  if (fileName === "." || fileName === ".." || fileName === SHARE_MANIFEST_FILE_NAME) return false;
  if (fileName.includes("/") || fileName.includes("\\")) return false;
  if (hasControlChar(fileName)) return false;
  return true;
}

/** Accepts only http and https links; never fetches them. */
export function parseShareHttpUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || hasControlChar(trimmed)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.hostname.length === 0) return undefined;
  return trimmed;
}

const utf8Encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

export function utf8ByteLength(text: string): number {
  return utf8Bytes(text).byteLength;
}

export function isShareExpired(createdAt: string, nowMs: number): boolean {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return true;
  return nowMs - createdMs >= SHARE_MAX_AGE_MS;
}

function parseItem(raw: unknown): ShareManifestItemV1 | string {
  if (!isPlainRecord(raw)) return "A staged item is malformed.";
  const kind = raw.kind;
  const name = raw.name;
  const declaredType = raw.declaredType;
  const bytes = raw.bytes;
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > 255 ||
    hasControlChar(name)
  ) {
    return "A staged item has an invalid name.";
  }
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    return "A staged item has an invalid size.";
  }
  if (kind === "text") {
    if (!hasOnlyKeys(raw, TEXT_ITEM_KEYS)) return "A staged text item has unexpected fields.";
    if (declaredType !== "text/plain" || typeof raw.text !== "string") {
      return "A staged text item is malformed.";
    }
    if (utf8ByteLength(raw.text) !== bytes) {
      return "A staged text item's size does not match its content.";
    }
    return { kind: "text", name, declaredType: "text/plain", bytes, text: raw.text };
  }
  if (kind === "link") {
    if (!hasOnlyKeys(raw, LINK_ITEM_KEYS)) return "A staged link item has unexpected fields.";
    if (
      (declaredType !== "text/uri-list" && declaredType !== "text/plain") ||
      typeof raw.url !== "string"
    ) {
      return "A staged link item is malformed.";
    }
    const url = parseShareHttpUrl(raw.url);
    if (url === undefined) return "Only http and https links can be shared into Octant.";
    if (utf8ByteLength(raw.url) !== bytes) {
      return "A staged link item's size does not match its content.";
    }
    return { kind: "link", name, declaredType, bytes, url };
  }
  if (kind === "file") {
    if (!hasOnlyKeys(raw, FILE_ITEM_KEYS)) return "A staged file item has unexpected fields.";
    if (typeof declaredType !== "string") return "A staged file item has no media type.";
    const normalizedType = declaredType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!ATTACHMENT_MEDIA_TYPE_PATTERN.test(normalizedType)) {
      return "A staged file item has an invalid media type.";
    }
    if (typeof raw.fileName !== "string" || !isSafeShareFileName(raw.fileName)) {
      return "A staged file item has an unsafe file name.";
    }
    return { kind: "file", name, declaredType: normalizedType, bytes, fileName: raw.fileName };
  }
  return "A staged item has an unknown kind.";
}

/**
 * Strictly decodes `ShareManifestV1`. Unknown fields on the manifest or any
 * item are refused so an outside app cannot sneak extra state through staging.
 */
export function parseShareManifestV1(raw: unknown): ShareManifestParseResult {
  if (!isPlainRecord(raw)) {
    return { status: "invalid", reason: "The staged share manifest is malformed." };
  }
  if (!hasOnlyKeys(raw, MANIFEST_KEYS)) {
    return { status: "invalid", reason: "The staged share manifest contains unexpected fields." };
  }
  if (raw.version !== SHARE_MANIFEST_VERSION) {
    return { status: "invalid", reason: "The staged share manifest version is unsupported." };
  }
  if (typeof raw.id !== "string" || !isShareUuid(raw.id)) {
    return { status: "invalid", reason: "The staged share identifier is invalid." };
  }
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) {
    return { status: "invalid", reason: "The staged share timestamp is invalid." };
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return { status: "invalid", reason: "The staged share has no items." };
  }
  const items: ShareManifestItemV1[] = [];
  for (const entry of raw.items) {
    const parsed = parseItem(entry);
    if (typeof parsed === "string") {
      return { status: "invalid", reason: parsed };
    }
    items.push(parsed);
  }
  return {
    status: "ok",
    manifest: {
      version: SHARE_MANIFEST_VERSION,
      id: raw.id,
      createdAt: raw.createdAt,
      items,
    },
  };
}

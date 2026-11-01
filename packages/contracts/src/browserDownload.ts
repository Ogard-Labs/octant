import { Schema } from "effect";
import { BrowserThreadId, MAX_BROWSER_UPLOAD_FILE_BYTES } from "./browserAutomation";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The largest file an agent's download may hold or save; the same bound as an upload. */
export const MAX_BROWSER_DOWNLOAD_FILE_BYTES = MAX_BROWSER_UPLOAD_FILE_BYTES;
/** How many downloads one browsing context holds at once; the oldest is discarded. */
/** The folder, at the root of the thread's workspace, a saved download lands in. */
export const BROWSER_DOWNLOAD_FOLDER = "downloads";

/**
 * One aggregate per thread (aggregate id = thread id), so a confirmed thread
 * purge finds the events by `threadId`. Kept apart from the capture aggregate,
 * whose replay reads every event on it as a capture.
 */
export const BROWSER_DOWNLOAD_AGGREGATE_TYPE = "browser-download";
export const BROWSER_DOWNLOAD_EVENT_NAMES = {
  saved: "browser.download-saved@1",
  refused: "browser.download-refused@1",
} as const;

const Origin = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048));

/**
 * A download the agent saved into the thread's workspace after the person
 * said yes. The record names the file and its digest, never its bytes.
 */
export const BrowserDownloadSaved = Schema.Struct({
  threadId: BrowserThreadId,
  /** The page the file came from. */
  origin: Origin,
  /** Where it landed, relative to the workspace root. */
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  sizeBytes: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(MAX_BROWSER_DOWNLOAD_FILE_BYTES),
  ),
  mediaType: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  savedAt: UtcTimestamp,
}).annotations(strict);
export type BrowserDownloadSaved = typeof BrowserDownloadSaved.Type;

/** Why a download was not kept. */
export const BrowserDownloadRefusalReason = Schema.Literal(
  "too-large",
  "executable",
  "denied",
  "cancelled",
  "expired",
  "symlink",
  "unavailable",
  "changed",
);
export type BrowserDownloadRefusalReason = typeof BrowserDownloadRefusalReason.Type;

/** A download that was cancelled, refused, or denied. No bytes. */
export const BrowserDownloadRefused = Schema.Struct({
  threadId: BrowserThreadId,
  origin: Origin,
  /** The page's suggested name, reduced to a safe basename. */
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  sizeBytes: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  mediaType: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  reason: BrowserDownloadRefusalReason,
  refusedAt: UtcTimestamp,
}).annotations(strict);
export type BrowserDownloadRefused = typeof BrowserDownloadRefused.Type;

export const decodeBrowserDownloadSaved = Schema.decodeUnknownSync(BrowserDownloadSaved);
export const decodeBrowserDownloadRefused = Schema.decodeUnknownSync(BrowserDownloadRefused);

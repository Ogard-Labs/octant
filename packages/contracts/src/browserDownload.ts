import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  BrowserThreadId,
  MAX_BROWSER_TRANSFER_FILE_LIMIT_MEGABYTES,
  MAX_BROWSER_UPLOAD_FILE_BYTES,
} from "./browserAutomation";
import { ProjectWorkingFolderId } from "./workingDirectory";
import { UtcTimestamp } from "./events";

/**
 * The largest file an agent's download may hold or save unless the person
 * chose another limit in Settings; the same default as an upload.
 */
export const MAX_BROWSER_DOWNLOAD_FILE_BYTES = MAX_BROWSER_UPLOAD_FILE_BYTES;
/** The largest saved file a receipt can record: the highest limit a person may choose. */
export const MAX_BROWSER_DOWNLOAD_RECEIPT_BYTES =
  MAX_BROWSER_TRANSFER_FILE_LIMIT_MEGABYTES * 1024 * 1024;
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
  selectedSaved: "browser.download-selected-saved@1",
  refused: "browser.download-refused@1",
} as const;

const Origin = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048));

/**
 * A download the agent saved into the thread's workspace after the person
 * said yes. The record names the file and its digest, never its bytes.
 */
export const BrowserDownloadSaved = Schema.Struct({
  threadId: BrowserThreadId,
  /** The page the file came from. */
  origin: Origin,
  /** Where it landed, relative to the workspace root. */
  path: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  sizeBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(MAX_BROWSER_DOWNLOAD_RECEIPT_BYTES),
  ),
  mediaType: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  savedAt: UtcTimestamp,
});
export type BrowserDownloadSaved = typeof BrowserDownloadSaved.Type;

export const BrowserDownloadDestinationReceipt = Schema.Struct({
  approvedFolderId: ProjectWorkingFolderId,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  pathBase: Schema.Literal("selected-root"),
});
export type BrowserDownloadDestinationReceipt = typeof BrowserDownloadDestinationReceipt.Type;
/** A separate event preserves the legacy workspace-relative saved receipt. */
export const BrowserDownloadSelectedSaved = Schema.Struct({
  ...BrowserDownloadSaved.fields,
  destination: BrowserDownloadDestinationReceipt,
});
export type BrowserDownloadSelectedSaved = typeof BrowserDownloadSelectedSaved.Type;
export const decodeBrowserDownloadSelectedSaved = Schema.decodeUnknownSync(
  BrowserDownloadSelectedSaved,
  STRICT_DECODE_OPTIONS,
);

/** Why a download was not kept. */
export const BrowserDownloadRefusalReason = Schema.Literals([
  "too-large",
  "executable",
  "denied",
  "cancelled",
  "expired",
  "symlink",
  "unavailable",
  "changed",
]);
export type BrowserDownloadRefusalReason = typeof BrowserDownloadRefusalReason.Type;

/** A download that was cancelled, refused, or denied. No bytes. */
export const BrowserDownloadRefused = Schema.Struct({
  threadId: BrowserThreadId,
  origin: Origin,
  /** The page's suggested name, reduced to a safe basename. */
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  sizeBytes: Schema.optional(NonNegativeInt),
  mediaType: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
  reason: BrowserDownloadRefusalReason,
  refusedAt: UtcTimestamp,
});
export type BrowserDownloadRefused = typeof BrowserDownloadRefused.Type;

export const decodeBrowserDownloadSaved = Schema.decodeUnknownSync(
  BrowserDownloadSaved,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserDownloadRefused = Schema.decodeUnknownSync(
  BrowserDownloadRefused,
  STRICT_DECODE_OPTIONS,
);

import { Schema } from "effect";
import {
  BrowserActionRequest,
  BrowserCaptureId,
  BrowserThreadId,
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
} from "./browserAutomation";
import { StoredBrowserProfile } from "./browserProfiles";
import { UtcTimestamp } from "./events";
import { ImageArtifactMediaType } from "./imageGeneration";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const ContentDigest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));

/**
 * Browser captures a thread keeps: the explicit `screenshot` action, and
 * nothing else. The picture is the one the host already hands the model, so its
 * size is bounded by the screenshot envelope rather than by a second limit.
 */
export const MAX_BROWSER_CAPTURES_PER_THREAD = 32;
export const MAX_BROWSER_CAPTURE_BYTES = Math.floor(
  (MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS * 3) / 4,
);

/**
 * One aggregate per thread (aggregate id = thread id) so the newest
 * `MAX_BROWSER_CAPTURES_PER_THREAD` captures are exactly the newest aggregate
 * versions, and a confirmed thread purge finds the events by `threadId`.
 */
export const BROWSER_CAPTURE_AGGREGATE_TYPE = "browser-capture";
export const BROWSER_CAPTURE_KEPT = "browser.capture-kept@1";

/**
 * A kept capture as the journal records it. Bytes and data URLs never appear
 * here: the picture lives in the managed attachment store under the capture
 * id, and this record names it by content digest. The origin is the page the
 * picture came from; the thread's untrusted-content taint is recorded by the
 * observation that produced the screenshot, not by this event.
 */
export const BrowserCapture = Schema.Struct({
  captureId: BrowserCaptureId,
  threadId: BrowserThreadId,
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  url: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
  title: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  hash: ContentDigest,
  size: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(MAX_BROWSER_CAPTURE_BYTES)),
  mime: ImageArtifactMediaType,
  capturedAt: UtcTimestamp,
  /**
   * The Project or Personal profile the page lived in, when it was in one. A
   * picture of a signed-in page shows an account, so the record says which. A
   * capture kept before profiles existed, or of a Private page, has none.
   */
  profile: Schema.optional(StoredBrowserProfile),
}).annotations(strict);
export type BrowserCapture = typeof BrowserCapture.Type;

export const BrowserCaptureKept = BrowserCapture;
export type BrowserCaptureKept = BrowserCapture;

export const BrowserCapturesCommand = Schema.Struct({ threadId: BrowserThreadId }).annotations(
  strict,
);
export type BrowserCapturesCommand = typeof BrowserCapturesCommand.Type;

/** Newest first. */
export const BrowserCapturesResponse = Schema.Struct({
  captures: Schema.Array(BrowserCapture).pipe(Schema.maxItems(MAX_BROWSER_CAPTURES_PER_THREAD)),
}).annotations(strict);
export type BrowserCapturesResponse = typeof BrowserCapturesResponse.Type;

/**
 * The person's Screenshot control. It wraps the ordinary action request rather
 * than adding a field to it, so a model cannot reach this path through tool
 * input, and names the thread so the host checks the window against it.
 */
export const BrowserCaptureTakeCommand = Schema.Struct({
  threadId: BrowserThreadId,
  request: BrowserActionRequest,
}).annotations(strict);
export type BrowserCaptureTakeCommand = typeof BrowserCaptureTakeCommand.Type;

export const BrowserCaptureImageCommand = Schema.Struct({
  threadId: BrowserThreadId,
  captureId: BrowserCaptureId,
}).annotations(strict);
export type BrowserCaptureImageCommand = typeof BrowserCaptureImageCommand.Type;

export const BrowserCaptureImage = Schema.Struct({
  captureId: BrowserCaptureId,
  dataUrl: Schema.String.pipe(
    Schema.pattern(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/),
  ),
}).annotations(strict);
export type BrowserCaptureImage = typeof BrowserCaptureImage.Type;

export const decodeBrowserCapture = Schema.decodeUnknownSync(BrowserCapture);
export const decodeBrowserCaptureKept = Schema.decodeUnknownSync(BrowserCaptureKept);
export const decodeBrowserCapturesCommand = Schema.decodeUnknownSync(BrowserCapturesCommand);
export const decodeBrowserCapturesResponse = Schema.decodeUnknownSync(BrowserCapturesResponse);
export const decodeBrowserCaptureTakeCommand = Schema.decodeUnknownSync(BrowserCaptureTakeCommand);
export const decodeBrowserCaptureImageCommand = Schema.decodeUnknownSync(
  BrowserCaptureImageCommand,
);
export const decodeBrowserCaptureImage = Schema.decodeUnknownSync(BrowserCaptureImage);

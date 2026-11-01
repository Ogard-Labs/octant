import { Schema } from "effect";
import {
  BrowserActionKind,
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

/**
 * The Browser steps a thread keeps as proof of a check: the agent's own
 * actions, newest 50, oldest first when read. Same shape as captures, so the
 * journal bounds them the same way: one aggregate per thread whose newest
 * `MAX_BROWSER_STEPS_PER_THREAD` versions are the steps that survive.
 */
export const MAX_BROWSER_STEPS_PER_THREAD = 50;
export const BROWSER_STEP_AGGREGATE_TYPE = "browser-step";
export const BROWSER_STEP_RECORDED = "browser.step-recorded@1";

export const BrowserStepFailureCategory = Schema.Literal(
  "invalid",
  "unauthorized",
  "unavailable",
  "policy-denied",
  "context-expired",
  "credential-protected",
  "interrupted",
  "failed",
  "stale",
);
export type BrowserStepFailureCategory = typeof BrowserStepFailureCategory.Type;

/**
 * One step as the journal records it. It never holds what the agent typed, a
 * field's value, a query or fragment of the page's address, or a page's text:
 * only the operation, the element it acted on by ref (role and accessible
 * name), the page's origin and path, the one-line `changed` result, and, for a
 * step that failed, the failure category.
 */
export const BrowserStep = Schema.Struct({
  stepId: BrowserCaptureId,
  threadId: BrowserThreadId,
  operation: BrowserActionKind,
  element: Schema.optional(
    Schema.Struct({
      role: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
      name: Schema.String.pipe(Schema.maxLength(160)),
    }).annotations(strict),
  ),
  origin: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
  path: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
  changed: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  failure: Schema.optional(BrowserStepFailureCategory),
  /** The capture this step kept, when it was a screenshot that was kept. */
  captureId: Schema.optional(BrowserCaptureId),
  recordedAt: UtcTimestamp,
  /** The Project or Personal profile the page lived in, as a capture records it. */
  profile: Schema.optional(StoredBrowserProfile),
}).annotations(strict);
export type BrowserStep = typeof BrowserStep.Type;

export const BrowserStepsCommand = BrowserCapturesCommand;
export type BrowserStepsCommand = BrowserCapturesCommand;

/** Oldest first. */
export const BrowserStepsResponse = Schema.Struct({
  steps: Schema.Array(BrowserStep).pipe(Schema.maxItems(MAX_BROWSER_STEPS_PER_THREAD)),
}).annotations(strict);
export type BrowserStepsResponse = typeof BrowserStepsResponse.Type;

export const decodeBrowserStep = Schema.decodeUnknownSync(BrowserStep);
export const decodeBrowserStepsCommand = Schema.decodeUnknownSync(BrowserStepsCommand);
export const decodeBrowserStepsResponse = Schema.decodeUnknownSync(BrowserStepsResponse);
export const decodeBrowserCapture = Schema.decodeUnknownSync(BrowserCapture);
export const decodeBrowserCaptureKept = Schema.decodeUnknownSync(BrowserCaptureKept);
export const decodeBrowserCapturesCommand = Schema.decodeUnknownSync(BrowserCapturesCommand);
export const decodeBrowserCapturesResponse = Schema.decodeUnknownSync(BrowserCapturesResponse);
export const decodeBrowserCaptureTakeCommand = Schema.decodeUnknownSync(BrowserCaptureTakeCommand);
export const decodeBrowserCaptureImageCommand = Schema.decodeUnknownSync(
  BrowserCaptureImageCommand,
);
export const decodeBrowserCaptureImage = Schema.decodeUnknownSync(BrowserCaptureImage);

import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  BrowserActionKind,
  BrowserActionRequest,
  BrowserCaptureId,
  BrowserRecordingFacts,
  BrowserThreadId,
  MAX_BROWSER_RECORDING_BYTES,
  MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS,
} from "./browserAutomation";
import { StoredBrowserProfile } from "./browserProfiles";
import { UtcTimestamp } from "./events";
import { ImageArtifactMediaType } from "./imageGeneration";

const ContentDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/**
 * Browser captures a thread keeps: the explicit `screenshot` action and the
 * agent's explicit recording, and nothing else. A screenshot is the picture the
 * host already hands the model, so its size is bounded by the screenshot
 * envelope; a recording has its own bound, `MAX_BROWSER_RECORDING_BYTES`.
 */
/**
 * How many captures a thread keeps unless the person chose another number.
 * 200, because a long Browser task passed the earlier 32 in one sitting and
 * lost the screenshots its first steps named. A screenshot is at most about
 * 40 KiB, so 200 hold about 8 MiB beside the recordings' 16 MiB.
 */
export const DEFAULT_BROWSER_CAPTURES_PER_THREAD = 200;
/**
 * The most a person may choose, and the bound every listing and save is
 * sized for: 500 screenshots are about 20 MiB of bytes per thread.
 */
export const MAX_BROWSER_CAPTURES_PER_THREAD = 500;
/**
 * How many of those captures may be recordings. A recording is up to 2 MiB,
 * fifty times a screenshot, so eight bound a thread's recordings at about
 * 16 MiB; past eight the oldest recording goes, never a screenshot.
 */
export const MAX_BROWSER_RECORDINGS_PER_THREAD = 8;
export const MAX_BROWSER_CAPTURE_BYTES = Math.floor(
  (MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS * 3) / 4,
);

/**
 * One aggregate per thread (aggregate id = thread id) so the newest captures
 * the thread keeps are exactly the newest aggregate versions, and a confirmed thread purge finds the events by `threadId`.
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
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  url: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  title: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
  hash: ContentDigest,
  size: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_BROWSER_RECORDING_BYTES),
  ),
  mime: ImageArtifactMediaType,
  capturedAt: UtcTimestamp,
  /**
   * The Project or Personal profile the page lived in, when it was in one. A
   * picture of a signed-in page shows an account, so the record says which. A
   * capture kept before profiles existed, or of a Private page, has none.
   */
  profile: Schema.optional(StoredBrowserProfile),
  /**
   * Present when the capture is a recording: an animated PNG of the agent's
   * page during one call it asked to record. Absent, it is a screenshot.
   */
  recording: Schema.optional(BrowserRecordingFacts),
}).pipe(
  // A screenshot is the picture the model received, so it keeps the
  // screenshot envelope; only a recording, always an animated PNG, may be
  // larger.
  Schema.check(
    Schema.makeFilter((capture) =>
      capture.recording === undefined
        ? capture.size <= MAX_BROWSER_CAPTURE_BYTES
        : capture.mime === "image/png",
    ),
  ),
);
export type BrowserCapture = typeof BrowserCapture.Type;

export const BrowserCaptureKept = BrowserCapture;
export type BrowserCaptureKept = BrowserCapture;

export const BrowserCapturesCommand = Schema.Struct({ threadId: BrowserThreadId });
export type BrowserCapturesCommand = typeof BrowserCapturesCommand.Type;

/** Newest first. */
export const BrowserCapturesResponse = Schema.Struct({
  captures: Schema.Array(BrowserCapture).check(Schema.isMaxLength(MAX_BROWSER_CAPTURES_PER_THREAD)),
});
export type BrowserCapturesResponse = typeof BrowserCapturesResponse.Type;

/**
 * The person's Screenshot control. It wraps the ordinary action request rather
 * than adding a field to it, so a model cannot reach this path through tool
 * input, and names the thread so the host checks the window against it.
 */
export const BrowserCaptureTakeCommand = Schema.Struct({
  threadId: BrowserThreadId,
  request: BrowserActionRequest,
});
export type BrowserCaptureTakeCommand = typeof BrowserCaptureTakeCommand.Type;

export const BrowserCaptureImageCommand = Schema.Struct({
  threadId: BrowserThreadId,
  captureId: BrowserCaptureId,
});
export type BrowserCaptureImageCommand = typeof BrowserCaptureImageCommand.Type;

export const BrowserCaptureImage = Schema.Struct({
  captureId: BrowserCaptureId,
  dataUrl: Schema.String.check(
    Schema.isPattern(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/),
  ),
});
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

export const BrowserStepFailureCategory = Schema.Literals([
  "invalid",
  "unauthorized",
  "unavailable",
  "policy-denied",
  "context-expired",
  "credential-protected",
  "interrupted",
  "failed",
  "stale",
]);
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
      role: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
      name: Schema.String.check(Schema.isMaxLength(160)),
    }),
  ),
  origin: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048))),
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  changed: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
  failure: Schema.optional(BrowserStepFailureCategory),
  /** The capture this step kept, when it was a screenshot that was kept. */
  captureId: Schema.optional(BrowserCaptureId),
  recordedAt: UtcTimestamp,
  /** The Project or Personal profile the page lived in, as a capture records it. */
  profile: Schema.optional(StoredBrowserProfile),
});
export type BrowserStep = typeof BrowserStep.Type;

export const BrowserStepsCommand = BrowserCapturesCommand;
export type BrowserStepsCommand = BrowserCapturesCommand;

/** Oldest first. */
export const BrowserStepsResponse = Schema.Struct({
  steps: Schema.Array(BrowserStep).check(Schema.isMaxLength(MAX_BROWSER_STEPS_PER_THREAD)),
});
export type BrowserStepsResponse = typeof BrowserStepsResponse.Type;

export const decodeBrowserStep = Schema.decodeUnknownSync(BrowserStep, STRICT_DECODE_OPTIONS);
export const decodeBrowserStepsCommand = Schema.decodeUnknownSync(
  BrowserStepsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserStepsResponse = Schema.decodeUnknownSync(
  BrowserStepsResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCapture = Schema.decodeUnknownSync(BrowserCapture, STRICT_DECODE_OPTIONS);
export const decodeBrowserCaptureKept = Schema.decodeUnknownSync(
  BrowserCaptureKept,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCapturesCommand = Schema.decodeUnknownSync(
  BrowserCapturesCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCapturesResponse = Schema.decodeUnknownSync(
  BrowserCapturesResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCaptureTakeCommand = Schema.decodeUnknownSync(
  BrowserCaptureTakeCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCaptureImageCommand = Schema.decodeUnknownSync(
  BrowserCaptureImageCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCaptureImage = Schema.decodeUnknownSync(
  BrowserCaptureImage,
  STRICT_DECODE_OPTIONS,
);

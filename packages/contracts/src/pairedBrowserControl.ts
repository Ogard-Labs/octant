import { Schema } from "effect";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { HubMemberId, OwnerUnlockPrincipal } from "./hubAndSpokes";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Sequence = Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER));
const PositiveSequence = Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER));
const Coordinate = Schema.Number.pipe(Schema.between(0, 1));

export const MAX_PAIRED_BROWSER_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_PAIRED_BROWSER_FRAME_WIDTH = 1920;
export const MAX_PAIRED_BROWSER_FRAME_HEIGHT = 1200;
export const MAX_PAIRED_BROWSER_FPS = 10;
export const MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST = 60;
export const MAX_PAIRED_BROWSER_EVENTS_PER_SECOND = 240;
export const MAX_PAIRED_BROWSER_TEXT_CHARS_PER_MINUTE = 4_096;
export const MAX_PAIRED_BROWSER_TEXT_LENGTH = 256;
export const MAX_PAIRED_BROWSER_LEASES_PER_HOST = 4;
export const PAIRED_BROWSER_STREAM_DISCONNECT_MS = 30_000;
export const PAIRED_BROWSER_IDLE_MS = 60_000;
export const MAX_PAIRED_BROWSER_FILE_BYTES = 10 * 1024 * 1024;

export const PairedBrowserLeaseId = Schema.UUID.pipe(Schema.brand("PairedBrowserLeaseId"));
export type PairedBrowserLeaseId = typeof PairedBrowserLeaseId.Type;

export const PairedBrowserChooserId = Schema.UUID.pipe(Schema.brand("PairedBrowserChooserId"));
export type PairedBrowserChooserId = typeof PairedBrowserChooserId.Type;

export const PairedBrowserUploadId = Schema.UUID.pipe(Schema.brand("PairedBrowserUploadId"));
export type PairedBrowserUploadId = typeof PairedBrowserUploadId.Type;

export const PairedBrowserDocumentVersion = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("PairedBrowserDocumentVersion"),
);
export type PairedBrowserDocumentVersion = typeof PairedBrowserDocumentVersion.Type;

export const PairedBrowserProfileKind = Schema.Literal("private", "personal", "project", "account");
export type PairedBrowserProfileKind = typeof PairedBrowserProfileKind.Type;

export const PairedBrowserTarget = Schema.Struct({
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
  tabId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  documentVersion: PairedBrowserDocumentVersion,
  profileKind: PairedBrowserProfileKind,
  originPolicyVersion: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
}).annotations(strict);
export type PairedBrowserTarget = typeof PairedBrowserTarget.Type;

export const PairedBrowserPoint = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
}).annotations(strict);
export type PairedBrowserPoint = typeof PairedBrowserPoint.Type;

export const PairedBrowserKeyModifiers = Schema.Struct({
  alt: Schema.optional(Schema.Boolean),
  control: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type PairedBrowserKeyModifiers = typeof PairedBrowserKeyModifiers.Type;

/**
 * Closed input union dispatched through touch, scroll-gesture, key, text, and
 * IME debugger commands. Mouse events are absent so Electron's local input gate
 * sees only the person at the computer.
 */
export const PairedBrowserInput = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("tap"),
    frameId: PositiveSequence,
    x: Coordinate,
    y: Coordinate,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("long-press"),
    frameId: PositiveSequence,
    x: Coordinate,
    y: Coordinate,
    durationMs: Schema.optional(Schema.Int.pipe(Schema.between(300, 1_500))),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("drag"),
    frameId: PositiveSequence,
    points: Schema.Array(PairedBrowserPoint).pipe(Schema.minItems(2), Schema.maxItems(64)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    frameId: PositiveSequence,
    x: Coordinate,
    y: Coordinate,
    deltaX: Schema.Number.pipe(Schema.between(-2_000, 2_000)),
    deltaY: Schema.Number.pipe(Schema.between(-2_000, 2_000)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("key"),
    phase: Schema.Literal("down", "up"),
    key: Schema.NonEmptyString.pipe(Schema.maxLength(64)),
    code: Schema.NonEmptyString.pipe(Schema.maxLength(64)),
    modifiers: Schema.optional(PairedBrowserKeyModifiers),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.NonEmptyString.pipe(Schema.maxLength(MAX_PAIRED_BROWSER_TEXT_LENGTH)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("composition"),
    phase: Schema.Literal("start", "update", "commit", "cancel"),
    text: Schema.optional(Schema.String.pipe(Schema.maxLength(MAX_PAIRED_BROWSER_TEXT_LENGTH))),
  }).annotations(strict),
);
export type PairedBrowserInput = typeof PairedBrowserInput.Type;

export const PairedBrowserRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("take-over"),
    target: PairedBrowserTarget,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("hand-back", "release"),
    leaseId: PairedBrowserLeaseId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("input"),
    leaseId: PairedBrowserLeaseId,
    sequence: PositiveSequence,
    events: Schema.Array(PairedBrowserInput).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("file-choice"),
    leaseId: PairedBrowserLeaseId,
    chooserId: PairedBrowserChooserId,
    uploadId: PairedBrowserUploadId,
  }).annotations(strict),
);
export type PairedBrowserRequest = typeof PairedBrowserRequest.Type;

export const PairedBrowserStreamRequest = Schema.Struct({
  leaseId: PairedBrowserLeaseId,
}).annotations(strict);
export type PairedBrowserStreamRequest = typeof PairedBrowserStreamRequest.Type;

export const PairedBrowserViewport = Schema.Struct({
  width: Schema.Int.pipe(Schema.between(1, MAX_PAIRED_BROWSER_FRAME_WIDTH)),
  height: Schema.Int.pipe(Schema.between(1, MAX_PAIRED_BROWSER_FRAME_HEIGHT)),
}).annotations(strict);
export type PairedBrowserViewport = typeof PairedBrowserViewport.Type;

export const PairedBrowserWithheldReason = Schema.Literal(
  "private-custody",
  "native-prompt",
  "outside-document",
);
export type PairedBrowserWithheldReason = typeof PairedBrowserWithheldReason.Type;

export const PairedBrowserEndReason = Schema.Literal(
  "handed-back",
  "reclaimed-locally",
  "disconnected",
  "revoked",
  "page-ended",
  "agent-sign-in",
);
export type PairedBrowserEndReason = typeof PairedBrowserEndReason.Type;

const MAX_JPEG_BASE64_LENGTH = Math.ceil((MAX_PAIRED_BROWSER_FRAME_BYTES * 4) / 3) + 8;

export const PairedBrowserStreamEvent = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("frame"),
    frameId: PositiveSequence,
    documentVersion: PairedBrowserDocumentVersion,
    viewport: PairedBrowserViewport,
    devicePixelRatio: Schema.Number.pipe(Schema.between(0.5, 4)),
    jpegBase64: Schema.String.pipe(
      Schema.maxLength(MAX_JPEG_BASE64_LENGTH),
      Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("withheld"),
    reason: PairedBrowserWithheldReason,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("file-chooser"),
    chooserId: PairedBrowserChooserId,
    accept: Schema.Array(Schema.String.pipe(Schema.maxLength(128))).pipe(Schema.maxItems(32)),
    multiple: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("reclaimed-locally"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("ended"),
    reason: PairedBrowserEndReason,
  }).annotations(strict),
);
export type PairedBrowserStreamEvent = typeof PairedBrowserStreamEvent.Type;

export const PairedBrowserRefusalReason = Schema.Literal(
  "remote-control-not-person",
  "browser-page-held-elsewhere",
  "stale-frame",
  "lease-ended",
  "rate-limited",
  "page-not-here",
  "authority-ended",
);
export type PairedBrowserRefusalReason = typeof PairedBrowserRefusalReason.Type;

export const PairedBrowserResponse = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("held"),
    leaseId: PairedBrowserLeaseId,
    expiresAt: UtcTimestamp,
    target: PairedBrowserTarget,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("input"),
    lastAcceptedSequence: PositiveSequence,
    effect: Schema.Literal("none", "possible", "completed"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("released"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: PairedBrowserRefusalReason,
    effect: Schema.optional(Schema.Literal("none", "possible", "completed")),
    retryAfterSeconds: Schema.optional(Schema.Int.pipe(Schema.between(1, 3_600))),
  }).annotations(strict),
);
export type PairedBrowserResponse = typeof PairedBrowserResponse.Type;

export const decodePairedBrowserLeaseId = Schema.decodeUnknownSync(PairedBrowserLeaseId);
export const decodePairedBrowserChooserId = Schema.decodeUnknownSync(PairedBrowserChooserId);
export const decodePairedBrowserUploadId = Schema.decodeUnknownSync(PairedBrowserUploadId);
export const decodePairedBrowserTarget = Schema.decodeUnknownSync(PairedBrowserTarget);
export const decodePairedBrowserInput = Schema.decodeUnknownSync(PairedBrowserInput);
export const decodePairedBrowserRequest = Schema.decodeUnknownSync(PairedBrowserRequest);
export const decodePairedBrowserStreamRequest = Schema.decodeUnknownSync(
  PairedBrowserStreamRequest,
);
export const decodePairedBrowserStreamEvent = Schema.decodeUnknownSync(PairedBrowserStreamEvent);
export const decodePairedBrowserResponse = Schema.decodeUnknownSync(PairedBrowserResponse);

/** Private desktop broker transport. Resource ownership is derived by the server. */
const NativeOwner = Schema.Struct({
  windowId: WindowId,
  threadId: BrowserThreadId,
}).annotations(strict);

export const PairedBrowserNativeTarget = Schema.Struct({
  tabId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  documentVersion: PairedBrowserDocumentVersion,
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048)),
  originPolicyVersion: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  viewport: PairedBrowserViewport,
  devicePixelRatio: Schema.Number.pipe(Schema.between(0.5, 4)),
}).annotations(strict);
export type PairedBrowserNativeTarget = typeof PairedBrowserNativeTarget.Type;

export const PairedBrowserNativeFileChooser = Schema.Struct({
  chooserId: PairedBrowserChooserId,
  accept: Schema.Array(Schema.String.pipe(Schema.maxLength(128))).pipe(Schema.maxItems(32)),
  multiple: Schema.Boolean,
}).annotations(strict);
export type PairedBrowserNativeFileChooser = typeof PairedBrowserNativeFileChooser.Type;

const NativeResource = { contextId: BrowserContextId, owner: NativeOwner };

export const PairedBrowserNativeCommand = Schema.Union(
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    ...NativeResource,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("claim"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    target: PairedBrowserNativeTarget,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("frame"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("input"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    events: Schema.Array(PairedBrowserInput).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST),
    ),
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("file-choice"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    chooserId: PairedBrowserChooserId,
    /** Host-staged regular file paths only, never client-supplied host paths. */
    paths: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024))).pipe(
      Schema.minItems(1),
      Schema.maxItems(16),
    ),
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("release"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    disposition: Schema.Literal("revoke", "hand-back"),
  }).annotations(strict),
);
export type PairedBrowserNativeCommand = typeof PairedBrowserNativeCommand.Type;

export const PairedBrowserNativeFrame = Schema.Struct({
  frameId: PositiveSequence,
  documentVersion: PairedBrowserDocumentVersion,
  viewport: PairedBrowserViewport,
  devicePixelRatio: Schema.Number.pipe(Schema.between(0.5, 4)),
  jpegBase64: Schema.String.pipe(
    Schema.maxLength(MAX_JPEG_BASE64_LENGTH),
    Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
}).annotations(strict);
export type PairedBrowserNativeFrame = typeof PairedBrowserNativeFrame.Type;

export const PairedBrowserNativeResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("target"),
    target: PairedBrowserNativeTarget,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("claimed", "released", "file-chosen"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("frame"),
    frame: PairedBrowserNativeFrame,
    fileChooser: Schema.optional(PairedBrowserNativeFileChooser),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("withheld"),
    reason: PairedBrowserWithheldReason,
    fileChooser: Schema.optional(PairedBrowserNativeFileChooser),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("input"),
    effect: Schema.Literal("none", "possible", "completed"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.optional(
      Schema.Literal("stale-frame", "reclaimed-locally", "unavailable", "outside-document"),
    ),
  }).annotations(strict),
);
export type PairedBrowserNativeResult = typeof PairedBrowserNativeResult.Type;

export const decodePairedBrowserNativeCommand = Schema.decodeUnknownSync(
  PairedBrowserNativeCommand,
);
export const decodePairedBrowserNativeResult = Schema.decodeUnknownSync(PairedBrowserNativeResult);

export const PAIRED_BROWSER_HOLD_AGGREGATE = "browser-remote-hold";
export const PAIRED_BROWSER_HOLD_STARTED_EVENT = "browser.remote-hold-started@1";
export const PAIRED_BROWSER_HOLD_ENDED_EVENT = "browser.remote-hold-ended@1";

/**
 * Bounded hold metadata only: no typed value, key, coordinate, frame, or
 * address after the first is ever journaled.
 */
export const PairedBrowserHoldStartedPayload = Schema.Struct({
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
  tabId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  profileKind: PairedBrowserProfileKind,
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048)),
  leaseId: PairedBrowserLeaseId,
}).annotations(strict);
export type PairedBrowserHoldStartedPayload = typeof PairedBrowserHoldStartedPayload.Type;

export const PairedBrowserHoldEndedPayload = Schema.Struct({
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
  tabId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  profileKind: PairedBrowserProfileKind,
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048)),
  leaseId: PairedBrowserLeaseId,
  endReason: PairedBrowserEndReason,
  eventCount: Sequence,
  frameCount: Sequence,
}).annotations(strict);
export type PairedBrowserHoldEndedPayload = typeof PairedBrowserHoldEndedPayload.Type;

export const decodePairedBrowserHoldStartedPayload = Schema.decodeUnknownSync(
  PairedBrowserHoldStartedPayload,
);
export const decodePairedBrowserHoldEndedPayload = Schema.decodeUnknownSync(
  PairedBrowserHoldEndedPayload,
);

/**
 * Historical event schema retained strictly so upgraded hosts can still open
 * and replay journals containing records from the retired enrolled-owner
 * Browser control path. No route or service emits this event.
 */
export const LEGACY_OWNER_BROWSER_AUDIT_EVENT = "browser.owner-control-recorded@1";
const LegacyOwnerBrowserControlId = Schema.UUID.pipe(Schema.brand("OwnerBrowserControlId"));
const LegacyOwnerBrowserTargetVersion = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("OwnerBrowserTargetVersion"),
);
export const LegacyOwnerBrowserAuditRecord = Schema.Struct({
  actingPrincipal: OwnerUnlockPrincipal,
  hostMemberId: HubMemberId,
  threadId: CodeThreadId,
  contextId: BrowserContextId,
  controlId: LegacyOwnerBrowserControlId,
  targetVersion: LegacyOwnerBrowserTargetVersion,
  documentRevision: Sequence,
  operation: Schema.Literal("take-over", "input", "hand-back", "revoke"),
  phase: Schema.Literal("admitted", "completed", "possible"),
  inputKind: Schema.optional(Schema.Literal("tap", "scroll", "press", "type")),
}).annotations(strict);
export type LegacyOwnerBrowserAuditRecord = typeof LegacyOwnerBrowserAuditRecord.Type;

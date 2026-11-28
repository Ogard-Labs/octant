import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { HubMemberId, OwnerUnlockPrincipal } from "./hubAndSpokes";
import { WindowId } from "./shell";

const Sequence = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const PositiveSequence = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Coordinate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

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

export const PairedBrowserLeaseId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("PairedBrowserLeaseId"),
);
export type PairedBrowserLeaseId = typeof PairedBrowserLeaseId.Type;

export const PairedBrowserChooserId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("PairedBrowserChooserId"),
);
export type PairedBrowserChooserId = typeof PairedBrowserChooserId.Type;

export const PairedBrowserUploadId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("PairedBrowserUploadId"),
);
export type PairedBrowserUploadId = typeof PairedBrowserUploadId.Type;

export const PairedBrowserDocumentVersion = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  Schema.brand("PairedBrowserDocumentVersion"),
);
export type PairedBrowserDocumentVersion = typeof PairedBrowserDocumentVersion.Type;

export const PairedBrowserProfileKind = Schema.Literals([
  "private",
  "personal",
  "project",
  "account",
]);
export type PairedBrowserProfileKind = typeof PairedBrowserProfileKind.Type;

export const PairedBrowserTarget = Schema.Struct({
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
  tabId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  documentVersion: PairedBrowserDocumentVersion,
  profileKind: PairedBrowserProfileKind,
  originPolicyVersion: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
});
export type PairedBrowserTarget = typeof PairedBrowserTarget.Type;

export const PairedBrowserPoint = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
});
export type PairedBrowserPoint = typeof PairedBrowserPoint.Type;

export const PairedBrowserKeyModifiers = Schema.Struct({
  alt: Schema.optional(Schema.Boolean),
  control: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
});
export type PairedBrowserKeyModifiers = typeof PairedBrowserKeyModifiers.Type;

/**
 * Closed input union dispatched through touch, scroll-gesture, key, text, and
 * IME debugger commands. Mouse events are absent so Electron's local input gate
 * sees only the person at the computer.
 */
export const PairedBrowserInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tap"),
    frameId: PositiveSequence,
    x: Coordinate,
    y: Coordinate,
  }),
  Schema.Struct({
    kind: Schema.Literal("long-press"),
    frameId: PositiveSequence,
    x: Coordinate,
    y: Coordinate,
    durationMs: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 300, maximum: 1_500 })),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("drag"),
    frameId: PositiveSequence,
    points: Schema.Array(PairedBrowserPoint).check(Schema.isMinLength(2), Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    frameId: PositiveSequence,
    x: Coordinate,
    y: Coordinate,
    deltaX: Schema.Number.check(Schema.isBetween({ minimum: -2_000, maximum: 2_000 })),
    deltaY: Schema.Number.check(Schema.isBetween({ minimum: -2_000, maximum: 2_000 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    phase: Schema.Literals(["down", "up"]),
    key: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
    code: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
    modifiers: Schema.optional(PairedBrowserKeyModifiers),
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_PAIRED_BROWSER_TEXT_LENGTH)),
  }),
  Schema.Struct({
    kind: Schema.Literal("composition"),
    phase: Schema.Literals(["start", "update", "commit", "cancel"]),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_PAIRED_BROWSER_TEXT_LENGTH))),
  }),
]);
export type PairedBrowserInput = typeof PairedBrowserInput.Type;

export const PairedBrowserRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("take-over"),
    target: PairedBrowserTarget,
  }),
  Schema.Struct({
    kind: Schema.Literals(["hand-back", "release"]),
    leaseId: PairedBrowserLeaseId,
  }),
  Schema.Struct({
    kind: Schema.Literal("input"),
    leaseId: PairedBrowserLeaseId,
    sequence: PositiveSequence,
    events: Schema.Array(PairedBrowserInput).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("file-choice"),
    leaseId: PairedBrowserLeaseId,
    chooserId: PairedBrowserChooserId,
    uploadId: PairedBrowserUploadId,
  }),
]);
export type PairedBrowserRequest = typeof PairedBrowserRequest.Type;

export const PairedBrowserStreamRequest = Schema.Struct({
  leaseId: PairedBrowserLeaseId,
});
export type PairedBrowserStreamRequest = typeof PairedBrowserStreamRequest.Type;

export const PairedBrowserViewport = Schema.Struct({
  width: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_PAIRED_BROWSER_FRAME_WIDTH }),
  ),
  height: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_PAIRED_BROWSER_FRAME_HEIGHT }),
  ),
});
export type PairedBrowserViewport = typeof PairedBrowserViewport.Type;

export const PairedBrowserWithheldReason = Schema.Literals([
  "private-custody",
  "native-prompt",
  "outside-document",
]);
export type PairedBrowserWithheldReason = typeof PairedBrowserWithheldReason.Type;

export const PairedBrowserEndReason = Schema.Literals([
  "handed-back",
  "reclaimed-locally",
  "disconnected",
  "revoked",
  "page-ended",
  "agent-sign-in",
]);
export type PairedBrowserEndReason = typeof PairedBrowserEndReason.Type;

const MAX_JPEG_BASE64_LENGTH = Math.ceil((MAX_PAIRED_BROWSER_FRAME_BYTES * 4) / 3) + 8;

export const PairedBrowserStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("frame"),
    frameId: PositiveSequence,
    documentVersion: PairedBrowserDocumentVersion,
    viewport: PairedBrowserViewport,
    devicePixelRatio: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 4 })),
    jpegBase64: Schema.String.check(
      Schema.isMaxLength(MAX_JPEG_BASE64_LENGTH),
      Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("withheld"),
    reason: PairedBrowserWithheldReason,
  }),
  Schema.Struct({
    kind: Schema.Literal("file-chooser"),
    chooserId: PairedBrowserChooserId,
    accept: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
      Schema.isMaxLength(32),
    ),
    multiple: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("reclaimed-locally"),
  }),
  Schema.Struct({
    kind: Schema.Literal("ended"),
    reason: PairedBrowserEndReason,
  }),
]);
export type PairedBrowserStreamEvent = typeof PairedBrowserStreamEvent.Type;

export const PairedBrowserRefusalReason = Schema.Literals([
  "remote-control-not-person",
  "browser-page-held-elsewhere",
  "stale-frame",
  "lease-ended",
  "rate-limited",
  "page-not-here",
  "authority-ended",
]);
export type PairedBrowserRefusalReason = typeof PairedBrowserRefusalReason.Type;

export const PairedBrowserResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("held"),
    leaseId: PairedBrowserLeaseId,
    expiresAt: UtcTimestamp,
    target: PairedBrowserTarget,
  }),
  Schema.Struct({
    status: Schema.Literal("input"),
    lastAcceptedSequence: PositiveSequence,
    effect: Schema.Literals(["none", "possible", "completed"]),
  }),
  Schema.Struct({
    status: Schema.Literal("released"),
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: PairedBrowserRefusalReason,
    effect: Schema.optional(Schema.Literals(["none", "possible", "completed"])),
    retryAfterSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600 })),
    ),
  }),
]);
export type PairedBrowserResponse = typeof PairedBrowserResponse.Type;

export const decodePairedBrowserLeaseId = Schema.decodeUnknownSync(
  PairedBrowserLeaseId,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserChooserId = Schema.decodeUnknownSync(
  PairedBrowserChooserId,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserUploadId = Schema.decodeUnknownSync(
  PairedBrowserUploadId,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserTarget = Schema.decodeUnknownSync(
  PairedBrowserTarget,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserInput = Schema.decodeUnknownSync(
  PairedBrowserInput,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserRequest = Schema.decodeUnknownSync(
  PairedBrowserRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserStreamRequest = Schema.decodeUnknownSync(
  PairedBrowserStreamRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserStreamEvent = Schema.decodeUnknownSync(
  PairedBrowserStreamEvent,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserResponse = Schema.decodeUnknownSync(
  PairedBrowserResponse,
  STRICT_DECODE_OPTIONS,
);

/** Private desktop broker transport. Resource ownership is derived by the server. */
const NativeOwner = Schema.Struct({
  windowId: WindowId,
  threadId: BrowserThreadId,
});

export const PairedBrowserNativeTarget = Schema.Struct({
  tabId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  documentVersion: PairedBrowserDocumentVersion,
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  originPolicyVersion: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  viewport: PairedBrowserViewport,
  devicePixelRatio: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 4 })),
});
export type PairedBrowserNativeTarget = typeof PairedBrowserNativeTarget.Type;

export const PairedBrowserNativeFileChooser = Schema.Struct({
  chooserId: PairedBrowserChooserId,
  accept: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(32)),
  multiple: Schema.Boolean,
});
export type PairedBrowserNativeFileChooser = typeof PairedBrowserNativeFileChooser.Type;

const NativeResource = { contextId: BrowserContextId, owner: NativeOwner };

export const PairedBrowserNativeCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("inspect"),
    ...NativeResource,
  }),
  Schema.Struct({
    operation: Schema.Literal("claim"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    target: PairedBrowserNativeTarget,
  }),
  Schema.Struct({
    operation: Schema.Literal("frame"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
  }),
  Schema.Struct({
    operation: Schema.Literal("input"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    events: Schema.Array(PairedBrowserInput).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_PAIRED_BROWSER_EVENTS_PER_REQUEST),
    ),
  }),
  Schema.Struct({
    operation: Schema.Literal("file-choice"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    chooserId: PairedBrowserChooserId,
    /** Host-staged regular file paths only, never client-supplied host paths. */
    paths: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16),
    ),
  }),
  Schema.Struct({
    operation: Schema.Literal("release"),
    ...NativeResource,
    leaseId: PairedBrowserLeaseId,
    disposition: Schema.Literals(["revoke", "hand-back"]),
  }),
]);
export type PairedBrowserNativeCommand = typeof PairedBrowserNativeCommand.Type;

export const PairedBrowserNativeFrame = Schema.Struct({
  frameId: PositiveSequence,
  documentVersion: PairedBrowserDocumentVersion,
  viewport: PairedBrowserViewport,
  devicePixelRatio: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 4 })),
  jpegBase64: Schema.String.check(
    Schema.isMaxLength(MAX_JPEG_BASE64_LENGTH),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});
export type PairedBrowserNativeFrame = typeof PairedBrowserNativeFrame.Type;

export const PairedBrowserNativeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("target"),
    target: PairedBrowserNativeTarget,
  }),
  Schema.Struct({
    status: Schema.Literals(["claimed", "released", "file-chosen"]),
  }),
  Schema.Struct({
    status: Schema.Literal("frame"),
    frame: PairedBrowserNativeFrame,
    fileChooser: Schema.optional(PairedBrowserNativeFileChooser),
  }),
  Schema.Struct({
    status: Schema.Literal("withheld"),
    reason: PairedBrowserWithheldReason,
    fileChooser: Schema.optional(PairedBrowserNativeFileChooser),
  }),
  Schema.Struct({
    status: Schema.Literal("input"),
    effect: Schema.Literals(["none", "possible", "completed"]),
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.optional(
      Schema.Literals(["stale-frame", "reclaimed-locally", "unavailable", "outside-document"]),
    ),
  }),
]);
export type PairedBrowserNativeResult = typeof PairedBrowserNativeResult.Type;

export const decodePairedBrowserNativeCommand = Schema.decodeUnknownSync(
  PairedBrowserNativeCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserNativeResult = Schema.decodeUnknownSync(
  PairedBrowserNativeResult,
  STRICT_DECODE_OPTIONS,
);

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
  tabId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  profileKind: PairedBrowserProfileKind,
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  leaseId: PairedBrowserLeaseId,
});
export type PairedBrowserHoldStartedPayload = typeof PairedBrowserHoldStartedPayload.Type;

export const PairedBrowserHoldEndedPayload = Schema.Struct({
  threadId: BrowserThreadId,
  contextId: BrowserContextId,
  tabId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  profileKind: PairedBrowserProfileKind,
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  leaseId: PairedBrowserLeaseId,
  endReason: PairedBrowserEndReason,
  eventCount: Sequence,
  frameCount: Sequence,
});
export type PairedBrowserHoldEndedPayload = typeof PairedBrowserHoldEndedPayload.Type;

export const decodePairedBrowserHoldStartedPayload = Schema.decodeUnknownSync(
  PairedBrowserHoldStartedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodePairedBrowserHoldEndedPayload = Schema.decodeUnknownSync(
  PairedBrowserHoldEndedPayload,
  STRICT_DECODE_OPTIONS,
);

/**
 * Historical event schema retained strictly so upgraded hosts can still open
 * and replay journals containing records from the retired enrolled-owner
 * Browser control path. No route or service emits this event.
 */
export const LEGACY_OWNER_BROWSER_AUDIT_EVENT = "browser.owner-control-recorded@1";
const LegacyOwnerBrowserControlId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("OwnerBrowserControlId"),
);
const LegacyOwnerBrowserTargetVersion = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
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
  operation: Schema.Literals(["take-over", "input", "hand-back", "revoke"]),
  phase: Schema.Literals(["admitted", "completed", "possible"]),
  inputKind: Schema.optional(Schema.Literals(["tap", "scroll", "press", "type"])),
});
export type LegacyOwnerBrowserAuditRecord = typeof LegacyOwnerBrowserAuditRecord.Type;

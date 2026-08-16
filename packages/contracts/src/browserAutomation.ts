import { Schema } from "effect";
import { CorrelationId, UtcTimestamp } from "./events";
import { ToolActionAuthority, ToolActionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
export const MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS = 54 * 1024;

export const BrowserContextId = brandedUuid("BrowserContextId");
export type BrowserContextId = typeof BrowserContextId.Type;
export const BrowserThreadId = brandedUuid("BrowserThreadId");
export type BrowserThreadId = typeof BrowserThreadId.Type;

export const BrowserProfileMode = Schema.Literal("isolated", "existing-profile");
export type BrowserProfileMode = typeof BrowserProfileMode.Type;

export const BrowserContextPolicy = Schema.Struct({
  profileMode: BrowserProfileMode,
  allowedOrigins: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
  credentialFieldProtection: Schema.Boolean,
  maxConcurrentTabs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(16)),
  sessionTimeoutMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(3_600_000)),
  /**
   * Accept this context's own localhost certificate. A dev server on
   * HTTPS presents a self-signed localhost certificate, and the design allows
   * the isolated tab opened for it to accept that one certificate. The host
   * refuses the flag unless every allowed origin is a loopback HTTPS origin, so
   * acceptance can never reach beyond the single local server this context was
   * created for, and Octant still installs no trust root.
   */
  acceptsLocalCertificate: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type BrowserContextPolicy = typeof BrowserContextPolicy.Type;

export const BrowserContextState = Schema.Literal(
  "creating",
  "active",
  "stopping",
  "stopped",
  "expired",
  "failed",
);
export type BrowserContextState = typeof BrowserContextState.Type;

export const BrowserPresentationKind = Schema.Literal("native-live", "headless");
export type BrowserPresentationKind = typeof BrowserPresentationKind.Type;

export const BrowserContextRecord = Schema.Struct({
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  policy: BrowserContextPolicy,
  presentation: Schema.optional(BrowserPresentationKind),
  state: BrowserContextState,
  createdAt: UtcTimestamp,
  stoppedAt: Schema.optional(UtcTimestamp),
  stopReason: Schema.optional(
    Schema.Literal("user-requested", "timeout", "authority-revoked", "shutdown", "error"),
  ),
}).annotations(strict);
export type BrowserContextRecord = typeof BrowserContextRecord.Type;

export const BrowserActionKind = Schema.Literal(
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "screenshot",
  "extract-text",
  "wait",
  "close-tab",
);
export type BrowserActionKind = typeof BrowserActionKind.Type;

export const BrowserViewportPoint = Schema.Struct({
  x: Schema.Number.pipe(Schema.between(0, 1)),
  y: Schema.Number.pipe(Schema.between(0, 1)),
}).annotations(strict);
export type BrowserViewportPoint = typeof BrowserViewportPoint.Type;

export const BrowserViewportSize = Schema.Struct({
  width: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(8192)),
  height: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(8192)),
}).annotations(strict);
export type BrowserViewportSize = typeof BrowserViewportSize.Type;

export const BrowserActionRequest = Schema.Struct({
  actionId: ToolActionId,
  contextId: BrowserContextId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: BrowserActionKind,
  target: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  value: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536))),
  point: Schema.optional(BrowserViewportPoint),
  deltaX: Schema.optional(Schema.Number.pipe(Schema.between(-2000, 2000))),
  deltaY: Schema.optional(Schema.Number.pipe(Schema.between(-2000, 2000))),
  expectedObservationRevision: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
}).annotations(strict);
export type BrowserActionRequest = typeof BrowserActionRequest.Type;

export const BrowserObservation = Schema.Struct({
  contextId: BrowserContextId,
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  url: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  title: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  contentHash: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  extractedText: Schema.optional(Schema.String.pipe(Schema.maxLength(65_536))),
  screenshotDataUrl: Schema.optional(
    Schema.String.pipe(
      Schema.maxLength(MAX_BROWSER_SCREENSHOT_DATA_URL_CHARACTERS),
      Schema.pattern(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/),
    ),
  ),
  viewport: Schema.optional(BrowserViewportSize),
  revision: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  observedAt: UtcTimestamp,
  stale: Schema.Boolean,
}).annotations(strict);
export type BrowserObservation = typeof BrowserObservation.Type;

export const BrowserAutomationFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("policy-denied"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("context-expired"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("credential-protected"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("interrupted"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("failed"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("stale"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type BrowserAutomationFailure = typeof BrowserAutomationFailure.Type;

export const decodeBrowserContextId = Schema.decodeUnknownSync(BrowserContextId);
export const decodeBrowserThreadId = Schema.decodeUnknownSync(BrowserThreadId);
export const decodeBrowserProfileMode = Schema.decodeUnknownSync(BrowserProfileMode);
export const decodeBrowserContextPolicy = Schema.decodeUnknownSync(BrowserContextPolicy);
export const decodeBrowserContextState = Schema.decodeUnknownSync(BrowserContextState);
export const decodeBrowserPresentationKind = Schema.decodeUnknownSync(BrowserPresentationKind);
export const decodeBrowserContextRecord = Schema.decodeUnknownSync(BrowserContextRecord);
export const decodeBrowserActionKind = Schema.decodeUnknownSync(BrowserActionKind);
export const decodeBrowserActionRequest = Schema.decodeUnknownSync(BrowserActionRequest);
export const decodeBrowserObservation = Schema.decodeUnknownSync(BrowserObservation);
export const decodeBrowserAutomationFailure = Schema.decodeUnknownSync(BrowserAutomationFailure);

import { Schema } from "effect";
import { BrowserContextId, BrowserThreadId } from "./browserAutomation";
import { WindowId } from "./shell";
import { CodeThreadId } from "./code";
import { HubMemberId, OwnerUnlockPrincipal } from "./hubAndSpokes";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Sequence = Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER));
const Coordinate = Schema.Number.pipe(Schema.between(0, 1));
export const MAX_OWNER_BROWSER_CONTROL_MS = 60_000;
export const MAX_OWNER_BROWSER_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_OWNER_BROWSER_FRAME_WIDTH = 1920;
export const MAX_OWNER_BROWSER_FRAME_HEIGHT = 1200;
export const OwnerBrowserControlId = Schema.UUID.pipe(Schema.brand("OwnerBrowserControlId"));
export type OwnerBrowserControlId = typeof OwnerBrowserControlId.Type;
export const OwnerBrowserTargetVersion = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("OwnerBrowserTargetVersion"),
);
export const OwnerBrowserTarget = Schema.Struct({
  hostMemberId: HubMemberId,
  threadId: CodeThreadId,
  contextId: BrowserContextId,
  targetVersion: OwnerBrowserTargetVersion,
  documentRevision: Sequence,
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  profile: Schema.Literal("private"),
}).annotations(strict);
export type OwnerBrowserTarget = typeof OwnerBrowserTarget.Type;
export const OwnerBrowserTargetDescriptor = Schema.Struct({
  target: OwnerBrowserTarget,
  threadTitle: Schema.String.pipe(Schema.maxLength(200)),
  controllerName: Schema.optional(Schema.String.pipe(Schema.maxLength(128))),
}).annotations(strict);

export const OwnerBrowserInput = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("tap"), x: Coordinate, y: Coordinate }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    x: Coordinate,
    y: Coordinate,
    deltaX: Schema.Number.pipe(Schema.between(-2000, 2000)),
    deltaY: Schema.Number.pipe(Schema.between(-2000, 2000)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("press"),
    key: Schema.Literal(
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Escape",
      "Home",
      "End",
      "Space",
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.NonEmptyString.pipe(Schema.maxLength(4096)),
  }).annotations(strict),
);
export type OwnerBrowserInput = typeof OwnerBrowserInput.Type;
const ControlUse = {
  controlId: OwnerBrowserControlId,
  sequence: Sequence.pipe(Schema.greaterThan(0)),
};
export const OwnerBrowserRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("targets") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("take-over"), target: OwnerBrowserTarget }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("frame", "hand-back", "stop"), ...ControlUse }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("input"),
    ...ControlUse,
    expectedFrame: Sequence.pipe(Schema.greaterThan(0)),
    input: OwnerBrowserInput,
  }).annotations(strict),
);
export type OwnerBrowserRequest = typeof OwnerBrowserRequest.Type;
export const OwnerBrowserControl = Schema.Struct({
  id: OwnerBrowserControlId,
  target: OwnerBrowserTarget,
  expiresAt: UtcTimestamp,
  controllerName: Schema.String.pipe(Schema.maxLength(128)),
  nextSequence: Sequence.pipe(Schema.greaterThan(0)),
}).annotations(strict);
export type OwnerBrowserControl = typeof OwnerBrowserControl.Type;
export const OwnerBrowserFrame = Schema.Struct({
  sequence: Sequence.pipe(Schema.greaterThan(0)),
  documentRevision: Sequence,
  width: Schema.Int.pipe(Schema.between(1, MAX_OWNER_BROWSER_FRAME_WIDTH)),
  height: Schema.Int.pipe(Schema.between(1, MAX_OWNER_BROWSER_FRAME_HEIGHT)),
  dataUrl: Schema.String.pipe(
    Schema.maxLength(Math.ceil((MAX_OWNER_BROWSER_FRAME_BYTES * 4) / 3) + 32),
    Schema.pattern(/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/),
  ),
}).annotations(strict);
export type OwnerBrowserFrame = typeof OwnerBrowserFrame.Type;
export const OwnerBrowserRefusal = Schema.Literal(
  "unauthorized",
  "unsupported",
  "stale-target",
  "private-held",
  "controller-busy",
  "unlock-required",
  "expired",
  "stale-sequence",
  "stale-frame",
  "unavailable",
  "audit-unavailable",
);
export type OwnerBrowserRefusal = typeof OwnerBrowserRefusal.Type;
export const OwnerBrowserResponse = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("targets"),
    targets: Schema.Array(OwnerBrowserTargetDescriptor).pipe(Schema.maxItems(16)),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("controlled"), control: OwnerBrowserControl }).annotations(
    strict,
  ),
  Schema.Struct({
    status: Schema.Literal("frame"),
    control: OwnerBrowserControl,
    frame: OwnerBrowserFrame,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("input"),
    effect: Schema.Literal("none", "possible", "completed"),
    nextSequence: Sequence.pipe(Schema.greaterThan(0)),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("released") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: OwnerBrowserRefusal,
    effect: Schema.optional(Schema.Literal("none", "possible", "completed")),
  }).annotations(strict),
);
export type OwnerBrowserResponse = typeof OwnerBrowserResponse.Type;
export const decodeOwnerBrowserTarget = Schema.decodeUnknownSync(OwnerBrowserTarget);
export const decodeOwnerBrowserControlId = Schema.decodeUnknownSync(OwnerBrowserControlId);
export const decodeOwnerBrowserRequest = Schema.decodeUnknownSync(OwnerBrowserRequest);
export const decodeOwnerBrowserResponse = Schema.decodeUnknownSync(OwnerBrowserResponse);

/** Private native transport. Resource ownership is derived by the server, never the owner client. */
const NativeOwner = Schema.Struct({ windowId: WindowId, threadId: BrowserThreadId }).annotations(
  strict,
);
export const OwnerBrowserNativeTarget = Schema.Struct({
  targetVersion: OwnerBrowserTargetVersion,
  documentRevision: Sequence,
  origin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
}).annotations(strict);
export type OwnerBrowserNativeTarget = typeof OwnerBrowserNativeTarget.Type;
const NativeResource = { contextId: BrowserContextId, owner: NativeOwner };
export const OwnerBrowserNativeCommand = Schema.Union(
  Schema.Struct({ operation: Schema.Literal("inspect"), ...NativeResource }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("claim"),
    ...NativeResource,
    controlId: OwnerBrowserControlId,
    target: OwnerBrowserNativeTarget,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("frame"),
    ...NativeResource,
    ...ControlUse,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("input"),
    ...NativeResource,
    ...ControlUse,
    expectedFrame: Sequence.pipe(Schema.greaterThan(0)),
    input: OwnerBrowserInput,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("release"),
    ...NativeResource,
    controlId: OwnerBrowserControlId,
    /** A hand-back resumes the agent, so it confirms only a controller that is still current. */
    disposition: Schema.Literal("revoke", "hand-back"),
  }).annotations(strict),
);
export type OwnerBrowserNativeCommand = typeof OwnerBrowserNativeCommand.Type;
export const OwnerBrowserNativeResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("target"), target: OwnerBrowserNativeTarget }).annotations(
    strict,
  ),
  Schema.Struct({ status: Schema.Literal("claimed", "released") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("frame"), frame: OwnerBrowserFrame }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("input"),
    effect: Schema.Literal("none", "possible", "completed"),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("refused") }).annotations(strict),
);
export type OwnerBrowserNativeResult = typeof OwnerBrowserNativeResult.Type;
export const decodeOwnerBrowserNativeCommand = Schema.decodeUnknownSync(OwnerBrowserNativeCommand);
export const decodeOwnerBrowserNativeResult = Schema.decodeUnknownSync(OwnerBrowserNativeResult);

export const OWNER_BROWSER_AUDIT_EVENT = "browser.owner-control-recorded@1";
export const OWNER_BROWSER_AUDIT_AGGREGATE = "owner-browser-control";
/** Metadata only. Origins, inputs, frames and control capabilities are not audit content. */
export const OwnerBrowserAuditRecord = Schema.Struct({
  actingPrincipal: OwnerUnlockPrincipal,
  hostMemberId: HubMemberId,
  threadId: CodeThreadId,
  contextId: BrowserContextId,
  controlId: OwnerBrowserControlId,
  targetVersion: OwnerBrowserTargetVersion,
  documentRevision: Sequence,
  operation: Schema.Literal("take-over", "input", "hand-back", "revoke"),
  phase: Schema.Literal("admitted", "completed", "possible"),
  inputKind: Schema.optional(Schema.Literal("tap", "scroll", "press", "type")),
}).annotations(strict);
export const decodeOwnerBrowserAuditRecord = Schema.decodeUnknownSync(OwnerBrowserAuditRecord);

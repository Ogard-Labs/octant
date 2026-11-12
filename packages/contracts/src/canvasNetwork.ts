import { Schema } from "effect";
import { CanvasId } from "./canvasIdentity";

// One Canvas's "Allow network" switch, as a window reads and sets it. The
// schemas carry only the Canvas and the choice: who may set it, and what a
// running page may then reach, are the host's decisions
// (docs/design/canvas.md § Allow network).

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const CANVAS_NETWORK_ACCESS_SCHEMA_VERSION = 1 as const;

/**
 * Where a running page asks the host to fetch for it:
 * `/api/canvas/network/<token>/fetch?url=`. The page's policy names the path
 * through the token and its trailing slash, so no other path on the host is
 * within the page's reach.
 */
export const CANVAS_NETWORK_PROXY_PATH_PREFIX = "/api/canvas/network/";

/** A person turns one Canvas's network on or off. */
export const CanvasNetworkAccessCommand = Schema.Struct({
  schemaVersion: Schema.Literal(CANVAS_NETWORK_ACCESS_SCHEMA_VERSION),
  kind: Schema.Literal("set-canvas-network-access"),
  canvasId: CanvasId,
  allowed: Schema.Boolean,
}).annotations(strict);
export type CanvasNetworkAccessCommand = typeof CanvasNetworkAccessCommand.Type;

/** The switch as it stands for one Canvas. */
export const CanvasNetworkAccessView = Schema.Struct({
  kind: Schema.Literal("canvas-network-access"),
  canvasId: CanvasId,
  allowed: Schema.Boolean,
}).annotations(strict);
export type CanvasNetworkAccessView = typeof CanvasNetworkAccessView.Type;

export const CanvasNetworkAccessRefusalReason = Schema.Literal(
  "malformed",
  "canvas-unavailable",
  // Only a person at a local window sets the switch.
  "local-window-required",
  "unavailable",
);
export type CanvasNetworkAccessRefusalReason = typeof CanvasNetworkAccessRefusalReason.Type;

export const CanvasNetworkAccessResult = Schema.Union(
  CanvasNetworkAccessView,
  Schema.Struct({
    kind: Schema.Literal("canvas-network-access-refused"),
    reason: CanvasNetworkAccessRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type CanvasNetworkAccessResult = typeof CanvasNetworkAccessResult.Type;

export const CANVAS_NETWORK_ACCESS_AGGREGATE_TYPE = "canvas-network-access";
export const CANVAS_NETWORK_ACCESS_CHANGED = "canvas.network-access-changed@1";

/** One change of one Canvas's switch, as the journal holds it. */
export const CanvasNetworkAccessChanged = Schema.Struct({
  canvasId: CanvasId,
  allowed: Schema.Boolean,
}).annotations(strict);
export type CanvasNetworkAccessChanged = typeof CanvasNetworkAccessChanged.Type;

export const decodeCanvasNetworkAccessCommand = Schema.decodeUnknownSync(
  CanvasNetworkAccessCommand,
);
export const decodeCanvasNetworkAccessView = Schema.decodeUnknownSync(CanvasNetworkAccessView);
export const decodeCanvasNetworkAccessResult = Schema.decodeUnknownSync(CanvasNetworkAccessResult);
export const decodeCanvasNetworkAccessChanged = Schema.decodeUnknownSync(
  CanvasNetworkAccessChanged,
);

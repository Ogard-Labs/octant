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

/**
 * Where a page drawn by the desktop app's prototype host asks instead:
 * `octant-prototype://network/<surface id>/fetch?url=`. It is an address of
 * the prototype host's private scheme, which no network serves; the desktop
 * relays what arrives there to the proxy path above under a token the page
 * never holds.
 */
export const CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX = "octant-prototype://network/";

/**
 * Sent by the desktop's main process with its bridge secret when it asks for
 * a design page: the surface the prototype host will draw the page on.
 */
export const CANVAS_PROTOTYPE_SURFACE_HEADER = "x-octant-prototype-surface";

/**
 * Answered to the desktop's main process alone: the network token of the page
 * it asked for, which it keeps and the page is never given.
 */
export const CANVAS_NETWORK_TOKEN_HEADER = "x-octant-canvas-network-token";

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

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
 * `/api/canvas/network/<token>/fetch?url=` for a script's request, and
 * `/image?url=` and `/font?url=` beside it for what an element or a
 * stylesheet loads. The page's policy names the paths under the token, so no
 * other path on the host is within the page's reach.
 */
export const CANVAS_NETWORK_PROXY_PATH_PREFIX = "/api/canvas/network/";

/**
 * Where a page drawn by the desktop app's prototype host asks instead:
 * `octant-prototype://network/<surface id>/` and then `fetch?url=`,
 * `image?url=`, or `font?url=`. It is an address of the prototype host's
 * private scheme, which no network serves; the desktop relays what arrives
 * there to the proxy path above under a token the page never holds.
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

/**
 * How often the window that holds an open page whose Canvas has the network
 * on asks the host to keep that page's token alive. The token lives one hour
 * unrenewed, so one missed renewal (a window asleep, a host restarting) costs
 * the page nothing.
 */
export const CANVAS_NETWORK_PAGE_RENEW_INTERVAL_MS = 20 * 60 * 1_000;

/**
 * A window keeps one page it ran alive. The page is named by the single-use
 * ticket the window ran it with; the token is the page's, and is never an
 * argument of anything a window sends.
 */
export const CanvasNetworkPageRenewalCommand = Schema.Struct({
  schemaVersion: Schema.Literal(CANVAS_NETWORK_ACCESS_SCHEMA_VERSION),
  kind: Schema.Literal("renew-canvas-network-page"),
  ticket: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/)),
}).annotations(strict);
export type CanvasNetworkPageRenewalCommand = typeof CanvasNetworkPageRenewalCommand.Type;

export const CanvasNetworkPageRenewalResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("canvas-network-page-renewed") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("canvas-network-page-renewal-refused"),
    // `not-live`: no page run with that ticket holds a token now (it aged
    // out, the switch went off, or the page never had one).
    reason: Schema.Literal("malformed", "local-window-required", "not-live"),
  }).annotations(strict),
);
export type CanvasNetworkPageRenewalResult = typeof CanvasNetworkPageRenewalResult.Type;

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
export const decodeCanvasNetworkPageRenewalCommand = Schema.decodeUnknownSync(
  CanvasNetworkPageRenewalCommand,
);
export const decodeCanvasNetworkPageRenewalResult = Schema.decodeUnknownSync(
  CanvasNetworkPageRenewalResult,
);

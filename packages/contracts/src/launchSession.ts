import { Schema } from "effect";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Opaque, single-use, short-lived token that bootstraps a browser client
 * session. The launcher creates it through the desktop bridge secret and the
 * renderer exchanges it once for the per-window capability. It is transmitted
 * in a URL fragment so it never reaches the server access log.
 */
export const LaunchSessionToken = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  Schema.brand("LaunchSessionToken"),
);
export type LaunchSessionToken = typeof LaunchSessionToken.Type;

/** Canonical 256-bit base64url token shape shared with window authority. */
export const LAUNCH_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isCanonicalLaunchSessionToken(value: unknown): value is string {
  return typeof value === "string" && LAUNCH_SESSION_TOKEN_PATTERN.test(value);
}

/** Admin request body: the launcher creates a launch session for a registered window. */
export const LaunchSessionRequest = Schema.Struct({
  windowId: WindowId,
  capability: Schema.String.pipe(Schema.pattern(LAUNCH_SESSION_TOKEN_PATTERN)),
}).annotations(strict);
export type LaunchSessionRequest = typeof LaunchSessionRequest.Type;

/** Admin response body: the single-use token and its absolute expiry epoch milliseconds. */
export const LaunchSessionReceipt = Schema.Struct({
  launchToken: LaunchSessionToken,
  expiresAt: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type LaunchSessionReceipt = typeof LaunchSessionReceipt.Type;

/** Renderer request body: exchange a single-use token for the window capability. */
export const LaunchSessionExchangeRequest = Schema.Struct({
  launchToken: LaunchSessionToken,
}).annotations(strict);
export type LaunchSessionExchangeRequest = typeof LaunchSessionExchangeRequest.Type;

/** Renderer response body: the authenticated window identity and capability. */
export const LaunchSessionExchange = Schema.Struct({
  windowId: WindowId,
  capability: Schema.String.pipe(Schema.pattern(LAUNCH_SESSION_TOKEN_PATTERN)),
}).annotations(strict);
export type LaunchSessionExchange = typeof LaunchSessionExchange.Type;

export const LaunchSessionFailure = Schema.Union(
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
);
export type LaunchSessionFailure = typeof LaunchSessionFailure.Type;

export const decodeLaunchSessionRequest = Schema.decodeUnknownSync(LaunchSessionRequest);
export const decodeLaunchSessionReceipt = Schema.decodeUnknownSync(LaunchSessionReceipt);
export const decodeLaunchSessionExchangeRequest = Schema.decodeUnknownSync(
  LaunchSessionExchangeRequest,
);
export const decodeLaunchSessionExchange = Schema.decodeUnknownSync(LaunchSessionExchange);
export const decodeLaunchSessionFailure = Schema.decodeUnknownSync(LaunchSessionFailure);

import { Schema } from "effect";
import { CodeTerminalId, CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { WindowId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The two variables a Code thread terminal is started with when its Browser
 * grant is on. The first is the loopback address of the terminal's own
 * endpoint, the second the bearer token for it. A provider CLI the person types
 * into that terminal inherits them; nothing else on the machine receives them.
 */
export const TERMINAL_BROWSER_ENDPOINT_ENVIRONMENT = "OCTANT_BROWSER_MCP_URL";
export const TERMINAL_BROWSER_TOKEN_ENVIRONMENT = "OCTANT_BROWSER_MCP_TOKEN";

export const TERMINAL_BROWSER_GRANT_EVENT_NAMES = {
  issued: "code.terminal-browser-grant-issued@1",
  revoked: "code.terminal-browser-grant-revoked@1",
} as const;

export const TerminalBrowserGrantId = Schema.UUID.pipe(Schema.brand("TerminalBrowserGrantId"));
export type TerminalBrowserGrantId = typeof TerminalBrowserGrantId.Type;

/**
 * Why the host would not mint, or would not switch off, a grant. Each reason is
 * one the person can act on: `not-local-window` is a paired device asking,
 * `not-a-code-thread` covers an unknown id and a Work or Chat thread alike (a
 * Work thread has no shell, and the answer must not say which it was),
 * `thread-not-active` is an archived or completed thread, `window-cannot-open-thread`
 * is a window that does not hold the thread's Project, `browser-unavailable` is a
 * host or thread that lends no Browser, `terminal-already-granted` is a second
 * grant for a terminal that has one, `no-live-grant` is a switch-off with
 * nothing to switch off, and `grant-unavailable` is a host that could not start
 * the endpoint or record the grant.
 */
export const TerminalBrowserGrantRefusalReason = Schema.Literal(
  "not-local-window",
  "not-a-code-thread",
  "thread-not-active",
  "window-cannot-open-thread",
  "browser-unavailable",
  "terminal-already-granted",
  "no-live-grant",
  "grant-unavailable",
);
export type TerminalBrowserGrantRefusalReason = typeof TerminalBrowserGrantRefusalReason.Type;

/**
 * What ended a grant. `host-stopped` is recorded by a host that shuts down
 * cleanly; one that crashed leaves the record open, and a restarted host mints
 * nothing by itself, so an open record never means a live grant.
 */
export const TerminalBrowserGrantRevokeReason = Schema.Literal(
  "switched-off",
  "terminal-closed",
  "terminal-not-started",
  "thread-completed",
  "thread-archived",
  "thread-deleted",
  "window-revoked",
  "host-stopped",
);
export type TerminalBrowserGrantRevokeReason = typeof TerminalBrowserGrantRevokeReason.Type;

const GrantTarget = {
  grantId: TerminalBrowserGrantId,
  threadId: CodeThreadId,
  terminalId: CodeTerminalId,
} as const;

/**
 * What a local window learns about a terminal's Browser grant. The token and
 * the endpoint address never appear here: they exist only in the environment
 * of the terminal the grant was minted for.
 */
export const TerminalBrowserGrantOutcome = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("granted"),
    ...GrantTarget,
    issuedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: TerminalBrowserGrantRefusalReason,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("revoked"),
    ...GrantTarget,
    reason: TerminalBrowserGrantRevokeReason,
    revokedAt: UtcTimestamp,
  }).annotations(strict),
);
export type TerminalBrowserGrantOutcome = typeof TerminalBrowserGrantOutcome.Type;

/**
 * Journaled when a grant is minted. It records who may drive which thread's
 * Browser from which terminal; it never holds the token or the endpoint.
 */
export const TerminalBrowserGrantIssued = Schema.Struct({
  kind: Schema.Literal("terminal-browser-grant-issued"),
  ...GrantTarget,
  windowId: WindowId,
  issuedAt: UtcTimestamp,
}).annotations(strict);
export type TerminalBrowserGrantIssued = typeof TerminalBrowserGrantIssued.Type;

export const TerminalBrowserGrantRevoked = Schema.Struct({
  kind: Schema.Literal("terminal-browser-grant-revoked"),
  ...GrantTarget,
  reason: TerminalBrowserGrantRevokeReason,
  revokedAt: UtcTimestamp,
}).annotations(strict);
export type TerminalBrowserGrantRevoked = typeof TerminalBrowserGrantRevoked.Type;

export const decodeTerminalBrowserGrantId = Schema.decodeUnknownSync(TerminalBrowserGrantId);
export const decodeTerminalBrowserGrantOutcome = Schema.decodeUnknownSync(
  TerminalBrowserGrantOutcome,
);
export const decodeTerminalBrowserGrantIssued = Schema.decodeUnknownSync(
  TerminalBrowserGrantIssued,
);
export const decodeTerminalBrowserGrantRevoked = Schema.decodeUnknownSync(
  TerminalBrowserGrantRevoked,
);

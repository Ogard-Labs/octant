import { Schema } from "effect";
import { AgentRunId } from "./agentRun";
import { AutomationId } from "./automation";
import { StoredBrowserProfile } from "./browserProfiles";
import { UtcTimestamp } from "./events";
import { TerminalBrowserGrantId } from "./terminalBrowserGrants";
import { ToolActionAuthority } from "./toolActions";
import { WindowId } from "./shell";
import { ProviderModelId } from "./providers";

export const BROWSER_ROUTINE_SESSION_DEFAULT_MINUTES = 7 * 24 * 60;
export const BROWSER_ROUTINE_SESSION_MAX_MINUTES = 30 * 24 * 60;
export const BROWSER_SESSION_PERMISSION_LIMIT = 256;

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const BrowserSessionGrantId = Schema.UUID.pipe(Schema.brand("BrowserSessionGrantId"));
export const BrowserSessionReviewId = Schema.UUID.pipe(Schema.brand("BrowserSessionReviewId"));

export const BrowserSessionGrantee = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("child"), runId: AgentRunId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("routine"), routineId: AutomationId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("terminal"), grantId: TerminalBrowserGrantId }).annotations(
    strict,
  ),
);
export type BrowserSessionGrantee = typeof BrowserSessionGrantee.Type;

export const BrowserSessionTarget = Schema.Struct({
  grantee: BrowserSessionGrantee,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  authority: ToolActionAuthority,
  modelId: ProviderModelId.pipe(Schema.maxLength(256)),
}).annotations(strict);
export type BrowserSessionTarget = typeof BrowserSessionTarget.Type;

const Origins = Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))).pipe(
  Schema.minItems(1),
  Schema.maxItems(16),
);

export const BrowserSessionGrant = Schema.Struct({
  grantId: BrowserSessionGrantId,
  target: BrowserSessionTarget,
  profile: StoredBrowserProfile,
  profileLabel: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  origins: Origins,
  /** Host digest of the recipient definition/workspace revision; never raw paths. */
  recipientRevisionDigest: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/)),
  ),
  grantedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  /** Host-selected during review; never accepted in a grant command. */
  continuesWithoutWindow: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type BrowserSessionGrant = typeof BrowserSessionGrant.Type;

export const BROWSER_SESSION_EVENT_NAMES = {
  granted: "browser.session-granted@1",
  revoked: "browser.session-revoked@1",
  expired: "browser.session-expired@1",
  changed: "browser.session-changed@1",
} as const;
const audit = { grant: BrowserSessionGrant, windowId: Schema.optional(WindowId) };
export const BrowserSessionGranted = Schema.Struct({
  ...audit,
  kind: Schema.Literal("granted"),
}).annotations(strict);
export const BrowserSessionRevoked = Schema.Struct({
  ...audit,
  kind: Schema.Literal("revoked"),
}).annotations(strict);
export const BrowserSessionExpired = Schema.Struct({
  ...audit,
  kind: Schema.Literal("expired"),
}).annotations(strict);
export const BrowserSessionChanged = Schema.Struct({
  ...audit,
  kind: Schema.Literal("changed"),
}).annotations(strict);

export const BrowserSessionGrantsCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("targets") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("review"),
    grantee: BrowserSessionGrantee,
    profile: StoredBrowserProfile,
    origins: Origins,
    durationMinutes: Schema.optional(
      Schema.Int.pipe(Schema.between(1, BROWSER_ROUTINE_SESSION_MAX_MINUTES)),
    ),
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (review) =>
          review.grantee.kind === "routine" ||
          (review.durationMinutes !== undefined && [15, 60, 480].includes(review.durationMinutes)),
      ),
    ),
  Schema.Struct({ kind: Schema.Literal("grant"), reviewId: BrowserSessionReviewId }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("revoke"), grantId: BrowserSessionGrantId }).annotations(
    strict,
  ),
);
export type BrowserSessionGrantsCommand = typeof BrowserSessionGrantsCommand.Type;

export const BrowserSessionGrantsResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("browser-session-targets"),
    targets: Schema.Array(BrowserSessionTarget).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-session-grants"),
    grants: Schema.Array(BrowserSessionGrant).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-session-review"),
    reviewId: BrowserSessionReviewId,
    grant: BrowserSessionGrant,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-session-granted"),
    grant: BrowserSessionGrant,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-session-revoked"),
    grantId: BrowserSessionGrantId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-session-refused"),
    reason: Schema.Literal(
      "not-local",
      "invalid",
      "unavailable",
      "stale",
      "expired",
      "limit",
      "record-failed",
    ),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type BrowserSessionGrantsResult = typeof BrowserSessionGrantsResult.Type;

export const decodeBrowserSessionGrantsCommand = Schema.decodeUnknownSync(
  BrowserSessionGrantsCommand,
);
export const decodeBrowserSessionGrantsResult = Schema.decodeUnknownSync(
  BrowserSessionGrantsResult,
);
export const decodeBrowserSessionGrantId = Schema.decodeUnknownSync(BrowserSessionGrantId);
export const decodeBrowserSessionReviewId = Schema.decodeUnknownSync(BrowserSessionReviewId);

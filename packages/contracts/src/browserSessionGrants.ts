import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

export const BrowserSessionGrantId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserSessionGrantId"),
);
export const BrowserSessionReviewId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserSessionReviewId"),
);

export const BrowserSessionGrantee = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("child"), runId: AgentRunId }),
  Schema.Struct({ kind: Schema.Literal("routine"), routineId: AutomationId }),
  Schema.Struct({ kind: Schema.Literal("terminal"), grantId: TerminalBrowserGrantId }),
]);
export type BrowserSessionGrantee = typeof BrowserSessionGrantee.Type;

export const BrowserSessionTarget = Schema.Struct({
  grantee: BrowserSessionGrantee,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  authority: ToolActionAuthority,
  modelId: ProviderModelId.check(Schema.isMaxLength(256)),
});
export type BrowserSessionTarget = typeof BrowserSessionTarget.Type;

const Origins = Schema.Array(
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
).check(Schema.isMinLength(1), Schema.isMaxLength(16));

export const BrowserSessionGrant = Schema.Struct({
  grantId: BrowserSessionGrantId,
  target: BrowserSessionTarget,
  profile: StoredBrowserProfile,
  profileLabel: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  origins: Origins,
  /** Host digest of the recipient definition/workspace revision; never raw paths. */
  recipientRevisionDigest: Schema.optional(
    Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  ),
  grantedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  /** Host-selected during review; never accepted in a grant command. */
  continuesWithoutWindow: Schema.optional(Schema.Boolean),
  /**
   * Host-selected during review for a routine or managed child, so the person
   * agrees to a grant that outlives the host. A permission journaled without it
   * was reviewed as ending with the host and is never restored.
   */
  survivesRestart: Schema.optional(Schema.Boolean),
});
export type BrowserSessionGrant = typeof BrowserSessionGrant.Type;

export const BROWSER_SESSION_EVENT_NAMES = {
  granted: "browser.session-granted@1",
  revoked: "browser.session-revoked@1",
  expired: "browser.session-expired@1",
  changed: "browser.session-changed@1",
  held: "browser.session-held@1",
  resumed: "browser.session-resumed@1",
} as const;
const audit = { grant: BrowserSessionGrant, windowId: Schema.optional(WindowId) };
export const BrowserSessionGranted = Schema.Struct({
  ...audit,
  kind: Schema.Literal("granted"),
});
export const BrowserSessionRevoked = Schema.Struct({
  ...audit,
  kind: Schema.Literal("revoked"),
});
export const BrowserSessionExpired = Schema.Struct({
  ...audit,
  kind: Schema.Literal("expired"),
});
export const BrowserSessionChanged = Schema.Struct({
  ...audit,
  kind: Schema.Literal("changed"),
});
/**
 * A clean host close attests that a surviving grant was neither revoked nor
 * lapsed when the host ended. A restart restores only a grant whose newest
 * record is this one, and consumes it with `resumed`.
 */
export const BrowserSessionHeld = Schema.Struct({
  ...audit,
  kind: Schema.Literal("held"),
});
export const BrowserSessionResumed = Schema.Struct({
  ...audit,
  kind: Schema.Literal("resumed"),
});

export const BrowserSessionGrantsCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("targets") }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    grantee: BrowserSessionGrantee,
    profile: StoredBrowserProfile,
    origins: Origins,
    durationMinutes: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: BROWSER_ROUTINE_SESSION_MAX_MINUTES }),
      ),
    ),
  }).check(
    Schema.makeFilter(
      (review) =>
        review.grantee.kind === "routine" ||
        (review.durationMinutes !== undefined && [15, 60, 480].includes(review.durationMinutes)),
    ),
  ),
  Schema.Struct({ kind: Schema.Literal("grant"), reviewId: BrowserSessionReviewId }),
  Schema.Struct({ kind: Schema.Literal("revoke"), grantId: BrowserSessionGrantId }),
]);
export type BrowserSessionGrantsCommand = typeof BrowserSessionGrantsCommand.Type;

export const BrowserSessionGrantsResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("browser-session-targets"),
    targets: Schema.Array(BrowserSessionTarget).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-session-grants"),
    grants: Schema.Array(BrowserSessionGrant).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-session-review"),
    reviewId: BrowserSessionReviewId,
    grant: BrowserSessionGrant,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-session-granted"),
    grant: BrowserSessionGrant,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-session-revoked"),
    grantId: BrowserSessionGrantId,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-session-refused"),
    reason: Schema.Literals([
      "not-local",
      "invalid",
      "unavailable",
      "stale",
      "expired",
      "limit",
      "record-failed",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type BrowserSessionGrantsResult = typeof BrowserSessionGrantsResult.Type;

export const decodeBrowserSessionGrantsCommand = Schema.decodeUnknownSync(
  BrowserSessionGrantsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserSessionGrantsResult = Schema.decodeUnknownSync(
  BrowserSessionGrantsResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserSessionGrantId = Schema.decodeUnknownSync(
  BrowserSessionGrantId,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserSessionReviewId = Schema.decodeUnknownSync(
  BrowserSessionReviewId,
  STRICT_DECODE_OPTIONS,
);

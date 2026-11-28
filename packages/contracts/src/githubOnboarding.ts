import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

const SECRETISH =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+|token=|authorization)/i;
const safeText = (limit: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(limit),
    Schema.makeFilter((value) => !SECRETISH.test(value) && !value.includes("\0")),
  );

export const GithubAuthenticationState = Schema.Literals([
  "ready",
  "scope-limited",
  "unauthorized",
  "insecure-storage",
  "external-token",
  "rate-limited",
  "unavailable",
]);
export type GithubAuthenticationState = typeof GithubAuthenticationState.Type;

export const GithubCapabilityKind = Schema.Literals([
  "repository-catalogue",
  "issues-read",
  "pull-requests-read",
  "projects-read",
]);
export type GithubCapabilityKind = typeof GithubCapabilityKind.Type;

export const GithubCapability = Schema.Struct({
  kind: GithubCapabilityKind,
  available: Schema.Boolean,
  remediation: Schema.optional(safeText(160)),
});
export type GithubCapability = typeof GithubCapability.Type;

export const GithubAccount = Schema.Struct({
  login: safeText(128),
  gitProtocol: Schema.Literal("https"),
  scopes: Schema.Array(safeText(128)).check(Schema.isMaxLength(64)),
});
export type GithubAccount = typeof GithubAccount.Type;

/** A pinned, token-free device-flow handoff for a paired headless client. */
export const GithubAuthenticationInteraction = Schema.Struct({
  kind: Schema.Literal("device-flow"),
  // This endpoint is fixed by GitHub's device flow; never relay a URL parsed
  // from interactive CLI output into a renderer.
  verificationUri: Schema.Literal("https://github.com/login/device"),
  userCode: safeText(64).check(Schema.makeFilter((value) => /^[A-Z0-9-]+$/.test(value))),
});
export type GithubAuthenticationInteraction = typeof GithubAuthenticationInteraction.Type;

export const GithubAuthenticationSnapshot = Schema.Struct({
  state: GithubAuthenticationState,
  account: Schema.optional(GithubAccount),
  capabilities: Schema.Array(GithubCapability).check(Schema.isMaxLength(8)),
  remediation: Schema.optional(safeText(256)),
  interaction: Schema.optional(GithubAuthenticationInteraction),
});
export type GithubAuthenticationSnapshot = typeof GithubAuthenticationSnapshot.Type;

export const GithubAuthenticationCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("setup"),
    confirmation: Schema.Literal("confirm-github-setup"),
  }),
  Schema.Struct({
    kind: Schema.Literal("refresh"),
    confirmation: Schema.Literal("confirm-github-refresh"),
    scopes: Schema.Array(Schema.Literal("read:project")).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(1),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("logout"),
    confirmation: Schema.Literal("confirm-github-local-logout"),
  }),
  Schema.Struct({
    kind: Schema.Literal("migrate-storage"),
    confirmation: Schema.Literal("confirm-github-storage-migration"),
  }),
]);
export type GithubAuthenticationCommand = typeof GithubAuthenticationCommand.Type;

export const decodeGithubAuthenticationSnapshot = Schema.decodeUnknownSync(
  GithubAuthenticationSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeGithubAuthenticationCommand = Schema.decodeUnknownSync(
  GithubAuthenticationCommand,
  STRICT_DECODE_OPTIONS,
);

import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const SECRETISH =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+|token=|authorization)/i;
const safeText = (limit: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(limit),
    Schema.filter((value) => !SECRETISH.test(value) && !value.includes("\0")),
  );

export const GithubAuthenticationState = Schema.Literal(
  "ready",
  "scope-limited",
  "unauthorized",
  "insecure-storage",
  "external-token",
  "rate-limited",
  "unavailable",
);
export type GithubAuthenticationState = typeof GithubAuthenticationState.Type;

export const GithubCapabilityKind = Schema.Literal(
  "repository-catalogue",
  "issues-read",
  "pull-requests-read",
  "projects-read",
);
export type GithubCapabilityKind = typeof GithubCapabilityKind.Type;

export const GithubCapability = Schema.Struct({
  kind: GithubCapabilityKind,
  available: Schema.Boolean,
  remediation: Schema.optional(safeText(160)),
}).annotations(strict);
export type GithubCapability = typeof GithubCapability.Type;

export const GithubAccount = Schema.Struct({
  login: safeText(128),
  gitProtocol: Schema.Literal("https"),
  scopes: Schema.Array(safeText(128)).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type GithubAccount = typeof GithubAccount.Type;

/** A pinned, token-free device-flow handoff for a paired headless client. */
export const GithubAuthenticationInteraction = Schema.Struct({
  kind: Schema.Literal("device-flow"),
  // This endpoint is fixed by GitHub's device flow; never relay a URL parsed
  // from interactive CLI output into a renderer.
  verificationUri: Schema.Literal("https://github.com/login/device"),
  userCode: safeText(64).pipe(Schema.filter((value) => /^[A-Z0-9-]+$/.test(value))),
}).annotations(strict);
export type GithubAuthenticationInteraction = typeof GithubAuthenticationInteraction.Type;

export const GithubAuthenticationSnapshot = Schema.Struct({
  state: GithubAuthenticationState,
  account: Schema.optional(GithubAccount),
  capabilities: Schema.Array(GithubCapability).pipe(Schema.maxItems(8)),
  remediation: Schema.optional(safeText(256)),
  interaction: Schema.optional(GithubAuthenticationInteraction),
}).annotations(strict);
export type GithubAuthenticationSnapshot = typeof GithubAuthenticationSnapshot.Type;

export const GithubAuthenticationCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("setup"),
    confirmation: Schema.Literal("confirm-github-setup"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refresh"),
    confirmation: Schema.Literal("confirm-github-refresh"),
    scopes: Schema.Array(Schema.Literal("read:project")).pipe(
      Schema.minItems(1),
      Schema.maxItems(1),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("logout"),
    confirmation: Schema.Literal("confirm-github-local-logout"),
  }).annotations(strict),
);
export type GithubAuthenticationCommand = typeof GithubAuthenticationCommand.Type;

export const decodeGithubAuthenticationSnapshot = Schema.decodeUnknownSync(
  GithubAuthenticationSnapshot,
);
export const decodeGithubAuthenticationCommand = Schema.decodeUnknownSync(
  GithubAuthenticationCommand,
);

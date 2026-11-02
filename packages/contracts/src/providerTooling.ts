/**
 * Tools a person adds to a Claude Code or Codex account through that
 * provider's own commands. Schemas only: the argument rules live in the
 * domain's provider-tooling policy and the commands run on the host.
 *
 * A secret value appears in exactly one place, a plan request's
 * `oauthClientSecret`. The host keeps it in the credential broker until the
 * person confirms the plan, and no result, event, or shown command carries it.
 */

import { Schema } from "effect";
import { ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const PROVIDER_TOOLING_PROVIDERS = ["claude", "codex"] as const;
export const ProviderToolingProvider = Schema.Literal(...PROVIDER_TOOLING_PROVIDERS);
export type ProviderToolingProvider = typeof ProviderToolingProvider.Type;

const Short = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048));

export const ProviderToolingEnvironmentValue = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  value: Schema.String.pipe(Schema.maxLength(1024)),
}).annotations(strict);

/** What the person asked to change. The host validates every value again. */
export const ProviderToolingRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("mcp-add-url"),
    name: Short,
    url: Short,
    /** Claude only. Defaults to `http`. */
    transport: Schema.optional(Schema.Literal("http", "sse")),
    /** Claude only: the OAuth client a pre-registered server expects. */
    oauthClientId: Schema.optional(Short),
    /** Claude only. Held in the credential broker, given to the command through its environment. */
    oauthClientSecret: Schema.optional(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
    ),
    /** Codex only: the name of the variable Codex reads a bearer token from. Never the token. */
    bearerTokenEnvVar: Schema.optional(Short),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("mcp-add-stdio"),
    name: Short,
    command: Short,
    args: Schema.Array(Schema.String.pipe(Schema.maxLength(2048))).pipe(Schema.maxItems(64)),
    /** Plain settings only: the command line shows them. A key is refused. */
    env: Schema.Array(ProviderToolingEnvironmentValue).pipe(Schema.maxItems(32)),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("mcp-remove"), name: Short }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("marketplace-add"), source: Short }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("marketplace-remove"), name: Short }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("plugin-install"),
    plugin: Short,
    marketplace: Schema.optional(Short),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("plugin-uninstall"),
    plugin: Short,
    marketplace: Schema.optional(Short),
  }).annotations(strict),
);
export type ProviderToolingRequest = typeof ProviderToolingRequest.Type;

export type ProviderToolingCommandKind = ProviderToolingRequest["kind"];

export const ProviderToolingSectionKind = Schema.Literal("mcp-servers", "plugins", "marketplaces");
export type ProviderToolingSectionKind = typeof ProviderToolingSectionKind.Type;

export const ProviderToolingRefusalReason = Schema.Literal(
  /** A value broke a rule; `field` says which. */
  "invalid-value",
  /** The CLI has no safe way to take that secret, so Octant does not pass it. */
  "secret-unsupported",
  /** The installed CLI has no command for this. */
  "unsupported",
  /** The account is not a Claude Code or Codex account on this host. */
  "unknown-account",
  /** The host cannot do this now (no broker for a secret, no CLI found). */
  "unavailable",
  /** Only a person in a window on this host may change an account's tools. */
  "not-a-local-window",
  "unknown-plan",
  "expired-plan",
  "changed-plan",
  "used-plan",
);
export type ProviderToolingRefusalReason = typeof ProviderToolingRefusalReason.Type;

export const ProviderToolingRefusal = Schema.Struct({
  status: Schema.Literal("refused"),
  reason: ProviderToolingRefusalReason,
  message: Schema.String,
  field: Schema.optional(Schema.String),
}).annotations(strict);
export type ProviderToolingRefusal = typeof ProviderToolingRefusal.Type;

export const ProviderToolingListRequest = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
}).annotations(strict);
export type ProviderToolingListRequest = typeof ProviderToolingListRequest.Type;

export const ProviderToolingEntry = Schema.Struct({
  name: Schema.String,
  /** One line from the provider: where it points or its status. */
  detail: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  /** For a plugin: the marketplace it came from, when the provider says. */
  marketplace: Schema.optional(Schema.String),
}).annotations(strict);
export type ProviderToolingEntry = typeof ProviderToolingEntry.Type;

export const ProviderToolingSection = Schema.Struct({
  kind: ProviderToolingSectionKind,
  /**
   * `listed`: the provider answered. `failed`: its command did not succeed.
   * `unreadable`: it answered in a shape Octant could not read, so `lines`
   * holds the first lines as text. `no-command`: this version of the CLI has
   * no such command, so Octant offers nothing for it.
   */
  status: Schema.Literal("listed", "failed", "unreadable", "no-command"),
  entries: Schema.Array(ProviderToolingEntry),
  lines: Schema.Array(Schema.String),
  message: Schema.optional(Schema.String),
}).annotations(strict);
export type ProviderToolingSection = typeof ProviderToolingSection.Type;

export const ProviderToolingListing = Schema.Struct({
  status: Schema.Literal("listed"),
  provider: ProviderToolingProvider,
  /** The folder the commands run against; absent for the account's default folder. */
  accountDirectory: Schema.optional(Schema.String),
  /** The account switch that decides whether Octant threads load what is added. */
  runsAsItself: Schema.Boolean,
  sections: Schema.Array(ProviderToolingSection),
  /** What this provider's CLI cannot take safely or at all, said plainly. */
  notes: Schema.Array(Schema.String),
}).annotations(strict);
export type ProviderToolingListing = typeof ProviderToolingListing.Type;

export const ProviderToolingListResult = Schema.Union(
  ProviderToolingListing,
  ProviderToolingRefusal,
);
export type ProviderToolingListResult = typeof ProviderToolingListResult.Type;

export const ProviderToolingPlanRequest = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  request: ProviderToolingRequest,
}).annotations(strict);
export type ProviderToolingPlanRequest = typeof ProviderToolingPlanRequest.Type;

export const ProviderToolingPlan = Schema.Struct({
  status: Schema.Literal("planned"),
  planId: Schema.UUID,
  /** Binds the confirmation to exactly the command shown. */
  digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  expiresAt: Schema.String,
  provider: ProviderToolingProvider,
  commandKind: Schema.String,
  /** The exact command, shell-quoted for reading. Secrets show as a placeholder. */
  commandLine: Schema.String,
  /** What the command adds or removes, in plain sentences. */
  summary: Schema.String,
  effects: Schema.Array(Schema.String),
  usesSecret: Schema.Boolean,
  runsAsItself: Schema.Boolean,
}).annotations(strict);
export type ProviderToolingPlan = typeof ProviderToolingPlan.Type;

export const ProviderToolingPlanResult = Schema.Union(ProviderToolingPlan, ProviderToolingRefusal);
export type ProviderToolingPlanResult = typeof ProviderToolingPlanResult.Type;

export const ProviderToolingApplyRequest = Schema.Struct({
  planId: Schema.UUID,
  digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
}).annotations(strict);
export type ProviderToolingApplyRequest = typeof ProviderToolingApplyRequest.Type;

export const ProviderToolingCancelRequest = Schema.Struct({
  planId: Schema.UUID,
}).annotations(strict);
export type ProviderToolingCancelRequest = typeof ProviderToolingCancelRequest.Type;

export const ProviderToolingCancelResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("cancelled") }).annotations(strict),
  ProviderToolingRefusal,
);
export type ProviderToolingCancelResult = typeof ProviderToolingCancelResult.Type;

export const ProviderToolingSucceeded = Schema.Struct({
  status: Schema.Literal("applied"),
  /** The provider's own output, capped and scrubbed of any secret. */
  output: Schema.String,
}).annotations(strict);

export const ProviderToolingFailed = Schema.Struct({
  status: Schema.Literal("failed"),
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  output: Schema.String,
  message: Schema.String,
}).annotations(strict);

export const ProviderToolingApplyResult = Schema.Union(
  ProviderToolingSucceeded,
  ProviderToolingFailed,
  ProviderToolingRefusal,
);
export type ProviderToolingApplyResult = typeof ProviderToolingApplyResult.Type;

/**
 * The journal record of a change: who ran which kind of command against which
 * account, and what it was called. It carries no value, URL, argument, or
 * secret, only the name the person gave.
 */
export const PROVIDER_TOOLING_APPLIED = "provider.tooling-applied@1";

export const ProviderToolingAppliedRecordSchema = Schema.Struct({
  provider: ProviderToolingProvider,
  providerInstanceId: ProviderInstanceId,
  commandKind: Schema.Literal(
    "mcp-add-url",
    "mcp-add-stdio",
    "mcp-remove",
    "marketplace-add",
    "marketplace-remove",
    "plugin-install",
    "plugin-uninstall",
  ),
  /** The server, marketplace, or plugin name. Absent for a marketplace given as a path or URL. */
  name: Schema.optional(Schema.String),
  outcome: Schema.Literal("succeeded", "failed"),
  usedSecret: Schema.Boolean,
}).annotations(strict);
export type ProviderToolingAppliedRecord = typeof ProviderToolingAppliedRecordSchema.Type;

export const decodeProviderToolingListRequest = Schema.decodeUnknownSync(
  ProviderToolingListRequest,
);
export const decodeProviderToolingPlanRequest = Schema.decodeUnknownSync(
  ProviderToolingPlanRequest,
);
export const decodeProviderToolingApplyRequest = Schema.decodeUnknownSync(
  ProviderToolingApplyRequest,
);
export const decodeProviderToolingCancelRequest = Schema.decodeUnknownSync(
  ProviderToolingCancelRequest,
);
export const decodeProviderToolingRequest = Schema.decodeUnknownSync(ProviderToolingRequest);
export const decodeProviderToolingAppliedRecord = Schema.decodeUnknownSync(
  ProviderToolingAppliedRecordSchema,
);

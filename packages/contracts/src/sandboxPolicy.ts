import { TOOL_EGRESS_HOST_NAME_PATTERN, ToolEgressPort } from "./toolEgressHost";
import { Schema } from "effect";
import { HostId } from "./host";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** POSIX host paths only. Other platforms must refuse before interpreting them. */
export const SandboxPolicyPath = Schema.String.pipe(
  Schema.maxLength(4096),
  Schema.filter(
    (path) =>
      path.startsWith("/") &&
      path !== "/" &&
      Array.from(path).every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== "\\",
      ) &&
      path
        .split("/")
        .slice(1)
        .every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);

const roots = Schema.Array(SandboxPolicyPath).pipe(Schema.maxItems(64));

/**
 * A complete selection, supplied only by the host's trusted launch planner.
 * This contract is not an agent tool or a repository configuration format.
 * Existing settings remain unchanged until a planner explicitly selects one.
 * Revisions distinguish a revoked and subsequently re-created grant.
 */
export const SandboxNetworkDestination = Schema.Struct({
  host: Schema.String.pipe(Schema.maxLength(253), Schema.pattern(TOOL_EGRESS_HOST_NAME_PATTERN)),
  port: ToolEgressPort,
}).annotations(strict);
export type SandboxNetworkDestination = typeof SandboxNetworkDestination.Type;
export const decodeSandboxNetworkDestination = Schema.decodeUnknownSync(SandboxNetworkDestination);

export const SandboxPolicy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Number.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER)),
  filesystem: Schema.Struct({
    readOnlyRoots: roots,
    readWriteRoots: roots,
    protectedPaths: Schema.Array(
      Schema.Struct({
        path: SandboxPolicyPath,
        mode: Schema.Literal("read-only", "deny"),
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  network: Schema.Literal("existing-policy", "deny", "unrestricted"),
  approvedDestinations: Schema.optional(
    Schema.Array(SandboxNetworkDestination).pipe(Schema.maxItems(64)),
  ),
  credentials: Schema.Literal("existing-policy", "isolated"),
  hostServices: Schema.Literal("existing-policy", "blocked"),
}).annotations(strict);
export type SandboxPolicy = typeof SandboxPolicy.Type;

export const decodeSandboxPolicy = Schema.decodeUnknownSync(SandboxPolicy);

const identity = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));

/** Session identity includes a fresh host-process epoch; temporary grants never resume after restart. */
export const SandboxPolicyContext = Schema.Struct({
  threadId: Schema.optional(Schema.UUID),
  rootIdentities: Schema.optional(
    Schema.Array(
      Schema.Struct({ path: SandboxPolicyPath, identity: Schema.String }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  ),
  root: SandboxPolicyPath,
  extraRoots: Schema.optional(roots),
  hostId: HostId,
  projectId: ProjectId,
  checkoutId: identity.pipe(Schema.brand("SandboxCheckoutIdentity")),
  sessionId: identity.pipe(Schema.brand("SandboxSessionIdentity")),
  provider: identity,
}).annotations(strict);
export type SandboxPolicyContext = typeof SandboxPolicyContext.Type;

export const SandboxPolicySelection = Schema.Struct({
  policy: SandboxPolicy,
  context: SandboxPolicyContext,
}).annotations(strict);
export type SandboxPolicySelection = typeof SandboxPolicySelection.Type;
export const decodeSandboxPolicySelection = Schema.decodeUnknownSync(SandboxPolicySelection);

export const SandboxRestrictionsScope = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("settings"),
    mode: Schema.Literal("code", "work"),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("session"), threadId: Schema.UUID }).annotations(strict),
);
export type SandboxRestrictionsScope = typeof SandboxRestrictionsScope.Type;

export const SandboxRestrictionsCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("set-policy"),
    scope: SandboxRestrictionsScope,
    policy: SandboxPolicy,
    expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("inherit-policy"),
    scope: SandboxRestrictionsScope,
    expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("grant-denial"),
    denialId: Schema.UUID,
    duration: Schema.Literal("session", "project"),
    expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("keep-blocked"),
    denialId: Schema.UUID,
    expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
);
export type SandboxRestrictionsCommand = typeof SandboxRestrictionsCommand.Type;
export const decodeSandboxRestrictionsCommand = Schema.decodeUnknownSync(
  SandboxRestrictionsCommand,
);

export const SandboxPolicyDenial = Schema.Struct({
  destination: Schema.optional(SandboxNetworkDestination),
  id: Schema.UUID,
  threadId: Schema.UUID,
  projectId: ProjectId,
  code: Schema.Literal(
    "sandbox-read-denied",
    "sandbox-write-denied",
    "sandbox-network-denied",
    "sandbox-host-service-denied",
    "sandbox-policy-unsupported",
    "sandbox-cleanup-incomplete",
  ),
  ruleId: Schema.NonEmptyTrimmedString,
  operation: Schema.Literal("read", "write", "network", "host-service", "launch", "cleanup"),
  resource: Schema.String.pipe(Schema.maxLength(4096)),
  message: Schema.NonEmptyTrimmedString,
  remedy: Schema.NonEmptyTrimmedString,
  count: Schema.Int.pipe(Schema.positive()),
  grantable: Schema.Boolean,
  dismissed: Schema.Boolean,
}).annotations(strict);
export type SandboxPolicyDenial = typeof SandboxPolicyDenial.Type;

export const SandboxPolicyLaunchDetails = Schema.Struct({
  provider: Schema.String,
  backend: Schema.String,
  reads: roots,
  writes: roots,
  authentication: roots,
}).annotations(strict);
export type SandboxPolicyLaunchDetails = typeof SandboxPolicyLaunchDetails.Type;

export const SandboxRestrictionsSnapshot = Schema.Struct({
  runtimeDetails: Schema.optional(
    Schema.Array(SandboxPolicyLaunchDetails).pipe(Schema.maxItems(16)),
  ),
  enrollmentEnabled: Schema.optional(Schema.Boolean),
  kind: Schema.Literal("sandbox-restrictions"),
  version: Schema.Int.pipe(Schema.nonNegative()),
  scope: SandboxRestrictionsScope,
  source: Schema.Literal("legacy", "settings", "project", "session"),
  policy: Schema.optional(SandboxPolicy),
  inherited: Schema.Boolean,
  running: Schema.Boolean,
  strict: Schema.optional(Schema.Boolean),
  strictSource: Schema.optional(Schema.Literal("thread", "project", "settings", "default")),
  activePolicy: Schema.optional(SandboxPolicy),
  activeStrict: Schema.optional(Schema.Boolean),
  legacyStrict: Schema.optional(Schema.Boolean),
  activeLegacyStrict: Schema.optional(Schema.Boolean),
  pending: Schema.optional(Schema.Boolean),
  summary: Schema.NonEmptyTrimmedString,
  limitations: Schema.Array(Schema.String),
  capabilities: Schema.Struct({
    folders: Schema.Boolean,
    protectedPaths: Schema.Boolean,
    isolatedCredentials: Schema.Boolean,
    blockedHostServices: Schema.Boolean,
  }).annotations(strict),
  denials: Schema.Array(SandboxPolicyDenial),
}).annotations(strict);
export type SandboxRestrictionsSnapshot = typeof SandboxRestrictionsSnapshot.Type;
export const decodeSandboxRestrictionsSnapshot = Schema.decodeUnknownSync(
  SandboxRestrictionsSnapshot,
);

export const SandboxRestrictionsRefusal = Schema.Struct({
  kind: Schema.Literal("sandbox-restrictions-refused"),
  reason: Schema.Literal(
    "unauthorized",
    "malformed",
    "stale-version",
    "binding-changed",
    "unavailable",
    "unsupported",
    "not-grantable",
  ),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export const SandboxRestrictionsResult = Schema.Union(
  SandboxRestrictionsSnapshot,
  SandboxRestrictionsRefusal,
);
export type SandboxRestrictionsResult = typeof SandboxRestrictionsResult.Type;
export const decodeSandboxRestrictionsResult = Schema.decodeUnknownSync(SandboxRestrictionsResult);

export const SANDBOX_POLICY_CHANGED = "sandbox.policy-changed@1";
export const SANDBOX_POLICY_AGGREGATE_TYPE = "sandbox-policy";
export const SandboxPolicyChanged = Schema.Struct({
  requiresStrict: Schema.optional(Schema.Boolean),
  scope: SandboxRestrictionsScope,
  binding: Schema.String,
  policy: Schema.optional(SandboxPolicy),
  roots: Schema.Array(
    Schema.Struct({ path: SandboxPolicyPath, identity: Schema.String }).annotations(strict),
  ),
}).annotations(strict);

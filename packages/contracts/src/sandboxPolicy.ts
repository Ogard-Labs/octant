import { TOOL_EGRESS_HOST_NAME_PATTERN, ToolEgressPort } from "./toolEgressHost";
import {
  GuidString,
  NonEmptyTrimmedString,
  NonNegativeInt,
  PositiveInt,
  STRICT_DECODE_OPTIONS,
} from "./schemaPrimitives";
import { Schema } from "effect";
import { HostId } from "./host";
import { ProjectId } from "./projects";

function isPosixSandboxPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    path !== "/" &&
    Array.from(path).every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== "\\",
    ) &&
    path
      .split("/")
      .slice(1)
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isWindowsSandboxPath(path: string): boolean {
  if (!/^[A-Za-z]:\\/u.test(path)) return false;
  const rest = path.slice(3);
  if (rest.length === 0 || rest.includes("/")) return false;
  return rest
    .split("\\")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        !part.includes(":") &&
        !/[. ]$/u.test(part) &&
        !/[<>"|?*]/u.test(part) &&
        Array.from(part).every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
    );
}

/** Canonical absolute POSIX or Windows drive-absolute host paths. */
export const SandboxPolicyPath = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((path) => isPosixSandboxPath(path) || isWindowsSandboxPath(path)),
);

const roots = Schema.Array(SandboxPolicyPath).check(Schema.isMaxLength(64));

/**
 * A complete selection, supplied only by the host's trusted launch planner.
 * This contract is not an agent tool or a repository configuration format.
 * Existing settings remain unchanged until a planner explicitly selects one.
 * Revisions distinguish a revoked and subsequently re-created grant.
 */
export const SandboxNetworkDestination = Schema.Struct({
  host: Schema.String.check(
    Schema.isMaxLength(253),
    Schema.isPattern(TOOL_EGRESS_HOST_NAME_PATTERN),
  ),
  port: ToolEgressPort,
});
export type SandboxNetworkDestination = typeof SandboxNetworkDestination.Type;
export const decodeSandboxNetworkDestination = Schema.decodeUnknownSync(
  SandboxNetworkDestination,
  STRICT_DECODE_OPTIONS,
);

/** A separate host-service authority: no DNS names, address ranges or Unix sockets. */
export const SandboxLocalService = Schema.Struct({
  host: Schema.Literals(["127.0.0.1", "::1"]),
  port: ToolEgressPort,
});
export type SandboxLocalService = typeof SandboxLocalService.Type;
export const decodeSandboxLocalService = Schema.decodeUnknownSync(
  SandboxLocalService,
  STRICT_DECODE_OPTIONS,
);

export const SandboxPolicy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  filesystem: Schema.Struct({
    readOnlyRoots: roots,
    readWriteRoots: roots,
    protectedPaths: Schema.Array(
      Schema.Struct({
        path: SandboxPolicyPath,
        mode: Schema.Literals(["read-only", "deny"]),
      }),
    ).check(Schema.isMaxLength(256)),
  }),
  network: Schema.Literals(["existing-policy", "deny", "unrestricted"]),
  approvedDestinations: Schema.optional(
    Schema.Array(SandboxNetworkDestination).check(Schema.isMaxLength(64)),
  ),
  credentials: Schema.Literals(["existing-policy", "isolated"]),
  hostServices: Schema.Literals(["existing-policy", "blocked"]),
  localServices: Schema.optional(Schema.Array(SandboxLocalService).check(Schema.isMaxLength(64))),
}).check(
  Schema.makeFilter(
    (policy) => (policy.localServices?.length ?? 0) === 0 || policy.hostServices === "blocked",
  ),
);
export type SandboxPolicy = typeof SandboxPolicy.Type;

export const decodeSandboxPolicy = Schema.decodeUnknownSync(SandboxPolicy, STRICT_DECODE_OPTIONS);

const identity = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256));

/** Session identity includes a fresh host-process epoch; temporary grants never resume after restart. */
export const SandboxPolicyContext = Schema.Struct({
  threadId: Schema.optional(GuidString),
  rootIdentities: Schema.optional(
    Schema.Array(Schema.Struct({ path: SandboxPolicyPath, identity: Schema.String })).check(
      Schema.isMaxLength(256),
    ),
  ),
  root: SandboxPolicyPath,
  extraRoots: Schema.optional(roots),
  hostId: HostId,
  projectId: ProjectId,
  checkoutId: identity.pipe(Schema.brand("SandboxCheckoutIdentity")),
  sessionId: identity.pipe(Schema.brand("SandboxSessionIdentity")),
  provider: identity,
});
export type SandboxPolicyContext = typeof SandboxPolicyContext.Type;

export const SandboxPolicySelection = Schema.Struct({
  policy: SandboxPolicy,
  context: SandboxPolicyContext,
});
export type SandboxPolicySelection = typeof SandboxPolicySelection.Type;
export const decodeSandboxPolicySelection = Schema.decodeUnknownSync(
  SandboxPolicySelection,
  STRICT_DECODE_OPTIONS,
);

export const SandboxRestrictionsScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("settings"),
    mode: Schema.Literals(["code", "work"]),
  }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("session"), threadId: GuidString }),
]);
export type SandboxRestrictionsScope = typeof SandboxRestrictionsScope.Type;

export const SandboxRestrictionsCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("set-policy"),
    scope: SandboxRestrictionsScope,
    policy: SandboxPolicy,
    expectedVersion: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("inherit-policy"),
    scope: SandboxRestrictionsScope,
    expectedVersion: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("grant-denial"),
    denialId: GuidString,
    duration: Schema.Literals(["session", "project"]),
    expectedVersion: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("keep-blocked"),
    denialId: GuidString,
    expectedVersion: NonNegativeInt,
  }),
]);
export type SandboxRestrictionsCommand = typeof SandboxRestrictionsCommand.Type;
export const decodeSandboxRestrictionsCommand = Schema.decodeUnknownSync(
  SandboxRestrictionsCommand,
  STRICT_DECODE_OPTIONS,
);

export const SandboxPolicyDenial = Schema.Struct({
  destination: Schema.optional(SandboxNetworkDestination),
  localService: Schema.optional(SandboxLocalService),
  id: GuidString,
  threadId: GuidString,
  projectId: ProjectId,
  code: Schema.Literals([
    "sandbox-read-denied",
    "sandbox-write-denied",
    "sandbox-network-denied",
    "sandbox-host-service-denied",
    "sandbox-policy-unsupported",
    "sandbox-cleanup-incomplete",
  ]),
  ruleId: NonEmptyTrimmedString,
  operation: Schema.Literals(["read", "write", "network", "host-service", "launch", "cleanup"]),
  resource: Schema.String.check(Schema.isMaxLength(4096)),
  message: NonEmptyTrimmedString,
  remedy: NonEmptyTrimmedString,
  count: PositiveInt,
  grantable: Schema.Boolean,
  dismissed: Schema.Boolean,
});
export type SandboxPolicyDenial = typeof SandboxPolicyDenial.Type;

export const SandboxPolicyLaunchDetails = Schema.Struct({
  provider: Schema.String,
  backend: Schema.String,
  reads: roots,
  writes: roots,
  authentication: roots,
});
export type SandboxPolicyLaunchDetails = typeof SandboxPolicyLaunchDetails.Type;

export const SandboxRestrictionsSnapshot = Schema.Struct({
  runtimeDetails: Schema.optional(
    Schema.Array(SandboxPolicyLaunchDetails).check(Schema.isMaxLength(16)),
  ),
  enrollmentEnabled: Schema.optional(Schema.Boolean),
  kind: Schema.Literal("sandbox-restrictions"),
  version: NonNegativeInt,
  scope: SandboxRestrictionsScope,
  source: Schema.Literals(["legacy", "settings", "project", "session"]),
  policy: Schema.optional(SandboxPolicy),
  inherited: Schema.Boolean,
  running: Schema.Boolean,
  strict: Schema.optional(Schema.Boolean),
  strictSource: Schema.optional(Schema.Literals(["thread", "project", "settings", "default"])),
  activePolicy: Schema.optional(SandboxPolicy),
  activeStrict: Schema.optional(Schema.Boolean),
  legacyStrict: Schema.optional(Schema.Boolean),
  activeLegacyStrict: Schema.optional(Schema.Boolean),
  pending: Schema.optional(Schema.Boolean),
  summary: NonEmptyTrimmedString,
  limitations: Schema.Array(Schema.String),
  capabilities: Schema.Struct({
    folders: Schema.Boolean,
    protectedPaths: Schema.Boolean,
    isolatedCredentials: Schema.Boolean,
    blockedHostServices: Schema.Boolean,
  }),
  denials: Schema.Array(SandboxPolicyDenial),
});
export type SandboxRestrictionsSnapshot = typeof SandboxRestrictionsSnapshot.Type;
export const decodeSandboxRestrictionsSnapshot = Schema.decodeUnknownSync(
  SandboxRestrictionsSnapshot,
  STRICT_DECODE_OPTIONS,
);

export const SandboxRestrictionsRefusal = Schema.Struct({
  kind: Schema.Literal("sandbox-restrictions-refused"),
  reason: Schema.Literals([
    "unauthorized",
    "malformed",
    "stale-version",
    "binding-changed",
    "unavailable",
    "unsupported",
    "not-grantable",
  ]),
  message: NonEmptyTrimmedString,
});
export const SandboxRestrictionsResult = Schema.Union([
  SandboxRestrictionsSnapshot,
  SandboxRestrictionsRefusal,
]);
export type SandboxRestrictionsResult = typeof SandboxRestrictionsResult.Type;
export const decodeSandboxRestrictionsResult = Schema.decodeUnknownSync(
  SandboxRestrictionsResult,
  STRICT_DECODE_OPTIONS,
);

export const SANDBOX_POLICY_CHANGED = "sandbox.policy-changed@1";
export const SANDBOX_POLICY_AGGREGATE_TYPE = "sandbox-policy";
export const SandboxPolicyChanged = Schema.Struct({
  requiresStrict: Schema.optional(Schema.Boolean),
  scope: SandboxRestrictionsScope,
  binding: Schema.String,
  policy: Schema.optional(SandboxPolicy),
  roots: Schema.Array(Schema.Struct({ path: SandboxPolicyPath, identity: Schema.String })),
});

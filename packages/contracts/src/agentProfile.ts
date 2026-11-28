import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";
// HostId comes from its own module rather than the shell barrel: `shell` pulls
// in the Apple toolchain, which pulls in `code`, and `code` now names a profile.
import { HostId } from "./host";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const AgentProfileId = brandedUuid("AgentProfileId");
export type AgentProfileId = typeof AgentProfileId.Type;

/**
 * A provider-neutral execution profile that bundles approved instructions,
 * skills, tool constraints, model constraints, and permission defaults.
 * Selecting a profile cannot change Project, root, worktree, host,
 * extension trust, or authority silently.
 */
export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  description: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048))),
  /** Approved system instructions injected into context composition. */
  instructions: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
  ),
  /** Approved skill identifiers that may be loaded when this profile is active. */
  approvedSkillIds: Schema.Array(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  ),
  /** Tool capability constraints — only these capabilities are permitted. */
  toolConstraints: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
  /** Model constraints — only these models may be selected with this profile. */
  modelConstraints: Schema.Array(ProviderModelId),
  /** Default execution policy when this profile is active. */
  defaultExecutionPolicy: ProviderExecutionPolicy,
  /** Default permission persistence when this profile is active. */
  defaultPermissionPersistence: PermissionPersistence,
  /** Modes this profile is compatible with. */
  compatibleModes: Schema.Array(OctantMode),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});
export type AgentProfile = typeof AgentProfile.Type;

/**
 * The resolved execution context for a thread, combining provider, model,
 * profile, host placement, and effective permissions.
 */
export const ExecutionContext = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  profileId: Schema.optional(AgentProfileId),
  hostId: HostId,
  executionPolicy: ProviderExecutionPolicy,
  permissionPersistence: PermissionPersistence,
  /** Effective permission summary — what the thread can actually do. */
  effectivePermissions: Schema.Struct({
    filesystem: Schema.Boolean,
    shell: Schema.Boolean,
    git: Schema.Boolean,
    network: Schema.Boolean,
    tools: Schema.Boolean,
    subagents: Schema.Boolean,
  }),
});
export type ExecutionContext = typeof ExecutionContext.Type;

/**
 * Execution context picker input — the compact provider-first picker
 * that shows provider/model, optional profile, host, and effective permissions.
 */
export const ExecutionContextPickerEntry = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerDisplayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  modelId: ProviderModelId,
  modelDisplayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  profileId: Schema.optional(AgentProfileId),
  profileDisplayName: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  ),
  hostId: HostId,
  hostLabel: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  executionPolicy: ProviderExecutionPolicy,
  effectivePermissions: Schema.Struct({
    filesystem: Schema.Boolean,
    shell: Schema.Boolean,
    git: Schema.Boolean,
    network: Schema.Boolean,
    tools: Schema.Boolean,
    subagents: Schema.Boolean,
  }),
  /** Why this combination is unavailable, if applicable. */
  unavailableReason: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  ),
});
export type ExecutionContextPickerEntry = typeof ExecutionContextPickerEntry.Type;

/**
 * The scope kind for a persisted execution profile.
 * - user: a user-global default profile
 * - mode: a per-mode default profile (scopeRef is the mode name)
 * - project: a per-Project profile (scopeRef is the Project ID)
 * - one-off: a single-thread override profile (scopeRef is the thread ID)
 */
export const ProfileScopeKind = Schema.Literals(["user", "mode", "project", "one-off"]);
export type ProfileScopeKind = typeof ProfileScopeKind.Type;
export const decodeProfileScopeKind = Schema.decodeUnknownSync(
  ProfileScopeKind,
  STRICT_DECODE_OPTIONS,
);

/**
 * The scope a profile belongs to. Profiles are partitioned by scope so
 * that resolution can deterministically pick the most specific applicable
 * profile without conflating user, mode, Project, and one-off overrides.
 */
export const AgentProfileScope = Schema.Struct({
  scopeKind: ProfileScopeKind,
  /** Mode name for mode scope, Project ID for project scope, thread ID for one-off, user ID for user. */
  scopeRef: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
});
export type AgentProfileScope = typeof AgentProfileScope.Type;
export const decodeAgentProfileScope = Schema.decodeUnknownSync(
  AgentProfileScope,
  STRICT_DECODE_OPTIONS,
);

/**
 * Agent profile CRUD commands.
 */
export const AgentProfileCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create-agent-profile"),
    profileId: AgentProfileId,
    scope: AgentProfileScope,
    displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
    description: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    ),
    instructions: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
    ),
    approvedSkillIds: Schema.Array(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
    ),
    toolConstraints: Schema.Array(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
    ),
    modelConstraints: Schema.Array(ProviderModelId),
    defaultExecutionPolicy: ProviderExecutionPolicy,
    defaultPermissionPersistence: PermissionPersistence,
    compatibleModes: Schema.Array(OctantMode),
  }),
  Schema.Struct({
    kind: Schema.Literal("update-agent-profile"),
    profileId: AgentProfileId,
    expectedVersion: AggregateVersion,
    displayName: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
    ),
    description: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    ),
    instructions: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
    ),
    approvedSkillIds: Schema.optional(
      Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
    ),
    toolConstraints: Schema.optional(
      Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
    ),
    modelConstraints: Schema.optional(Schema.Array(ProviderModelId)),
    defaultExecutionPolicy: Schema.optional(ProviderExecutionPolicy),
    defaultPermissionPersistence: Schema.optional(PermissionPersistence),
    compatibleModes: Schema.optional(Schema.Array(OctantMode)),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-agent-profile"),
    profileId: AgentProfileId,
    expectedVersion: AggregateVersion,
  }),
]);
export type AgentProfileCommand = typeof AgentProfileCommand.Type;

export const AgentProfileCommandResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("profile-created"), profile: AgentProfile }),
  Schema.Struct({ kind: Schema.Literal("profile-updated"), profile: AgentProfile }),
  Schema.Struct({ kind: Schema.Literal("profile-removed"), profileId: AgentProfileId }),
  Schema.Struct({
    kind: Schema.Literal("profile-command-failed"),
    reason: Schema.Literals(["invalid", "stale-version", "unauthorized", "in-use"]),
    message: NonEmptyTrimmedString,
  }),
]);
export type AgentProfileCommandResult = typeof AgentProfileCommandResult.Type;

export const decodeAgentProfileId = Schema.decodeUnknownSync(AgentProfileId, STRICT_DECODE_OPTIONS);
export const decodeAgentProfile = Schema.decodeUnknownSync(AgentProfile, STRICT_DECODE_OPTIONS);
export const decodeExecutionContext = Schema.decodeUnknownSync(
  ExecutionContext,
  STRICT_DECODE_OPTIONS,
);
export const decodeExecutionContextPickerEntry = Schema.decodeUnknownSync(
  ExecutionContextPickerEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentProfileCommand = Schema.decodeUnknownSync(
  AgentProfileCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeAgentProfileCommandResult = Schema.decodeUnknownSync(
  AgentProfileCommandResult,
  STRICT_DECODE_OPTIONS,
);

/**
 * Event payload for agent.profile-created@1.
 * Records the created profile and the scope it belongs to.
 */
export const AgentProfileCreated = Schema.Struct({
  profile: AgentProfile,
  scope: AgentProfileScope,
});
export type AgentProfileCreated = typeof AgentProfileCreated.Type;
export const decodeAgentProfileCreated = Schema.decodeUnknownSync(
  AgentProfileCreated,
  STRICT_DECODE_OPTIONS,
);

/**
 * Event payload for agent.profile-updated@1.
 * Records the updated profile and the scope it belongs to.
 */
export const AgentProfileUpdated = Schema.Struct({
  profile: AgentProfile,
  scope: AgentProfileScope,
});
export type AgentProfileUpdated = typeof AgentProfileUpdated.Type;
export const decodeAgentProfileUpdated = Schema.decodeUnknownSync(
  AgentProfileUpdated,
  STRICT_DECODE_OPTIONS,
);

/**
 * Event payload for agent.profile-removed@1.
 * Records the removed profile ID and the final aggregate version.
 */
export const AgentProfileRemoved = Schema.Struct({
  profileId: AgentProfileId,
  version: AggregateVersion,
});
export type AgentProfileRemoved = typeof AgentProfileRemoved.Type;
export const decodeAgentProfileRemoved = Schema.decodeUnknownSync(
  AgentProfileRemoved,
  STRICT_DECODE_OPTIONS,
);

/**
 * The source of an effective execution resolution, in deterministic
 * priority order. Higher priority sources override lower ones.
 * - one-off-override: an explicit per-thread override
 * - project-default: the Project's default profile
 * - mode-default: the mode's default profile
 * - user-default: the user's global default profile
 * - none: no profile resolved; no implicit privileged fallback
 */
export const ExecutionResolutionSource = Schema.Literals([
  "one-off-override",
  "project-default",
  "mode-default",
  "user-default",
  "none",
]);
export type ExecutionResolutionSource = typeof ExecutionResolutionSource.Type;

/**
 * A reason why a resolution step was downgraded or skipped.
 * Each step in the fallback chain that did not produce the final
 * effective context records its reason here.
 */
export const ExecutionDowngradeReason = Schema.Struct({
  step: ExecutionResolutionSource,
  reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
});
export type ExecutionDowngradeReason = typeof ExecutionDowngradeReason.Type;

/**
 * A typed resolution receipt documenting the full execution context
 * resolution chain: provider, model, profile, host, permissions, and
 * fallback. The receipt makes the deterministic resolution order visible
 * and records any downgrade reasons when a provider, model, or host
 * became unavailable.
 *
 * Provider or host loss never silently changes root, worktree, Project,
 * extension trust, or authority — the receipt records the downgrade
 * and fails closed rather than escalating.
 */
export const ExecutionResolutionReceipt = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  profileId: Schema.optional(AgentProfileId),
  hostId: HostId,
  executionPolicy: ProviderExecutionPolicy,
  permissionPersistence: PermissionPersistence,
  effectivePermissions: Schema.Struct({
    filesystem: Schema.Boolean,
    shell: Schema.Boolean,
    git: Schema.Boolean,
    network: Schema.Boolean,
    tools: Schema.Boolean,
    subagents: Schema.Boolean,
  }),
  /** Which resolution source produced this effective context. */
  source: ExecutionResolutionSource,
  /** The full fallback chain attempted, in priority order. */
  fallbackChain: Schema.Array(ExecutionResolutionSource),
  /** Reasons for each downgraded or skipped step. */
  downgradeReasons: Schema.Array(ExecutionDowngradeReason),
});
export type ExecutionResolutionReceipt = typeof ExecutionResolutionReceipt.Type;
export const decodeExecutionResolutionReceipt = Schema.decodeUnknownSync(
  ExecutionResolutionReceipt,
  STRICT_DECODE_OPTIONS,
);

/**
 * Request to resolve the effective execution profile for a given context.
 * The server resolves deterministically: one-off thread override >
 * Project/mode default > user default > no implicit privileged fallback.
 */
export const ResolveEffectiveProfileRequest = Schema.Struct({
  mode: OctantMode,
  hostId: HostId,
  projectExecutionPolicy: ProviderExecutionPolicy,
  /** The posture the thread actually asked for. Resolution narrows the profile to this. */
  requestedExecutionPolicy: Schema.optional(ProviderExecutionPolicy),
  scope: AgentProfileScope,
  oneOffOverride: Schema.optional(
    Schema.Struct({
      profileId: AgentProfileId,
      providerInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
    }),
  ),
  projectDefault: Schema.optional(
    Schema.Struct({
      profileId: AgentProfileId,
      providerInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
    }),
  ),
  modeDefault: Schema.optional(
    Schema.Struct({
      profileId: AgentProfileId,
      providerInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
    }),
  ),
});
export type ResolveEffectiveProfileRequest = typeof ResolveEffectiveProfileRequest.Type;
export const decodeResolveEffectiveProfileRequest = Schema.decodeUnknownSync(
  ResolveEffectiveProfileRequest,
  STRICT_DECODE_OPTIONS,
);

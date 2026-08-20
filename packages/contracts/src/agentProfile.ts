import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";
// HostId comes from its own module rather than the shell barrel: `shell` pulls
// in the Apple toolchain, which pulls in `code`, and `code` now names a profile.
import { HostId } from "./host";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

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
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  description: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
  /** Approved system instructions injected into context composition. */
  instructions: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(100_000))),
  /** Approved skill identifiers that may be loaded when this profile is active. */
  approvedSkillIds: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  /** Tool capability constraints — only these capabilities are permitted. */
  toolConstraints: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
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
}).annotations(strict);
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
  }).annotations(strict),
}).annotations(strict);
export type ExecutionContext = typeof ExecutionContext.Type;

/**
 * Execution context picker input — the compact provider-first picker
 * that shows provider/model, optional profile, host, and effective permissions.
 */
export const ExecutionContextPickerEntry = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerDisplayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  modelId: ProviderModelId,
  modelDisplayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  profileId: Schema.optional(AgentProfileId),
  profileDisplayName: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  hostId: HostId,
  hostLabel: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  executionPolicy: ProviderExecutionPolicy,
  effectivePermissions: Schema.Struct({
    filesystem: Schema.Boolean,
    shell: Schema.Boolean,
    git: Schema.Boolean,
    network: Schema.Boolean,
    tools: Schema.Boolean,
    subagents: Schema.Boolean,
  }).annotations(strict),
  /** Why this combination is unavailable, if applicable. */
  unavailableReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
}).annotations(strict);
export type ExecutionContextPickerEntry = typeof ExecutionContextPickerEntry.Type;

/**
 * The scope kind for a persisted execution profile.
 * - user: a user-global default profile
 * - mode: a per-mode default profile (scopeRef is the mode name)
 * - project: a per-Project profile (scopeRef is the Project ID)
 * - one-off: a single-thread override profile (scopeRef is the thread ID)
 */
export const ProfileScopeKind = Schema.Literal("user", "mode", "project", "one-off");
export type ProfileScopeKind = typeof ProfileScopeKind.Type;
export const decodeProfileScopeKind = Schema.decodeUnknownSync(ProfileScopeKind);

/**
 * The scope a profile belongs to. Profiles are partitioned by scope so
 * that resolution can deterministically pick the most specific applicable
 * profile without conflating user, mode, Project, and one-off overrides.
 */
export const AgentProfileScope = Schema.Struct({
  scopeKind: ProfileScopeKind,
  /** Mode name for mode scope, Project ID for project scope, thread ID for one-off, user ID for user. */
  scopeRef: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
}).annotations(strict);
export type AgentProfileScope = typeof AgentProfileScope.Type;
export const decodeAgentProfileScope = Schema.decodeUnknownSync(AgentProfileScope);

/**
 * Agent profile CRUD commands.
 */
export const AgentProfileCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-agent-profile"),
    profileId: AgentProfileId,
    scope: AgentProfileScope,
    displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
    description: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
    instructions: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(100_000))),
    approvedSkillIds: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
    toolConstraints: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
    modelConstraints: Schema.Array(ProviderModelId),
    defaultExecutionPolicy: ProviderExecutionPolicy,
    defaultPermissionPersistence: PermissionPersistence,
    compatibleModes: Schema.Array(OctantMode),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("update-agent-profile"),
    profileId: AgentProfileId,
    expectedVersion: AggregateVersion,
    displayName: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
    description: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
    instructions: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(100_000))),
    approvedSkillIds: Schema.optional(
      Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
    ),
    toolConstraints: Schema.optional(
      Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
    ),
    modelConstraints: Schema.optional(Schema.Array(ProviderModelId)),
    defaultExecutionPolicy: Schema.optional(ProviderExecutionPolicy),
    defaultPermissionPersistence: Schema.optional(PermissionPersistence),
    compatibleModes: Schema.optional(Schema.Array(OctantMode)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-agent-profile"),
    profileId: AgentProfileId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type AgentProfileCommand = typeof AgentProfileCommand.Type;

export const AgentProfileCommandResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("profile-created"), profile: AgentProfile }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("profile-updated"), profile: AgentProfile }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("profile-removed"), profileId: AgentProfileId }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("profile-command-failed"),
    reason: Schema.Literal("invalid", "stale-version", "unauthorized", "in-use"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type AgentProfileCommandResult = typeof AgentProfileCommandResult.Type;

export const decodeAgentProfileId = Schema.decodeUnknownSync(AgentProfileId);
export const decodeAgentProfile = Schema.decodeUnknownSync(AgentProfile);
export const decodeExecutionContext = Schema.decodeUnknownSync(ExecutionContext);
export const decodeExecutionContextPickerEntry = Schema.decodeUnknownSync(
  ExecutionContextPickerEntry,
);
export const decodeAgentProfileCommand = Schema.decodeUnknownSync(AgentProfileCommand);
export const decodeAgentProfileCommandResult = Schema.decodeUnknownSync(AgentProfileCommandResult);

/**
 * Event payload for agent.profile-created@1.
 * Records the created profile and the scope it belongs to.
 */
export const AgentProfileCreated = Schema.Struct({
  profile: AgentProfile,
  scope: AgentProfileScope,
}).annotations(strict);
export type AgentProfileCreated = typeof AgentProfileCreated.Type;
export const decodeAgentProfileCreated = Schema.decodeUnknownSync(AgentProfileCreated);

/**
 * Event payload for agent.profile-updated@1.
 * Records the updated profile and the scope it belongs to.
 */
export const AgentProfileUpdated = Schema.Struct({
  profile: AgentProfile,
  scope: AgentProfileScope,
}).annotations(strict);
export type AgentProfileUpdated = typeof AgentProfileUpdated.Type;
export const decodeAgentProfileUpdated = Schema.decodeUnknownSync(AgentProfileUpdated);

/**
 * Event payload for agent.profile-removed@1.
 * Records the removed profile ID and the final aggregate version.
 */
export const AgentProfileRemoved = Schema.Struct({
  profileId: AgentProfileId,
  version: AggregateVersion,
}).annotations(strict);
export type AgentProfileRemoved = typeof AgentProfileRemoved.Type;
export const decodeAgentProfileRemoved = Schema.decodeUnknownSync(AgentProfileRemoved);

export const AGENT_PROFILE_EVENT_NAMES = [
  "agent.profile-created@1",
  "agent.profile-updated@1",
  "agent.profile-removed@1",
] as const;
export type AgentProfileEventName = (typeof AGENT_PROFILE_EVENT_NAMES)[number];

/**
 * The source of an effective execution resolution, in deterministic
 * priority order. Higher priority sources override lower ones.
 * - one-off-override: an explicit per-thread override
 * - project-default: the Project's default profile
 * - mode-default: the mode's default profile
 * - user-default: the user's global default profile
 * - none: no profile resolved; no implicit privileged fallback
 */
export const ExecutionResolutionSource = Schema.Literal(
  "one-off-override",
  "project-default",
  "mode-default",
  "user-default",
  "none",
);
export type ExecutionResolutionSource = typeof ExecutionResolutionSource.Type;

/**
 * A reason why a resolution step was downgraded or skipped.
 * Each step in the fallback chain that did not produce the final
 * effective context records its reason here.
 */
export const ExecutionDowngradeReason = Schema.Struct({
  step: ExecutionResolutionSource,
  reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
}).annotations(strict);
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
  }).annotations(strict),
  /** Which resolution source produced this effective context. */
  source: ExecutionResolutionSource,
  /** The full fallback chain attempted, in priority order. */
  fallbackChain: Schema.Array(ExecutionResolutionSource),
  /** Reasons for each downgraded or skipped step. */
  downgradeReasons: Schema.Array(ExecutionDowngradeReason),
}).annotations(strict);
export type ExecutionResolutionReceipt = typeof ExecutionResolutionReceipt.Type;
export const decodeExecutionResolutionReceipt = Schema.decodeUnknownSync(
  ExecutionResolutionReceipt,
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
}).annotations(strict);
export type ResolveEffectiveProfileRequest = typeof ResolveEffectiveProfileRequest.Type;
export const decodeResolveEffectiveProfileRequest = Schema.decodeUnknownSync(
  ResolveEffectiveProfileRequest,
);

import type { OctantMode } from "@octant/contracts/modes";
import type {
  AgentProfile,
  AgentProfileScope,
  ExecutionContext,
  ExecutionContextPickerEntry,
  ExecutionDowngradeReason,
  ExecutionResolutionReceipt,
  ExecutionResolutionSource,
} from "@octant/contracts/agent-profile";
import type {
  PermissionPersistence,
  ProviderCatalogSnapshot,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts/providers";
import type { HostId } from "@octant/contracts/shell";

export type AgentProfileRejectionCode =
  | "mode-incompatible"
  | "model-not-allowed"
  | "profile-not-found"
  | "authority-escalation";

/**
 * Whether binding a profile would escalate past the Project's grant.
 * Expected refusal is a value: picker and resolver callers have to mark the
 * profile unavailable or record a downgrade rather than crash.
 */
export type ProfileAuthoritySafety =
  | { readonly status: "accepted" }
  | {
      readonly status: "refused";
      readonly code: Extract<AgentProfileRejectionCode, "authority-escalation">;
      readonly reason: string;
    };

/**
 * Check whether a profile is compatible with the given mode.
 */
export function isProfileModeCompatible(profile: AgentProfile, mode: OctantMode): boolean {
  return profile.compatibleModes.includes(mode);
}

/**
 * Check whether a model is allowed by the profile's model constraints.
 * An empty constraint list means all models are allowed.
 */
export function isModelAllowedByProfile(profile: AgentProfile, modelId: ProviderModelId): boolean {
  if (profile.modelConstraints.length === 0) return true;
  return profile.modelConstraints.some((id: string) => String(id) === String(modelId));
}

/**
 * How much authority each posture carries. A thread may move down this list
 * when a profile is stricter than it asked to be; it may never move up.
 */
const POLICY_RANK = {
  plan: 0,
  "approval-gated": 1,
  "auto-accept-edits": 2,
  "full-access": 3,
} as const;

function narrowerPolicy(
  left: ProviderExecutionPolicy,
  right: ProviderExecutionPolicy,
): ProviderExecutionPolicy {
  return POLICY_RANK[left] < POLICY_RANK[right] ? left : right;
}

/**
 * Validate that selecting a profile does not silently escalate authority.
 * The posture the thread would actually run under is what has to clear the
 * Project, not the profile's own default: a Full-access profile asked to
 * start in Plan produces a Plan thread and takes nothing the Project has not
 * already granted.
 */
export function validateProfileAuthoritySafety(input: {
  readonly profile: AgentProfile;
  readonly projectExecutionPolicy: ProviderExecutionPolicy;
  readonly requestedExecutionPolicy: ProviderExecutionPolicy;
}): ProfileAuthoritySafety {
  const executionPolicy = narrowerPolicy(
    input.profile.defaultExecutionPolicy,
    input.requestedExecutionPolicy,
  );
  if (POLICY_RANK[executionPolicy] > POLICY_RANK[input.projectExecutionPolicy]) {
    return {
      status: "refused",
      code: "authority-escalation",
      reason: `Profile default policy "${input.profile.defaultExecutionPolicy}" exceeds Project policy "${input.projectExecutionPolicy}". A profile cannot widen Project authority.`,
    };
  }
  return { status: "accepted" };
}

/**
 * How long a granted permission outlives the thread that asked for it. A
 * profile may shorten this, never lengthen it: a profile written to hold Full
 * access to one session must not produce a thread that remembers Full access
 * for the whole Project.
 */
const PERSISTENCE_RANK = { "current-session": 0, "project-default": 1 } as const;

/**
 * Whether a profile's scope reaches the thread being started. Scopes exist to
 * partition profiles by owner, so a Project's profile, another thread's one-off,
 * or a profile written for a different mode must not start this thread just
 * because its identifier was supplied.
 */
export function profileScopeApplies(input: {
  readonly scope: AgentProfileScope;
  readonly mode: OctantMode;
  readonly projectId: string;
  readonly threadId: string;
}): boolean {
  const ref = input.scope.scopeRef;
  if (input.scope.scopeKind === "user") return true;
  if (input.scope.scopeKind === "mode") return ref === String(input.mode);
  if (input.scope.scopeKind === "project") return ref === String(input.projectId);
  return ref === String(input.threadId);
}

/** What binding a profile to a thread did, or why it could not be done. */
export type ProfileApplication =
  | {
      readonly status: "applied";
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly permissionPersistence: PermissionPersistence;
    }
  | {
      readonly status: "refused";
      readonly code: AgentProfileRejectionCode;
      readonly reason: string;
    };

/**
 * Bind a profile to a thread that is starting, and say what posture the thread
 * runs under as a result.
 *
 * A profile narrows and never widens. Where the thread asked for more authority
 * than the profile carries, the profile's posture wins; where it asked for
 * less, its own choice stands, because selecting "Reviewer" is not a request to
 * be granted everything Reviewer is allowed.
 *
 * Refusal is a value rather than a throw: every caller has to answer for the
 * incompatible-mode, disallowed-model, and escalating-profile cases, and a
 * thread that silently started without its profile would run with authority
 * the person believed they had constrained.
 */
export function applyProfileToThread(input: {
  readonly profile: AgentProfile;
  readonly mode: OctantMode;
  readonly modelId: ProviderModelId;
  readonly requestedExecutionPolicy: ProviderExecutionPolicy;
  readonly requestedPermissionPersistence: PermissionPersistence;
  readonly projectExecutionPolicy: ProviderExecutionPolicy;
}): ProfileApplication {
  if (!isProfileModeCompatible(input.profile, input.mode)) {
    return {
      status: "refused",
      code: "mode-incompatible",
      reason: `Profile "${input.profile.displayName}" was not written for ${input.mode}.`,
    };
  }
  if (!isModelAllowedByProfile(input.profile, input.modelId)) {
    return {
      status: "refused",
      code: "model-not-allowed",
      reason: `Profile "${input.profile.displayName}" does not allow model "${String(input.modelId)}".`,
    };
  }
  const executionPolicy = narrowerPolicy(
    input.profile.defaultExecutionPolicy,
    input.requestedExecutionPolicy,
  );
  // The posture the thread would actually run under is what has to clear the
  // Project, not the profile's own default. A Full-access profile asked to
  // start in Plan produces a Plan thread and takes nothing the Project has not
  // already granted; refusing it would refuse the narrower of the two choices.
  const authority = validateProfileAuthoritySafety({
    profile: input.profile,
    projectExecutionPolicy: input.projectExecutionPolicy,
    requestedExecutionPolicy: input.requestedExecutionPolicy,
  });
  if (authority.status === "refused") {
    return {
      status: "refused",
      code: authority.code,
      reason: authority.reason,
    };
  }
  const permissionPersistence =
    PERSISTENCE_RANK[input.profile.defaultPermissionPersistence] <
    PERSISTENCE_RANK[input.requestedPermissionPersistence]
      ? input.profile.defaultPermissionPersistence
      : input.requestedPermissionPersistence;
  return { status: "applied", executionPolicy, permissionPersistence };
}

/**
 * Build execution context picker entries from provider/model/profile combinations.
 * Provider remains the primary grouping; direct API endpoints are first-class.
 *
 * Profile entries are judged by the posture the thread asked for, not the
 * profile's own default, and they show the narrowed result the server applies.
 */
export function buildExecutionContextPickerEntries(input: {
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
    readonly models: ReadonlyArray<{ readonly id: ProviderModelId; readonly displayName: string }>;
    readonly readiness: string;
  }>;
  readonly profiles: ReadonlyArray<AgentProfile>;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly mode: OctantMode;
  readonly projectExecutionPolicy: ProviderExecutionPolicy;
  readonly requestedExecutionPolicy: ProviderExecutionPolicy;
}): ReadonlyArray<ExecutionContextPickerEntry> {
  const entries: ExecutionContextPickerEntry[] = [];
  for (const provider of input.providers) {
    if (provider.readiness !== "ready" && provider.readiness !== "degraded") continue;
    for (const model of provider.models) {
      // Entry without profile
      entries.push({
        providerInstanceId: provider.instanceId,
        providerDisplayName: provider.displayName,
        modelId: model.id,
        modelDisplayName: model.displayName,
        hostId: input.hostId as ExecutionContextPickerEntry["hostId"],
        hostLabel: input.hostLabel,
        executionPolicy: input.requestedExecutionPolicy,
        effectivePermissions: defaultPermissionsForPolicy(input.requestedExecutionPolicy),
      });
      // Entries with compatible profiles
      for (const profile of input.profiles) {
        if (!isProfileModeCompatible(profile, input.mode)) continue;
        if (!isModelAllowedByProfile(profile, model.id)) continue;
        const executionPolicy = narrowerPolicy(
          profile.defaultExecutionPolicy,
          input.requestedExecutionPolicy,
        );
        const authority = validateProfileAuthoritySafety({
          profile,
          projectExecutionPolicy: input.projectExecutionPolicy,
          requestedExecutionPolicy: input.requestedExecutionPolicy,
        });
        entries.push({
          providerInstanceId: provider.instanceId,
          providerDisplayName: provider.displayName,
          modelId: model.id,
          modelDisplayName: model.displayName,
          profileId: profile.id,
          profileDisplayName: profile.displayName,
          hostId: input.hostId as ExecutionContextPickerEntry["hostId"],
          hostLabel: input.hostLabel,
          executionPolicy,
          effectivePermissions: defaultPermissionsForPolicy(executionPolicy),
          ...(authority.status === "refused" ? { unavailableReason: authority.reason } : {}),
        });
      }
    }
  }
  return entries;
}

/**
 * UI-only permission summary derived from execution policy.
 * These flags are display hints, not grants. Server policy remains authoritative.
 * Plan is always read-only. Approval-gated and full-access do not invent network
 * or subagent authority here; those require explicit server-side grants.
 */
function defaultPermissionsForPolicy(
  policy: ProviderExecutionPolicy,
): ExecutionContext["effectivePermissions"] {
  if (policy === "plan") {
    return {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: false,
      subagents: false,
    };
  }
  if (policy === "approval-gated") {
    return {
      filesystem: true,
      shell: true,
      git: true,
      network: false,
      tools: true,
      subagents: false,
    };
  }
  // Full access still does not silently enable network/subagents in the picker.
  return {
    filesystem: true,
    shell: true,
    git: true,
    network: false,
    tools: true,
    subagents: false,
  };
}

/**
 * Filter picker entries by search query across provider, model, profile, host.
 */
export function filterExecutionContextPickerEntries(
  entries: ReadonlyArray<ExecutionContextPickerEntry>,
  query: string,
): ReadonlyArray<ExecutionContextPickerEntry> {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return entries;
  return entries.filter((entry) => {
    const text = [
      entry.providerDisplayName,
      entry.modelDisplayName,
      entry.profileDisplayName ?? "",
      entry.hostLabel,
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(trimmed);
  });
}

/**
 * Result of validating capability constraints against a provider catalog.
 */
export type CapabilityConstraintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate that a model is present in the provider catalog and that the
 * catalog is not invalidated. Tool constraints are checked against the
 * model's capability evidence when present. This is a fail-closed check:
 * an unavailable or invalidated catalog means the combination is unsupported.
 */
export function validateCapabilityConstraints(input: {
  readonly modelId: ProviderModelId;
  readonly catalog: ProviderCatalogSnapshot | undefined;
  readonly toolConstraints: ReadonlyArray<string>;
}): CapabilityConstraintResult {
  if (input.catalog === undefined) {
    return { ok: false, reason: "Provider catalog is unavailable." };
  }
  if (input.catalog.invalidated) {
    return { ok: false, reason: "Provider catalog is unavailable." };
  }
  const model = input.catalog.models.find((m) => String(m.id) === String(input.modelId));
  if (model === undefined) {
    return { ok: false, reason: "Model is not in provider catalog." };
  }
  return { ok: true };
}

/**
 * A candidate resolution step with its source, profile, provider, and model.
 */
interface ResolutionCandidate {
  readonly source: ExecutionResolutionSource;
  readonly profile: AgentProfile | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

/**
 * Input to {@link resolveEffectiveProfile}. The resolution is deterministic:
 * one-off thread override > Project/mode default > user default > no implicit
 * privileged fallback. Provider or host loss never silently changes root,
 * worktree, Project, extension trust, or authority — the receipt records
 * the downgrade and fails closed.
 */
export interface ResolveEffectiveProfileInput {
  readonly mode: OctantMode;
  readonly hostId: HostId;
  readonly projectExecutionPolicy: ProviderExecutionPolicy;
  readonly requestedExecutionPolicy: ProviderExecutionPolicy;
  readonly providers: ReadonlyArray<ProviderInstanceId>;
  readonly catalogs: ReadonlyArray<ProviderCatalogSnapshot>;
  readonly profiles: ReadonlyArray<{
    readonly profile: AgentProfile;
    readonly scope: AgentProfileScope;
  }>;
  readonly oneOffOverride?: {
    readonly profile: AgentProfile;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  };
  readonly projectDefault?: {
    readonly profile: AgentProfile;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  };
  readonly modeDefault?: {
    readonly profile: AgentProfile;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  };
  readonly permissionPersistence?: "current-session" | "project-default";
}

const FALLBACK_CHAIN: ReadonlyArray<ExecutionResolutionSource> = [
  "one-off-override",
  "project-default",
  "mode-default",
  "user-default",
];

/**
 * Resolve the effective execution profile deterministically.
 *
 * Resolution order: one-off thread override > Project/mode default > user
 * default > no implicit privileged fallback. Each step is validated for
 * mode compatibility, model presence in the provider catalog, and authority
 * safety (the narrowed posture the thread would run under must not exceed
 * Project policy). Failed steps record a downgrade reason and the next step
 * is attempted.
 *
 * When all steps fail, the receipt resolves to "none" with the Project's
 * execution policy — never an implicit privileged fallback.
 */
export function resolveEffectiveProfile(
  input: ResolveEffectiveProfileInput,
): ExecutionResolutionReceipt {
  const downgradeReasons: ExecutionDowngradeReason[] = [];
  const providerSet = new Set(input.providers.map((id) => String(id)));
  const catalogByInstance = new Map(input.catalogs.map((c) => [String(c.instanceId), c]));

  const candidates: ResolutionCandidate[] = [];
  if (input.oneOffOverride !== undefined) {
    candidates.push({
      source: "one-off-override",
      profile: input.oneOffOverride.profile,
      providerInstanceId: input.oneOffOverride.providerInstanceId,
      modelId: input.oneOffOverride.modelId,
    });
  }
  if (input.projectDefault !== undefined) {
    candidates.push({
      source: "project-default",
      profile: input.projectDefault.profile,
      providerInstanceId: input.projectDefault.providerInstanceId,
      modelId: input.projectDefault.modelId,
    });
  }
  if (input.modeDefault !== undefined) {
    candidates.push({
      source: "mode-default",
      profile: input.modeDefault.profile,
      providerInstanceId: input.modeDefault.providerInstanceId,
      modelId: input.modeDefault.modelId,
    });
  }
  const userDefault = input.profiles.find((p) => p.scope.scopeKind === "user")?.profile;
  if (userDefault !== undefined) {
    const firstProvider = input.providers[0];
    const firstCatalog = input.catalogs[0];
    const firstModel = firstCatalog?.models[0]?.id;
    if (firstProvider !== undefined && firstModel !== undefined) {
      candidates.push({
        source: "user-default",
        profile: userDefault,
        providerInstanceId: firstProvider,
        modelId: firstModel,
      });
    }
  }

  for (const candidate of candidates) {
    const rejection = validateCandidate(candidate, input, providerSet, catalogByInstance);
    if (rejection !== undefined) {
      downgradeReasons.push({ step: candidate.source, reason: rejection });
      continue;
    }
    return buildReceipt(candidate, input, downgradeReasons);
  }

  return buildNoneReceipt(input, downgradeReasons);
}

function validateCandidate(
  candidate: ResolutionCandidate,
  input: ResolveEffectiveProfileInput,
  providerSet: Set<string>,
  catalogByInstance: Map<string, ProviderCatalogSnapshot>,
): string | undefined {
  if (!providerSet.has(String(candidate.providerInstanceId))) {
    return "Provider instance is unavailable.";
  }
  if (candidate.profile !== undefined) {
    if (!isProfileModeCompatible(candidate.profile, input.mode)) {
      return "Profile is not compatible with the current mode.";
    }
    if (!isModelAllowedByProfile(candidate.profile, candidate.modelId)) {
      return "Model is not allowed by the profile's model constraints.";
    }
    const authority = validateProfileAuthoritySafety({
      profile: candidate.profile,
      projectExecutionPolicy: input.projectExecutionPolicy,
      requestedExecutionPolicy: input.requestedExecutionPolicy,
    });
    if (authority.status === "refused") return authority.reason;
  }
  const capability = validateCapabilityConstraints({
    modelId: candidate.modelId,
    catalog: catalogByInstance.get(String(candidate.providerInstanceId)),
    toolConstraints: candidate.profile?.toolConstraints ?? [],
  });
  if (!capability.ok) return capability.reason;
  return undefined;
}

function buildReceipt(
  candidate: ResolutionCandidate,
  input: ResolveEffectiveProfileInput,
  downgradeReasons: ExecutionDowngradeReason[],
): ExecutionResolutionReceipt {
  const policy =
    candidate.profile === undefined
      ? input.requestedExecutionPolicy
      : narrowerPolicy(candidate.profile.defaultExecutionPolicy, input.requestedExecutionPolicy);
  return {
    providerInstanceId: candidate.providerInstanceId,
    modelId: candidate.modelId,
    ...(candidate.profile === undefined ? {} : { profileId: candidate.profile.id }),
    hostId: input.hostId,
    executionPolicy: policy,
    permissionPersistence: input.permissionPersistence ?? "current-session",
    effectivePermissions: defaultPermissionsForPolicy(policy),
    source: candidate.source,
    fallbackChain: FALLBACK_CHAIN,
    downgradeReasons,
  };
}

function buildNoneReceipt(
  input: ResolveEffectiveProfileInput,
  downgradeReasons: ExecutionDowngradeReason[],
): ExecutionResolutionReceipt {
  return {
    providerInstanceId:
      input.providers[0] ?? ("00000000-0000-0000-0000-000000000000" as ProviderInstanceId),
    modelId: "" as ProviderModelId,
    hostId: input.hostId,
    executionPolicy: input.projectExecutionPolicy,
    permissionPersistence: input.permissionPersistence ?? "current-session",
    effectivePermissions: defaultPermissionsForPolicy(input.projectExecutionPolicy),
    source: "none",
    fallbackChain: FALLBACK_CHAIN,
    downgradeReasons,
  };
}

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

export class AgentProfileRejected extends Error {
  override readonly name = "AgentProfileRejected";
  constructor(
    readonly code: AgentProfileRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

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
 * Validate that selecting a profile does not silently escalate authority.
 * A profile may only narrow permissions, never widen them beyond what the
 * Project/root/host already grants.
 */
export function validateProfileAuthoritySafety(input: {
  readonly profile: AgentProfile;
  readonly projectExecutionPolicy: ProviderExecutionPolicy;
}): void {
  const policyRank = {
    plan: 0,
    "approval-gated": 1,
    "auto-accept-edits": 2,
    "full-access": 3,
  } as const;
  if (policyRank[input.profile.defaultExecutionPolicy] > policyRank[input.projectExecutionPolicy]) {
    throw new AgentProfileRejected(
      "authority-escalation",
      `Profile default policy "${input.profile.defaultExecutionPolicy}" exceeds Project policy "${input.projectExecutionPolicy}". A profile cannot widen Project authority.`,
    );
  }
}

/**
 * Build execution context picker entries from provider/model/profile combinations.
 * Provider remains the primary grouping; direct API endpoints are first-class.
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
        executionPolicy: input.projectExecutionPolicy,
        effectivePermissions: defaultPermissionsForPolicy(input.projectExecutionPolicy),
      });
      // Entries with compatible profiles
      for (const profile of input.profiles) {
        if (!isProfileModeCompatible(profile, input.mode)) continue;
        if (!isModelAllowedByProfile(profile, model.id)) continue;
        let unavailableReason: string | undefined;
        try {
          validateProfileAuthoritySafety({
            profile,
            projectExecutionPolicy: input.projectExecutionPolicy,
          });
        } catch (error) {
          unavailableReason =
            error instanceof AgentProfileRejected ? error.message : "Profile rejected.";
        }
        entries.push({
          providerInstanceId: provider.instanceId,
          providerDisplayName: provider.displayName,
          modelId: model.id,
          modelDisplayName: model.displayName,
          profileId: profile.id,
          profileDisplayName: profile.displayName,
          hostId: input.hostId as ExecutionContextPickerEntry["hostId"],
          hostLabel: input.hostLabel,
          executionPolicy: profile.defaultExecutionPolicy,
          effectivePermissions: defaultPermissionsForPolicy(profile.defaultExecutionPolicy),
          ...(unavailableReason === undefined ? {} : { unavailableReason }),
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
 * safety (profile policy must not exceed Project policy). Failed steps
 * record a downgrade reason and the next step is attempted.
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
    try {
      validateProfileAuthoritySafety({
        profile: candidate.profile,
        projectExecutionPolicy: input.projectExecutionPolicy,
      });
    } catch (error) {
      if (error instanceof AgentProfileRejected) return error.message;
      return "Profile authority validation failed.";
    }
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
  const policy = candidate.profile?.defaultExecutionPolicy ?? input.projectExecutionPolicy;
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

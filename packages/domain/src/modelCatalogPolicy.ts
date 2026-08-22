import type {
  CapabilityEvidence,
  CapabilityEvidenceSource,
  ProviderDriverKind,
  ProviderCapabilitySupport,
  ProviderInstance,
  ProviderModel,
} from "@octant/contracts";
import type { UtcTimestamp } from "@octant/contracts/events";

const evidenceSourceRank: Record<CapabilityEvidence["source"], number> = {
  "endpoint-observation": 5,
  "provider-metadata": 4,
  "catalog-metadata": 3,
  "user-metadata": 2,
  unknown: 1,
};

const confidenceRank: Record<CapabilityEvidence["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function orderProviderInstances(
  instances: ReadonlyArray<ProviderInstance>,
  preferredOrder: ReadonlyArray<ProviderInstance["id"]>,
): ReadonlyArray<ProviderInstance> {
  const preferredIndex = new Map(preferredOrder.map((id, index) => [String(id), index]));
  return deduplicateById(instances).sort((left, right) => {
    const leftPreferred = preferredIndex.get(String(left.id));
    const rightPreferred = preferredIndex.get(String(right.id));
    if (leftPreferred !== undefined || rightPreferred !== undefined) {
      if (leftPreferred === undefined) return 1;
      if (rightPreferred === undefined) return -1;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
    }
    const byName = naturalOrder.compare(left.displayName, right.displayName);
    return byName !== 0 ? byName : naturalOrder.compare(String(left.id), String(right.id));
  });
}

export function orderProviderModels(
  models: ReadonlyArray<ProviderModel>,
  manualOrder: ReadonlyArray<ProviderModel["id"]>,
): ReadonlyArray<ProviderModel> {
  const manualIndex = new Map(manualOrder.map((id, index) => [String(id), index]));
  return deduplicateById(models).sort((left, right) => {
    const leftManual = manualIndex.get(String(left.id));
    const rightManual = manualIndex.get(String(right.id));
    if (leftManual !== undefined || rightManual !== undefined) {
      if (leftManual === undefined) return 1;
      if (rightManual === undefined) return -1;
      if (leftManual !== rightManual) return leftManual - rightManual;
    }

    const leftHint = left.orderHint;
    const rightHint = right.orderHint;
    if (leftHint !== undefined || rightHint !== undefined) {
      if (leftHint === undefined) return 1;
      if (rightHint === undefined) return -1;
      if (leftHint !== rightHint) return leftHint - rightHint;
    }

    return 0;
  });
}

export function resolveCapabilitySupport(
  evidence: ReadonlyArray<CapabilityEvidence>,
): ProviderCapabilitySupport {
  const active = evidence.filter(({ invalidated }) => !invalidated);
  const selected = [...active].sort(compareEvidence)[0];
  return selected?.support ?? "unavailable";
}

export function hasVerifiedToolAuthority(model: ProviderModel): boolean {
  return (
    resolveCapabilitySupport(
      (model.capabilityEvidence ?? []).filter(({ capability }) => capability === "tool-calling"),
    ) === "supported" &&
    (model.capabilityEvidence ?? []).some(
      ({ capability, source, support, invalidated }) =>
        capability === "tool-calling" &&
        support === "supported" &&
        !invalidated &&
        (source === "endpoint-observation" || source === "provider-metadata"),
    )
  );
}

const nativeToolRuntimeDrivers: ReadonlySet<ProviderDriverKind> = new Set([
  "codex",
  "claude",
  "opencode",
  "kilo",
  "pi",
  "devin",
  "kimi-code",
  "mistral-vibe",
  "grok",
]);

export function isNativeToolRuntimeDriver(driverKind: ProviderDriverKind): boolean {
  return nativeToolRuntimeDrivers.has(driverKind);
}

// Native agent runtimes (Codex CLI, Claude SDK, OpenCode, ACP drivers) supply
// tool execution from the provider runtime rather than a direct-model
// tool-calling loop, so their probes intentionally omit model-level
// tool-calling evidence. For those drivers a ready probe with a verified
// discovered model is sufficient Work tool authority; HTTP drivers keep the
// model-level evidence requirement.
export function hasWorkToolAuthority(
  driverKind: ProviderDriverKind,
  model: ProviderModel,
  verifiedToolModelIds: ReadonlyArray<ProviderModel["id"]> = [],
): boolean {
  if (
    driverKind === "azure-foundry" &&
    verifiedToolModelIds.some((id) => String(id) === String(model.id))
  ) {
    return true;
  }
  if (isNativeToolRuntimeDriver(driverKind)) {
    return model.verification === "verified";
  }
  return hasVerifiedToolAuthority(model);
}

function compareEvidence(left: CapabilityEvidence, right: CapabilityEvidence): number {
  const bySource = evidenceSourceRank[right.source] - evidenceSourceRank[left.source];
  if (bySource !== 0) return bySource;
  const byConfidence = confidenceRank[right.confidence] - confidenceRank[left.confidence];
  if (byConfidence !== 0) return byConfidence;
  return right.observedAt.localeCompare(left.observedAt);
}

function deduplicateById<T extends { readonly id: string }>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = String(value.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export type CapabilityEvidenceChange =
  | { readonly kind: "endpoint" }
  | { readonly kind: "authentication" }
  | { readonly kind: "protocol"; readonly previousProtocol: CapabilityEvidence["protocol"] }
  | { readonly kind: "driver" }
  | { readonly kind: "all" };

const endpointDerivedSources: ReadonlySet<CapabilityEvidenceSource> = new Set([
  "endpoint-observation",
  "provider-metadata",
]);

function shouldInvalidateForChange(
  record: CapabilityEvidence,
  change: CapabilityEvidenceChange,
): boolean {
  switch (change.kind) {
    case "endpoint":
    case "authentication":
      return endpointDerivedSources.has(record.source);
    case "protocol":
      return (
        endpointDerivedSources.has(record.source) &&
        (record.protocol === change.previousProtocol || record.protocol === "unknown")
      );
    case "driver":
    case "all":
      return true;
  }
}

export function invalidateModelCapabilityEvidence(
  evidence: ReadonlyArray<CapabilityEvidence>,
  change: CapabilityEvidenceChange,
  invalidatedAt: UtcTimestamp,
  reason: string,
): ReadonlyArray<CapabilityEvidence> {
  return evidence.map((record) => {
    if (record.invalidated || !shouldInvalidateForChange(record, change)) return record;
    return {
      ...record,
      invalidated: true,
      invalidatedAt,
      invalidationReason: reason,
    };
  });
}

function endpointOf(instance: ProviderInstance): string | undefined {
  switch (instance.configuration.kind) {
    case "openai-compatible-http":
    case "anthropic-compatible-http":
    case "azure-foundry-openai-http":
    case "ollama-native-http":
      return instance.configuration.baseUrl;
    default:
      return undefined;
  }
}

function configProtocolOf(instance: ProviderInstance): string | undefined {
  switch (instance.configuration.kind) {
    case "openai-compatible-http":
      return instance.configuration.protocol;
    case "anthropic-compatible-http":
      return instance.configuration.protocol;
    case "azure-foundry-openai-http":
      return instance.configuration.protocol;
    default:
      return undefined;
  }
}

function evidenceProtocolOf(
  instance: ProviderInstance,
): CapabilityEvidence["protocol"] | undefined {
  switch (instance.configuration.kind) {
    case "openai-compatible-http":
      return instance.configuration.protocol === "auto"
        ? undefined
        : instance.configuration.protocol;
    case "anthropic-compatible-http":
      return instance.configuration.protocol === "auto" ? undefined : "anthropic-messages";
    case "azure-foundry-openai-http":
      return instance.configuration.protocol === "auto"
        ? undefined
        : instance.configuration.protocol;
    default:
      return undefined;
  }
}

function authenticationOf(instance: ProviderInstance): string | undefined {
  switch (instance.configuration.kind) {
    case "openai-compatible-http":
      return instance.configuration.authentication;
    case "anthropic-compatible-http":
      return instance.configuration.authentication;
    case "azure-foundry-openai-http":
      return instance.configuration.authentication;
    case "claude-agent-sdk":
      return instance.configuration.authentication;
    case "mistral-vibe-acp":
      return instance.configuration.authentication;
    case "grok-acp":
      return instance.configuration.authentication;
    case "devin-acp":
      return instance.configuration.authentication;
    default:
      return undefined;
  }
}

function binaryOf(instance: ProviderInstance): string | undefined {
  switch (instance.configuration.kind) {
    case "opencode-cli":
    case "codex-cli":
    case "kimi-code-acp":
    case "kilo-acp":
    case "devin-acp":
    case "pi-rpc":
    case "mistral-vibe-acp":
    case "grok-acp":
    case "claude-agent-sdk":
      return instance.configuration.binaryPath;
    default:
      return undefined;
  }
}

export function describeProviderConfigurationChange(
  previous: ProviderInstance,
  next: ProviderInstance,
): CapabilityEvidenceChange {
  const previousEndpoint = endpointOf(previous);
  const nextEndpoint = endpointOf(next);
  if (
    previousEndpoint !== undefined &&
    nextEndpoint !== undefined &&
    previousEndpoint !== nextEndpoint
  ) {
    return { kind: "endpoint" };
  }
  const previousBinary = binaryOf(previous);
  const nextBinary = binaryOf(next);
  if (previousBinary !== undefined && nextBinary !== undefined && previousBinary !== nextBinary) {
    return { kind: "driver" };
  }
  const previousAuth = authenticationOf(previous);
  const nextAuth = authenticationOf(next);
  if (previousAuth !== undefined && nextAuth !== undefined && previousAuth !== nextAuth) {
    return { kind: "authentication" };
  }
  const previousConfigProtocol = configProtocolOf(previous);
  const nextConfigProtocol = configProtocolOf(next);
  if (
    previousConfigProtocol !== undefined &&
    nextConfigProtocol !== undefined &&
    previousConfigProtocol !== nextConfigProtocol
  ) {
    const previousEvidenceProtocol = evidenceProtocolOf(previous);
    const nextEvidenceProtocol = evidenceProtocolOf(next);
    if (
      previousEvidenceProtocol !== undefined &&
      nextEvidenceProtocol !== undefined &&
      previousEvidenceProtocol !== nextEvidenceProtocol
    ) {
      return { kind: "protocol", previousProtocol: previousEvidenceProtocol };
    }
    return { kind: "endpoint" };
  }
  return { kind: "all" };
}

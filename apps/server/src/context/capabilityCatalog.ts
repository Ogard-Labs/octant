import { createHash } from "node:crypto";
import type {
  ContextRoutingEligibility,
  KnownTokenMeasurement,
  ProviderCapabilitySupport,
  ProviderInstanceId,
  TokenMeasurement,
} from "@octant/contracts";

export type CapabilityComponentKind =
  | "octant-tool"
  | "mcp-tool"
  | "mcp-prompt"
  | "mcp-resource"
  | "skill-instruction"
  | "plugin-instruction";

export type CapabilityTrust = "trusted" | "untrusted" | "quarantined";
export type CapabilityEnablement = "enabled" | "disabled";
export type CapabilityPolicy = "allowed" | "denied";
export type CapabilityAvailability = "available" | "unavailable";
export type CapabilityScopeEligibility = "eligible" | "ineligible" | "unknown";
export type CapabilityPosture = "essential" | "optional";
export type CapabilitySelectionMode = "automatic" | "explicit" | "task-specific";

interface CapabilitySourceBase {
  readonly referenceId: string;
  readonly componentId: string;
}

export type CapabilitySource =
  | (CapabilitySourceBase & { readonly kind: "octant-tool" | "mcp-server" })
  | (CapabilitySourceBase & {
      readonly kind: "plugin-package" | "skill-package" | "agents-skills-directory";
      readonly packageId: string;
    });

export type EpochInvalidationFact =
  | { readonly kind: "tools/list-changed" }
  | { readonly kind: "enablement-changed"; readonly sourceId: string }
  | { readonly kind: "trust-changed"; readonly sourceId: string }
  | { readonly kind: "policy-changed"; readonly sourceId: string }
  | { readonly kind: "scope-changed"; readonly scope: "mode" | "project" | "host" }
  | { readonly kind: "provider-changed"; readonly providerInstanceId: string }
  | { readonly kind: "model-changed"; readonly modelId: string }
  | { readonly kind: "explicit-refresh" };

export interface CatalogEpoch {
  readonly value: number;
  readonly fingerprint: string;
  readonly activeFacts: CatalogActiveFacts;
  readonly facts: ReadonlyArray<EpochInvalidationFact>;
}

export interface CapabilityScopeIdentity {
  readonly referenceId: string;
  readonly revision: number;
}

export interface CapabilityScopeEligibilityFact extends CapabilityScopeIdentity {
  readonly status: CapabilityScopeEligibility;
}

export interface CapabilityActiveScope {
  readonly mode: CapabilityScopeIdentity;
  readonly project: CapabilityScopeIdentity;
  readonly host: CapabilityScopeIdentity;
  readonly model: CapabilityScopeIdentity;
}

export interface CatalogActiveFacts {
  readonly providerInstanceId: ProviderInstanceId;
  readonly activeScope: CapabilityActiveScope;
}

export interface DeriveCatalogEpochOptions {
  readonly previous?: CatalogEpoch;
  readonly entries: ReadonlyArray<CapabilityCatalogEntry>;
  readonly activeFacts: CatalogActiveFacts;
  readonly invalidationFacts: ReadonlyArray<EpochInvalidationFact>;
}

export interface CapabilityCatalogEntry {
  readonly id: string;
  readonly source: CapabilitySource;
  readonly componentKind: CapabilityComponentKind;
  readonly label: string;
  readonly schemaCost: TokenMeasurement;
  readonly availability: CapabilityAvailability;
  readonly trust: CapabilityTrust;
  readonly enablement: CapabilityEnablement;
  readonly policy: CapabilityPolicy;
  readonly providerEligibility: ContextRoutingEligibility;
  readonly scopeEligibility: {
    readonly mode: CapabilityScopeEligibilityFact;
    readonly project: CapabilityScopeEligibilityFact;
    readonly host: CapabilityScopeEligibilityFact;
    readonly model: CapabilityScopeEligibilityFact;
  };
  readonly posture: CapabilityPosture;
  readonly selectionMode: CapabilitySelectionMode;
  readonly taskKeywords: ReadonlyArray<string>;
  readonly epoch: number;
  readonly invalidationFacts: ReadonlyArray<EpochInvalidationFact>;
}

export interface CapabilityCatalog {
  readonly epoch: CatalogEpoch;
  readonly entries: ReadonlyArray<CapabilityCatalogEntry>;
}

export interface CapabilitySelectionRequest {
  readonly providerInstanceId: ProviderInstanceId;
  readonly activeScope: CapabilityActiveScope;
  readonly nativeToolSearch: ProviderCapabilitySupport;
  readonly taskKeywords: ReadonlyArray<string>;
  readonly explicitSelections: ReadonlyArray<string>;
  readonly maxOptionalTaskSpecific?: number;
  readonly maxTotalSelected?: number;
  readonly maxEssential?: number;
}

export interface CapabilitySelection {
  readonly status: "selected" | "blocked";
  readonly blockedReasons: ReadonlyArray<string>;
  readonly selected: ReadonlyArray<CapabilityCatalogEntry>;
  readonly loadedSchemaIds: ReadonlyArray<string>;
  readonly omitted: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  readonly totalCost: TokenMeasurement;
  readonly nativeToolSearch: ProviderCapabilitySupport;
  readonly selectionStrategy: "native-search" | "task-specific-bundle";
  readonly explicitlySelectedIds: ReadonlyArray<string>;
  readonly epoch: CatalogEpoch;
}

const DEFAULT_MAX_OPTIONAL_TASK_SPECIFIC = 3;
const DEFAULT_MAX_TOTAL_SELECTED = 16;
const DEFAULT_MAX_ESSENTIAL = 8;
export const MAX_OPTIONAL_TASK_SPECIFIC = 8;
export const MAX_TOTAL_SELECTED = 32;
export const MAX_ESSENTIAL = 8;

const accuracyRank: Record<KnownTokenMeasurement["accuracy"], number> = {
  "provider-reported": 0,
  "exact-tokenizer": 1,
  "model-family-estimate": 2,
  "conservative-heuristic": 3,
};

const capabilityComponentKinds = new Set<string>([
  "octant-tool",
  "mcp-tool",
  "mcp-prompt",
  "mcp-resource",
  "skill-instruction",
  "plugin-instruction",
]);
const capabilitySourceKinds = new Set<string>([
  "octant-tool",
  "mcp-server",
  "plugin-package",
  "skill-package",
  "agents-skills-directory",
]);
const capabilityPostures = new Set<string>(["essential", "optional"]);
const capabilitySelectionModes = new Set<string>(["automatic", "explicit", "task-specific"]);
const capabilityTrustValues = new Set<string>(["trusted", "untrusted", "quarantined"]);
const capabilityEnablementValues = new Set<string>(["enabled", "disabled"]);
const capabilityPolicyValues = new Set<string>(["allowed", "denied"]);
const capabilityAvailabilityValues = new Set<string>(["available", "unavailable"]);
const capabilityScopeEligibilityValues = new Set<string>(["eligible", "ineligible", "unknown"]);
const providerCapabilitySupportValues = new Set<string>([
  "supported",
  "unsupported",
  "unavailable",
]);
const knownTokenAccuracies = new Set<string>([
  "provider-reported",
  "exact-tokenizer",
  "model-family-estimate",
  "conservative-heuristic",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const catalogFingerprintPattern = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isProviderInstanceId(value: unknown): value is ProviderInstanceId {
  return typeof value === "string" && uuidPattern.test(value);
}

function invalidationFactFailure(value: unknown, prefix: string): string | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return prefix;
  switch (value.kind) {
    case "tools/list-changed":
    case "explicit-refresh":
      return undefined;
    case "enablement-changed":
    case "trust-changed":
    case "policy-changed":
      return isNonEmptyIdentity(value.sourceId) ? undefined : prefix;
    case "scope-changed":
      return value.scope === "mode" || value.scope === "project" || value.scope === "host"
        ? undefined
        : prefix;
    case "provider-changed":
      return isProviderInstanceId(value.providerInstanceId) ? undefined : prefix;
    case "model-changed":
      return isNonEmptyIdentity(value.modelId) ? undefined : prefix;
    default:
      return prefix;
  }
}

function invalidationFactFailures(value: unknown, prefix: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [`${prefix}-array`];
  const failures: Array<string> = [];
  for (const [index, fact] of value.entries()) {
    const failure = invalidationFactFailure(fact, `${prefix}:${index}`);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

function scopeIdentityFailure(value: unknown): boolean {
  return (
    !isRecord(value) ||
    !isNonEmptyIdentity(value.referenceId) ||
    !isSafeNonNegativeInteger(value.revision)
  );
}

function scopeEligibilityFactFailure(value: unknown): boolean {
  return (
    scopeIdentityFailure(value) ||
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !capabilityScopeEligibilityValues.has(value.status)
  );
}

function activeScopeRuntimeFailures(value: unknown, prefix: string): ReadonlyArray<string> {
  if (!isRecord(value)) return [`${prefix}-object`];
  const failures: Array<string> = [];
  for (const scope of ["mode", "project", "host", "model"] as const) {
    if (scopeIdentityFailure(value[scope])) failures.push(`${prefix}:${scope}`);
  }
  return failures;
}

function tokenMeasurementFailure(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return true;
  if (value.kind === "known") {
    return (
      !isSafeNonNegativeInteger(value.tokens) ||
      typeof value.accuracy !== "string" ||
      !knownTokenAccuracies.has(value.accuracy)
    );
  }
  return value.kind !== "unknown" || value.accuracy !== "unknown" || "tokens" in value;
}

function providerEligibilityFailure(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isProviderInstanceId(value.providerInstanceId) ||
    (value.status !== "eligible" && value.status !== "ineligible")
  ) {
    return true;
  }
  if (value.status === "eligible") return value.reason !== "selected-provider";
  return !new Set([
    "provider-mismatch",
    "privacy-local-only",
    "cross-provider-opt-in-required",
    "authority-denied",
    "source-disabled",
    "unknown",
  ]).has(value.reason as string);
}

function stringArrayFailures(value: unknown, prefix: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [`${prefix}-array`];
  const failures: Array<string> = [];
  for (const [index, item] of value.entries()) {
    if (!isNonEmptyIdentity(item)) failures.push(`${prefix}:${index}`);
  }
  return failures;
}

function eligibilityFailureReason(
  entry: CapabilityCatalogEntry,
  request: CapabilitySelectionRequest,
): string | undefined {
  if (entry.availability !== "available") return "unavailable";
  if (entry.enablement !== "enabled") return "disabled";
  if (entry.trust !== "trusted") return "untrusted";
  if (entry.policy !== "allowed") return "denied";
  if (entry.providerEligibility.status !== "eligible") return "provider-ineligible";
  if (entry.providerEligibility.providerInstanceId !== request.providerInstanceId) {
    return "provider-mismatch";
  }
  for (const scope of ["mode", "project", "host", "model"] as const) {
    const fact = entry.scopeEligibility[scope];
    if (fact.status === "ineligible") return `${scope}-ineligible`;
    if (fact.status === "unknown") return `${scope}-ambiguous`;
    const active = request.activeScope[scope];
    if (fact.referenceId !== active.referenceId) return `${scope}-scope-mismatch`;
    if (fact.revision !== active.revision) return `${scope}-revision-mismatch`;
  }
  return undefined;
}

function requiresExplicitSelection(entry: CapabilityCatalogEntry): boolean {
  return (
    entry.selectionMode === "explicit" ||
    entry.componentKind === "mcp-prompt" ||
    entry.componentKind === "mcp-resource" ||
    entry.source.kind === "agents-skills-directory"
  );
}

function scoreTaskRelevance(
  entry: CapabilityCatalogEntry,
  taskKeywords: ReadonlyArray<string>,
): number {
  if (taskKeywords.length === 0 || entry.taskKeywords.length === 0) return 0;
  const entryKeywords = new Set(entry.taskKeywords.map((keyword) => keyword.toLowerCase()));
  let score = 0;
  for (const keyword of taskKeywords) {
    if (entryKeywords.has(keyword.toLowerCase())) score++;
  }
  return score;
}

const postureRank: Record<CapabilityPosture, number> = {
  essential: 0,
  optional: 1,
};

const componentKindRank: Record<CapabilityComponentKind, number> = {
  "octant-tool": 0,
  "mcp-tool": 1,
  "skill-instruction": 2,
  "plugin-instruction": 3,
  "mcp-prompt": 4,
  "mcp-resource": 5,
};

function compareEntryOrder(left: CapabilityCatalogEntry, right: CapabilityCatalogEntry): number {
  const postureDiff = postureRank[left.posture] - postureRank[right.posture];
  if (postureDiff !== 0) return postureDiff;
  const kindDiff = componentKindRank[left.componentKind] - componentKindRank[right.componentKind];
  if (kindDiff !== 0) return kindDiff;
  return compareCodePoints(left.id, right.id);
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index++) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function stableInvalidationFact(fact: EpochInvalidationFact): string {
  switch (fact.kind) {
    case "enablement-changed":
    case "trust-changed":
    case "policy-changed":
      return `${fact.kind}:${fact.sourceId}`;
    case "scope-changed":
      return `${fact.kind}:${fact.scope}`;
    case "provider-changed":
      return `${fact.kind}:${fact.providerInstanceId}`;
    case "model-changed":
      return `${fact.kind}:${fact.modelId}`;
    case "tools/list-changed":
    case "explicit-refresh":
      return fact.kind;
  }
}

function stableScopeIdentity(identity: CapabilityScopeIdentity): ReadonlyArray<string | number> {
  return [identity.referenceId, identity.revision];
}

function stableEntryFact(entry: CapabilityCatalogEntry): ReadonlyArray<unknown> {
  const eligibility = entry.scopeEligibility;
  return [
    entry.id,
    entry.source.kind,
    entry.source.referenceId,
    "packageId" in entry.source ? entry.source.packageId : "",
    entry.source.componentId,
    entry.componentKind,
    entry.label,
    entry.schemaCost.kind,
    entry.schemaCost.kind === "known" ? entry.schemaCost.tokens : "",
    entry.schemaCost.accuracy,
    entry.availability,
    entry.trust,
    entry.enablement,
    entry.policy,
    entry.providerEligibility.providerInstanceId,
    entry.providerEligibility.status,
    entry.providerEligibility.reason,
    ...stableScopeIdentity(eligibility.mode),
    eligibility.mode.status,
    ...stableScopeIdentity(eligibility.project),
    eligibility.project.status,
    ...stableScopeIdentity(eligibility.host),
    eligibility.host.status,
    ...stableScopeIdentity(eligibility.model),
    eligibility.model.status,
    entry.posture,
    entry.selectionMode,
    [...entry.taskKeywords].sort(compareCodePoints),
    entry.epoch,
    entry.invalidationFacts.map(stableInvalidationFact).sort(compareCodePoints),
  ];
}

function catalogFingerprint(
  entries: ReadonlyArray<CapabilityCatalogEntry>,
  activeFacts: CatalogActiveFacts,
): string {
  const canonical = JSON.stringify([
    activeFacts.providerInstanceId,
    stableScopeIdentity(activeFacts.activeScope.mode),
    stableScopeIdentity(activeFacts.activeScope.project),
    stableScopeIdentity(activeFacts.activeScope.host),
    stableScopeIdentity(activeFacts.activeScope.model),
    [...entries].sort(compareEntryOrder).map(stableEntryFact),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function derivedActiveFactInvalidations(
  previous: CatalogEpoch | undefined,
  activeFacts: CatalogActiveFacts,
): ReadonlyArray<EpochInvalidationFact> {
  if (previous === undefined) return [];
  const facts: Array<EpochInvalidationFact> = [];
  if (previous.activeFacts.providerInstanceId !== activeFacts.providerInstanceId) {
    facts.push({
      kind: "provider-changed",
      providerInstanceId: activeFacts.providerInstanceId,
    });
  }
  for (const scope of ["mode", "project", "host"] as const) {
    const before = previous.activeFacts.activeScope[scope];
    const after = activeFacts.activeScope[scope];
    if (before.referenceId !== after.referenceId || before.revision !== after.revision) {
      facts.push({ kind: "scope-changed", scope });
    }
  }
  const previousModel = previous.activeFacts.activeScope.model;
  const activeModel = activeFacts.activeScope.model;
  if (
    previousModel.referenceId !== activeModel.referenceId ||
    previousModel.revision !== activeModel.revision
  ) {
    facts.push({ kind: "model-changed", modelId: activeModel.referenceId });
  }
  return facts;
}

export function deriveCatalogEpoch(options: DeriveCatalogEpochOptions): CatalogEpoch {
  const fingerprint = catalogFingerprint(options.entries, options.activeFacts);
  if (options.previous?.fingerprint === fingerprint && options.invalidationFacts.length === 0)
    return options.previous;
  if (options.previous !== undefined && options.previous.value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Catalog epoch exhausted");
  }
  const facts = [
    ...derivedActiveFactInvalidations(options.previous, options.activeFacts),
    ...options.invalidationFacts,
  ];
  if (options.previous !== undefined && facts.length === 0)
    facts.push({ kind: "explicit-refresh" });
  const uniqueFacts = new Map<string, EpochInvalidationFact>();
  for (const fact of facts) uniqueFacts.set(stableInvalidationFact(fact), fact);
  return {
    value: (options.previous?.value ?? 0) + 1,
    fingerprint,
    activeFacts: options.activeFacts,
    facts: [...uniqueFacts.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([, fact]) => fact),
  };
}

const allowedComponentsBySource: Record<
  CapabilitySource["kind"],
  ReadonlySet<CapabilityComponentKind>
> = {
  "octant-tool": new Set(["octant-tool"]),
  "mcp-server": new Set(["mcp-tool", "mcp-prompt", "mcp-resource"]),
  "plugin-package": new Set(["plugin-instruction", "mcp-tool", "mcp-prompt", "mcp-resource"]),
  "skill-package": new Set(["skill-instruction"]),
  "agents-skills-directory": new Set(["skill-instruction"]),
};

function catalogEpochRuntimeFailures(value: unknown): ReadonlyArray<string> {
  if (!isRecord(value)) return ["invalid-catalog-epoch"];
  const failures: Array<string> = [];
  if (!Number.isSafeInteger(value.value) || (value.value as number) <= 0) {
    failures.push("invalid-catalog-epoch-value");
  }
  if (typeof value.fingerprint !== "string" || !catalogFingerprintPattern.test(value.fingerprint)) {
    failures.push("invalid-catalog-fingerprint");
  }
  if (!isRecord(value.activeFacts)) {
    failures.push("invalid-epoch-active-facts");
  } else {
    if (!isProviderInstanceId(value.activeFacts.providerInstanceId)) {
      failures.push("invalid-epoch-provider-instance");
    }
    failures.push(
      ...activeScopeRuntimeFailures(value.activeFacts.activeScope, "invalid-epoch-active-scope"),
    );
  }
  failures.push(...invalidationFactFailures(value.facts, "invalid-epoch-fact"));
  return failures;
}

function capabilityEntryRuntimeFailures(value: unknown, index: number): ReadonlyArray<string> {
  if (!isRecord(value)) return [`invalid-capability-entry:${index}`];
  const failures: Array<string> = [];
  const id = isNonEmptyIdentity(value.id) ? value.id : `index-${index}`;
  if (!isNonEmptyIdentity(value.id)) failures.push(`invalid-capability-id:${index}`);

  const source = value.source;
  const sourceKind = isRecord(source) && typeof source.kind === "string" ? source.kind : undefined;
  if (sourceKind === undefined || !capabilitySourceKinds.has(sourceKind)) {
    failures.push(`invalid-source-kind:${id}`);
  }
  if (
    !isRecord(source) ||
    !isNonEmptyIdentity(source.referenceId) ||
    !isNonEmptyIdentity(source.componentId) ||
    ((sourceKind === "plugin-package" ||
      sourceKind === "skill-package" ||
      sourceKind === "agents-skills-directory") &&
      !isNonEmptyIdentity(source.packageId))
  ) {
    failures.push(`invalid-source-identity:${id}`);
  }

  const componentKind = value.componentKind;
  if (typeof componentKind !== "string" || !capabilityComponentKinds.has(componentKind)) {
    failures.push(`invalid-component-kind:${id}`);
  } else if (
    sourceKind !== undefined &&
    capabilitySourceKinds.has(sourceKind) &&
    !allowedComponentsBySource[sourceKind as CapabilitySource["kind"]].has(
      componentKind as CapabilityComponentKind,
    )
  ) {
    failures.push(`invalid-source-component:${id}`);
  }

  if (!isNonEmptyIdentity(value.label)) failures.push(`invalid-capability-label:${id}`);
  if (tokenMeasurementFailure(value.schemaCost)) failures.push(`invalid-schema-cost:${id}`);
  if (
    typeof value.availability !== "string" ||
    !capabilityAvailabilityValues.has(value.availability)
  )
    failures.push(`invalid-availability:${id}`);
  if (typeof value.trust !== "string" || !capabilityTrustValues.has(value.trust))
    failures.push(`invalid-trust:${id}`);
  if (typeof value.enablement !== "string" || !capabilityEnablementValues.has(value.enablement))
    failures.push(`invalid-enablement:${id}`);
  if (typeof value.policy !== "string" || !capabilityPolicyValues.has(value.policy))
    failures.push(`invalid-policy:${id}`);
  if (providerEligibilityFailure(value.providerEligibility))
    failures.push(`invalid-provider-eligibility:${id}`);

  if (!isRecord(value.scopeEligibility)) {
    failures.push(`invalid-scope-eligibility:${id}`);
  } else {
    for (const scopeName of ["mode", "project", "host", "model"] as const) {
      if (scopeEligibilityFactFailure(value.scopeEligibility[scopeName])) {
        failures.push(`invalid-scope-identity:${id}:${scopeName}`);
      }
    }
  }

  if (typeof value.posture !== "string" || !capabilityPostures.has(value.posture)) {
    failures.push(`invalid-posture:${id}`);
  }
  if (typeof value.selectionMode !== "string" || !capabilitySelectionModes.has(value.selectionMode))
    failures.push(`invalid-selection-mode:${id}`);
  failures.push(...stringArrayFailures(value.taskKeywords, `invalid-task-keyword:${id}`));
  if (!isSafeNonNegativeInteger(value.epoch)) failures.push(`invalid-entry-epoch:${id}`);
  failures.push(...invalidationFactFailures(value.invalidationFacts, `invalid-entry-fact:${id}`));

  if (
    value.posture === "essential" &&
    (sourceKind !== "octant-tool" || componentKind !== "octant-tool")
  ) {
    failures.push(`invalid-essential-posture:${id}`);
  }
  return failures;
}

function catalogRuntimeFailures(value: unknown): ReadonlyArray<string> {
  if (!isRecord(value)) return ["invalid-capability-catalog"];
  const failures: Array<string> = [];
  failures.push(...catalogEpochRuntimeFailures(value.epoch));
  if (!Array.isArray(value.entries)) {
    failures.push("invalid-capability-entries");
  } else {
    const seenIds = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      failures.push(...capabilityEntryRuntimeFailures(entry, index));
      if (isRecord(entry) && isNonEmptyIdentity(entry.id)) {
        if (seenIds.has(entry.id)) {
          const failure = `duplicate-capability-id:${entry.id}`;
          if (!failures.includes(failure)) failures.push(failure);
        }
        seenIds.add(entry.id);
      }
    }
  }
  return failures;
}

function requestRuntimeFailures(value: unknown): ReadonlyArray<string> {
  if (!isRecord(value)) return ["invalid-capability-selection-request"];
  const failures: Array<string> = [];
  if (!isProviderInstanceId(value.providerInstanceId)) failures.push("invalid-provider-instance");
  failures.push(...activeScopeRuntimeFailures(value.activeScope, "invalid-active-scope"));
  if (
    typeof value.nativeToolSearch !== "string" ||
    !providerCapabilitySupportValues.has(value.nativeToolSearch)
  )
    failures.push("invalid-native-tool-search");
  failures.push(...stringArrayFailures(value.taskKeywords, "invalid-task-keyword"));
  failures.push(...stringArrayFailures(value.explicitSelections, "invalid-explicit-selection"));
  let hasInvalidSelectionLimit = false;
  if (!isBoundedLimit(value.maxOptionalTaskSpecific, MAX_OPTIONAL_TASK_SPECIFIC)) {
    failures.push("invalid-max-optional-task-specific");
    hasInvalidSelectionLimit = true;
  }
  if (!isBoundedLimit(value.maxTotalSelected, MAX_TOTAL_SELECTED)) {
    failures.push("invalid-max-total-selected");
    hasInvalidSelectionLimit = true;
  }
  if (!isBoundedLimit(value.maxEssential, MAX_ESSENTIAL)) {
    failures.push("invalid-max-essential");
    hasInvalidSelectionLimit = true;
  }
  if (hasInvalidSelectionLimit) failures.push("invalid-selection-limit");
  return failures;
}

function catalogIntegrityFailures(
  entries: ReadonlyArray<CapabilityCatalogEntry>,
): ReadonlyArray<string> {
  const failures: Array<string> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      const failure = `duplicate-capability-id:${entry.id}`;
      if (!failures.includes(failure)) failures.push(failure);
    }
    seen.add(entry.id);
    if (
      !isNonEmptyIdentity(entry.source.referenceId) ||
      !isNonEmptyIdentity(entry.source.componentId) ||
      ((entry.source.kind === "plugin-package" ||
        entry.source.kind === "skill-package" ||
        entry.source.kind === "agents-skills-directory") &&
        !isNonEmptyIdentity(entry.source.packageId))
    ) {
      failures.push(`invalid-source-identity:${entry.id}`);
    }
    for (const scope of ["mode", "project", "host", "model"] as const) {
      if (!isValidScopeIdentity(entry.scopeEligibility[scope])) {
        failures.push(`invalid-scope-identity:${entry.id}:${scope}`);
      }
    }
    if (!allowedComponentsBySource[entry.source.kind].has(entry.componentKind)) {
      failures.push(`invalid-source-component:${entry.id}`);
    }
  }
  return failures.sort(compareCodePoints);
}

function isNonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidScopeIdentity(identity: CapabilityScopeIdentity): boolean {
  return (
    isNonEmptyIdentity(identity.referenceId) &&
    Number.isSafeInteger(identity.revision) &&
    identity.revision >= 0
  );
}

function activeScopeIntegrityFailures(scope: CapabilityActiveScope): ReadonlyArray<string> {
  const failures: Array<string> = [];
  for (const kind of ["mode", "project", "host", "model"] as const) {
    if (!isValidScopeIdentity(scope[kind])) failures.push(`invalid-active-scope:${kind}`);
  }
  return failures;
}

function activeFactsMatch(left: CatalogActiveFacts, right: CatalogActiveFacts): boolean {
  if (left.providerInstanceId !== right.providerInstanceId) return false;
  for (const scope of ["mode", "project", "host", "model"] as const) {
    if (
      left.activeScope[scope].referenceId !== right.activeScope[scope].referenceId ||
      left.activeScope[scope].revision !== right.activeScope[scope].revision
    ) {
      return false;
    }
  }
  return true;
}

function isBoundedLimit(value: unknown, maximum: number): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum)
  );
}

const fallbackActiveScope: CapabilityActiveScope = {
  mode: { referenceId: "invalid-mode", revision: 0 },
  project: { referenceId: "invalid-project", revision: 0 },
  host: { referenceId: "invalid-host", revision: 0 },
  model: { referenceId: "invalid-model", revision: 0 },
};
const fallbackCatalogEpoch: CatalogEpoch = {
  value: 1,
  fingerprint: `sha256:${createHash("sha256").update("invalid-catalog").digest("hex")}`,
  activeFacts: {
    providerInstanceId: "00000000-0000-4000-8000-000000000000" as ProviderInstanceId,
    activeScope: fallbackActiveScope,
  },
  facts: [],
};

function blockedSelection(
  catalog: unknown,
  request: unknown,
  reasons: ReadonlyArray<string>,
): CapabilitySelection {
  const entries =
    isRecord(catalog) && Array.isArray(catalog.entries)
      ? catalog.entries.filter(isRecord).map((entry, index) => ({
          id: isNonEmptyIdentity(entry.id) ? entry.id : `invalid-entry-${index}`,
          reason: "selection-blocked",
        }))
      : [];
  const nativeToolSearch =
    isRecord(request) &&
    typeof request.nativeToolSearch === "string" &&
    providerCapabilitySupportValues.has(request.nativeToolSearch)
      ? (request.nativeToolSearch as ProviderCapabilitySupport)
      : "unavailable";
  const epoch =
    isRecord(catalog) && catalogEpochRuntimeFailures(catalog.epoch).length === 0
      ? (catalog.epoch as unknown as CatalogEpoch)
      : fallbackCatalogEpoch;
  return {
    status: "blocked",
    blockedReasons: reasons,
    selected: [],
    loadedSchemaIds: [],
    omitted: entries,
    totalCost: { kind: "known", tokens: 0, accuracy: "exact-tokenizer" },
    nativeToolSearch,
    selectionStrategy: nativeToolSearch === "supported" ? "native-search" : "task-specific-bundle",
    explicitlySelectedIds: [],
    epoch,
  };
}

function combineCapabilitySchemaCost(
  entries: ReadonlyArray<CapabilityCatalogEntry>,
): TokenMeasurement | undefined {
  if (entries.length === 0) {
    return { kind: "known", tokens: 0, accuracy: "exact-tokenizer" };
  }
  if (entries.some((entry) => entry.schemaCost.kind === "unknown")) {
    return { kind: "unknown", accuracy: "unknown" };
  }
  let tokens = 0;
  let worstAccuracy: KnownTokenMeasurement["accuracy"] = "provider-reported";
  for (const entry of entries) {
    if (entry.schemaCost.kind === "known") {
      if (entry.schemaCost.tokens > Number.MAX_SAFE_INTEGER - tokens) return undefined;
      tokens += entry.schemaCost.tokens;
      if (accuracyRank[entry.schemaCost.accuracy] > accuracyRank[worstAccuracy]) {
        worstAccuracy = entry.schemaCost.accuracy;
      }
    }
  }
  return { kind: "known", tokens, accuracy: worstAccuracy };
}

export function selectCapabilities(
  catalog: CapabilityCatalog,
  request: CapabilitySelectionRequest,
): CapabilitySelection {
  const runtimeFailures = [...requestRuntimeFailures(request), ...catalogRuntimeFailures(catalog)];
  if (runtimeFailures.length > 0) {
    return blockedSelection(catalog, request, runtimeFailures);
  }
  const activeScopeFailures = activeScopeIntegrityFailures(request.activeScope);
  if (activeScopeFailures.length > 0) {
    return blockedSelection(catalog, request, activeScopeFailures);
  }
  const integrityFailures = catalogIntegrityFailures(catalog.entries);
  if (integrityFailures.length > 0) {
    return blockedSelection(catalog, request, integrityFailures);
  }
  const activeFacts: CatalogActiveFacts = {
    providerInstanceId: request.providerInstanceId,
    activeScope: request.activeScope,
  };
  if (
    !activeFactsMatch(catalog.epoch.activeFacts, activeFacts) ||
    catalog.epoch.fingerprint !== catalogFingerprint(catalog.entries, activeFacts)
  ) {
    return blockedSelection(catalog, request, ["stale-catalog-epoch"]);
  }
  if (
    !isBoundedLimit(request.maxOptionalTaskSpecific, MAX_OPTIONAL_TASK_SPECIFIC) ||
    !isBoundedLimit(request.maxTotalSelected, MAX_TOTAL_SELECTED) ||
    !isBoundedLimit(request.maxEssential, MAX_ESSENTIAL)
  ) {
    return blockedSelection(catalog, request, ["invalid-selection-limit"]);
  }

  const explicitSet = new Set(request.explicitSelections);
  const selected: Array<CapabilityCatalogEntry> = [];
  const omitted: Array<{ readonly id: string; readonly reason: string }> = [];
  const essentialCandidates: Array<CapabilityCatalogEntry> = [];
  const optionalCandidates: Array<CapabilityCatalogEntry> = [];

  for (const entry of catalog.entries) {
    const failure = eligibilityFailureReason(entry, request);
    if (failure !== undefined) {
      omitted.push({ id: entry.id, reason: failure });
      continue;
    }
    if (requiresExplicitSelection(entry) && !explicitSet.has(entry.id)) {
      omitted.push({ id: entry.id, reason: "explicit-selection-required" });
      continue;
    }
    if (entry.posture === "essential") {
      essentialCandidates.push(entry);
      continue;
    }
    optionalCandidates.push(entry);
  }

  const useNativeSearch = request.nativeToolSearch === "supported";
  const maxTotal = request.maxTotalSelected ?? DEFAULT_MAX_TOTAL_SELECTED;
  const maxEssential = Math.min(request.maxEssential ?? DEFAULT_MAX_ESSENTIAL, maxTotal);

  essentialCandidates.sort(compareEntryOrder);
  if (essentialCandidates.length > maxEssential) {
    return blockedSelection(catalog, request, ["essential-bundle-overflow"]);
  }
  const explicitOptionalCount = optionalCandidates.filter((entry) =>
    explicitSet.has(entry.id),
  ).length;
  if (essentialCandidates.length + explicitOptionalCount > maxTotal) {
    return blockedSelection(catalog, request, ["explicit-selection-overflow"]);
  }
  for (const entry of essentialCandidates) {
    if (selected.length >= maxEssential) {
      omitted.push({ id: entry.id, reason: "essential-limit-reached" });
      continue;
    }
    selected.push(entry);
  }

  const scored = optionalCandidates.map((entry) => ({
    entry,
    score: scoreTaskRelevance(entry, request.taskKeywords),
    explicit: explicitSet.has(entry.id),
  }));
  scored.sort((left, right) => {
    if (left.explicit !== right.explicit) return left.explicit ? -1 : 1;
    if (left.score !== right.score) return right.score - left.score;
    return compareEntryOrder(left.entry, right.entry);
  });

  let nonExplicitOptionalSelected = 0;
  const optionalLimit = request.maxOptionalTaskSpecific ?? DEFAULT_MAX_OPTIONAL_TASK_SPECIFIC;

  for (const candidate of scored) {
    if (selected.length >= maxTotal) {
      omitted.push({ id: candidate.entry.id, reason: "total-limit-reached" });
      continue;
    }
    if (candidate.explicit) {
      selected.push(candidate.entry);
      continue;
    }
    if (useNativeSearch && isNativeSearchableTool(candidate.entry)) {
      omitted.push({ id: candidate.entry.id, reason: "native-search-deferred" });
      continue;
    }
    if (candidate.score === 0) {
      omitted.push({ id: candidate.entry.id, reason: "no-task-relevance" });
      continue;
    }
    if (nonExplicitOptionalSelected >= optionalLimit) {
      omitted.push({ id: candidate.entry.id, reason: "optional-limit-reached" });
      continue;
    }
    nonExplicitOptionalSelected++;
    selected.push(candidate.entry);
  }

  selected.sort(compareEntryOrder);

  const selectedIds = new Set(selected.map((entry) => entry.id));
  const explicitlySelectedIds = request.explicitSelections.filter((id) => selectedIds.has(id));
  const totalCost = combineCapabilitySchemaCost(selected);
  if (totalCost === undefined) {
    return blockedSelection(catalog, request, ["schema-cost-overflow"]);
  }

  return {
    status: "selected",
    blockedReasons: [],
    selected,
    loadedSchemaIds: selected.map((entry) => entry.id),
    omitted,
    totalCost,
    nativeToolSearch: request.nativeToolSearch,
    selectionStrategy: useNativeSearch ? "native-search" : "task-specific-bundle",
    explicitlySelectedIds,
    epoch: catalog.epoch,
  };
}

function isNativeSearchableTool(entry: CapabilityCatalogEntry): boolean {
  return entry.componentKind === "octant-tool" || entry.componentKind === "mcp-tool";
}

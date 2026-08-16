import type {
  ContextEntry,
  ContextEntryCategory,
  ContextHealth,
  ServiceLimitBucket,
  TokenMeasurement,
} from "@octant/contracts/context";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";

export type ContextFocus =
  | { readonly kind: "thread" }
  | { readonly kind: "pane"; readonly label: string };

export interface ContextStatusModel {
  readonly attentionLabel?: string;
  readonly headroomLabel: string;
  readonly health: ContextHealth;
  readonly healthLabel: string;
  readonly scopeLabel: string;
  readonly toolsLabel: string;
  readonly usageLabel: string;
}

export interface ContextCompositionEntry extends ContextEntry {
  readonly manifestState: ContextEntry["state"];
  readonly plannedState: ContextEntry["state"];
  readonly plannedTokens: TokenMeasurement;
  readonly planReason: ContextInspectorSnapshot["next"]["plan"]["entries"][number]["reason"];
}

const healthLabels: Readonly<Record<ContextHealth, string>> = {
  healthy: "Healthy",
  watch: "Watch",
  optimizing: "Optimizing",
  "action-needed": "Action needed",
  blocked: "Blocked",
  "rate-limited": "Rate limited",
};

const categoryLabels: Readonly<Record<ContextEntryCategory, string>> = {
  "provider-framing": "Provider framing",
  "octant-policy": "Octant policy",
  "user-instructions": "User instructions",
  "project-instructions": "Project instructions",
  "project-memory": "Project memory",
  conversation: "Conversation",
  "current-request": "Current request",
  "workspace-context": "Workspace context",
  "extension-instructions": "Extension instructions",
  "octant-tools": "Octant tools",
  mcp: "MCP",
  "tool-results": "Tool results",
  "subagent-results": "Subagent results",
  reserves: "Reserves",
};

export function contextStatusModel(
  snapshot: ContextInspectorSnapshot,
  focus: ContextFocus,
): ContextStatusModel {
  const plan = snapshot.next.plan;
  const hasUnknown = plan.entries.some((entry) => entry.tokens.kind === "unknown");
  const hasEstimate = plan.entries.some(
    (entry) =>
      entry.tokens.kind === "known" &&
      entry.tokens.accuracy !== "provider-reported" &&
      entry.tokens.accuracy !== "exact-tokenizer",
  );
  const qualifier = hasUnknown ? " + unknown" : hasEstimate ? " estimated" : "";
  const healthLabel = healthLabels[plan.health];
  return {
    scopeLabel:
      focus.kind === "thread"
        ? `${snapshot.displayLabel} · ${snapshot.modelLimits.modelId}`
        : focus.label,
    usageLabel: `Context ${compact(plan.plannedInputTokens)}/${compact(snapshot.modelLimits.contextWindow)}${qualifier}`,
    headroomLabel: `Headroom ${compact(Math.max(0, plan.safeInputBudget - plan.plannedInputTokens))}`,
    toolsLabel: `Tools ${snapshot.capabilities.loadedTools}/${snapshot.capabilities.availableTools}`,
    health: plan.health,
    healthLabel,
    ...(focus.kind === "pane" && plan.health !== "healthy"
      ? { attentionLabel: `${snapshot.displayLabel}: ${healthLabel}` }
      : {}),
  };
}

export function contextHealthLabel(health: ContextHealth): string {
  return healthLabels[health];
}

export function contextCategoryLabel(category: ContextEntryCategory): string {
  return categoryLabels[category];
}

export function tokenMeasurementLabel(measurement: TokenMeasurement): string {
  if (measurement.kind === "unknown") return "Unknown";
  const accuracy = {
    "provider-reported": "Provider reported",
    "exact-tokenizer": "Exact tokenizer",
    "model-family-estimate": "Model-family estimate",
    "conservative-heuristic": "Conservative estimate",
  }[measurement.accuracy];
  return `${compact(measurement.tokens)} · ${accuracy}`;
}

export function serviceLimitLabel(bucket: ServiceLimitBucket): string {
  return bucket.status === "unavailable"
    ? "Unavailable"
    : `${compact(bucket.remaining)} of ${compact(bucket.limit)} remaining`;
}

export function contextEntryControls(
  entry: ContextEntry,
  snapshot: ContextInspectorSnapshot,
): {
  readonly canExclude: boolean;
  readonly canPin: boolean;
  readonly excluded: boolean;
  readonly pinned: boolean;
} {
  const overrides = snapshot.next.manifest.overrides;
  const pinned = overrides.pinnedEntryIds.includes(entry.id);
  const excluded = overrides.excludedEntryIds.includes(entry.id);
  const protectedEntry =
    entry.category === "current-request" ||
    entry.posture === "required" ||
    entry.posture === "reserved" ||
    pinned;
  return {
    pinned,
    excluded,
    canPin: entry.eligibility.status === "eligible" && entry.state !== "omitted" && !excluded,
    canExclude: !protectedEntry && !excluded,
  };
}

export function contextCompositionEntries(
  snapshot: ContextInspectorSnapshot,
  planSnapshot: ContextInspectorSnapshot["next"] = snapshot.next,
): ReadonlyArray<ContextCompositionEntry> {
  const plannedById = new Map(planSnapshot.plan.entries.map((entry) => [entry.entryId, entry]));
  return planSnapshot.manifest.entries.map((entry) => {
    const planned = plannedById.get(entry.id);
    if (planned === undefined) {
      throw new Error("Context plan is missing a validated manifest entry.");
    }
    return {
      ...entry,
      manifestState: entry.state,
      plannedState: planned.state,
      plannedTokens: planned.tokens,
      planReason: planned.reason,
    };
  });
}

function compact(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(value >= 100_000 ? 0 : 1))}K`;
  return `${Number((value / 1_000_000).toFixed(1))}M`;
}

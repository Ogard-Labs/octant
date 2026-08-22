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

export interface ContextWindowSegment {
  readonly key: string;
  readonly kind: "content" | "overhead" | "reserved" | "free";
  readonly label: string;
  readonly percent: number;
  readonly tokens?: number;
  readonly tone: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

export type ContextWindowUsedSource = "provider-reported" | "estimated" | "unknown" | "measured";

export interface ContextWindowModel {
  readonly capabilities: ReadonlyArray<{
    readonly key: "tools" | "mcp";
    readonly label: string;
    readonly loaded: number;
    readonly deferred: number;
  }>;
  readonly hasUnknown: boolean;
  readonly percent: number;
  readonly segments: ReadonlyArray<ContextWindowSegment>;
  readonly sourceLabel: "Last sent" | "Next turn";
  readonly totalTokens: number;
  readonly usageLabel: string;
  readonly usedSource: ContextWindowUsedSource;
  readonly usedTokens: number;
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

/**
 * The compact window uses the last provider-reconciled turn when one exists.
 * Before the first turn it shows the next server-evaluated plan instead. The
 * visible categories are the same attributed manifest entries the full
 * inspector manages, never a second estimate assembled in the renderer.
 */
export function contextWindowModel(snapshot: ContextInspectorSnapshot): ContextWindowModel {
  const planSnapshot = snapshot.latestSent ?? snapshot.next;
  const sourceLabel = snapshot.latestSent === undefined ? "Next turn" : "Last sent";
  const usedTokens =
    snapshot.latestSent === undefined || snapshot.latestUsage === undefined
      ? planSnapshot.plan.plannedInputTokens
      : snapshot.latestUsage.actualInputTokens;
  const totalTokens = snapshot.modelLimits.contextWindow;
  const byCategory = new Map<
    ContextEntryCategory,
    { readonly key: string; readonly label: string; tokens: number; unknown: boolean }
  >();

  for (const entry of contextCompositionEntries(snapshot, planSnapshot)) {
    if (entry.plannedState === "omitted") continue;
    const retained = byCategory.get(entry.category) ?? {
      key: entry.category,
      label: contextCategoryLabel(entry.category),
      tokens: 0,
      unknown: false,
    };
    if (entry.plannedTokens.kind === "unknown") retained.unknown = true;
    else retained.tokens += entry.plannedTokens.tokens;
    byCategory.set(entry.category, retained);
  }

  const content = [...byCategory.values()];
  const knownContentTokens = content.reduce((sum, entry) => sum + entry.tokens, 0);
  const hasUnknown = content.some((entry) => entry.unknown);
  const hasEstimate = planSnapshot.plan.entries.some(
    (entry) =>
      entry.tokens.kind === "known" &&
      entry.tokens.accuracy !== "provider-reported" &&
      entry.tokens.accuracy !== "exact-tokenizer",
  );
  const usedSource: ContextWindowUsedSource =
    snapshot.latestSent !== undefined && snapshot.latestUsage !== undefined
      ? "provider-reported"
      : hasUnknown
        ? "unknown"
        : hasEstimate
          ? "estimated"
          : "measured";
  const overheadTokens = hasUnknown ? 0 : Math.max(0, usedTokens - knownContentTokens);
  const reservedTokens = Object.values(planSnapshot.plan.reserves).reduce(
    (sum, tokens) => sum + tokens,
    0,
  );
  const freeTokens = Math.max(0, totalTokens - usedTokens - reservedTokens);
  const segments: Array<ContextWindowSegment> = content.map((entry, index) => ({
    key: entry.key,
    kind: "content",
    label: entry.label,
    percent: percentOf(entry.tokens, totalTokens),
    ...(entry.unknown ? {} : { tokens: entry.tokens }),
    tone: toneAt(index),
  }));
  if (overheadTokens > 0) {
    segments.push({
      key: "observed-overhead",
      kind: "overhead",
      label: "Observed overhead",
      percent: percentOf(overheadTokens, totalTokens),
      tokens: overheadTokens,
      tone: 6,
    });
  }
  segments.push(
    {
      key: "reserved",
      kind: "reserved",
      label: "Reserved",
      percent: percentOf(reservedTokens, totalTokens),
      tokens: reservedTokens,
      tone: 7,
    },
    {
      key: "free",
      kind: "free",
      label: "Free space",
      percent: percentOf(freeTokens, totalTokens),
      tokens: freeTokens,
      tone: 8,
    },
  );

  return {
    sourceLabel,
    usedTokens,
    totalTokens,
    percent: percentOf(usedTokens, totalTokens),
    usageLabel: `${compact(usedTokens)} / ${compact(totalTokens)}`,
    usedSource,
    hasUnknown,
    segments,
    capabilities: [
      {
        key: "tools",
        label: "Tools",
        loaded: snapshot.capabilities.loadedTools,
        deferred: snapshot.capabilities.availableTools - snapshot.capabilities.loadedTools,
      },
      {
        key: "mcp",
        label: "MCP",
        loaded: snapshot.capabilities.loadedMcp,
        deferred: snapshot.capabilities.availableMcp - snapshot.capabilities.loadedMcp,
      },
    ],
  };
}

export function contextWindowUsedSourceLabel(source: ContextWindowUsedSource): string {
  return {
    "provider-reported": "Provider reported",
    estimated: "Estimated",
    unknown: "Unknown",
    measured: "Measured",
  }[source];
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

function percentOf(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 1000) / 10));
}

function toneAt(index: number): ContextWindowSegment["tone"] {
  return ((index % 6) + 1) as ContextWindowSegment["tone"];
}

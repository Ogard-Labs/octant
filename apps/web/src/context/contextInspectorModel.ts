import type {
  ContextEntry,
  ContextEntryCategory,
  ContextHealth,
  ModelContextLimits,
  ServiceLimitBucket,
  TokenMeasurement,
} from "@octant/contracts/context";
import type {
  ProviderContextBreakdown,
  ProviderContextPart,
  ProviderContextPartKind,
} from "@octant/contracts";
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

/**
 * A categorical hue for a context category: 1–7 are the seven palette hues, and
 * 8–14 are the same hues one step toward the ink, so fourteen categories can
 * stand in one bar. A segment with no tone (Free space, Reserved) is neutral.
 */
export type ContextTone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export type ContextSegmentAccuracy = ProviderContextPart["accuracy"];

export interface ContextWindowSegment {
  /** How exact the figure is, where the source said. Absent for free space. */
  readonly accuracy?: ContextSegmentAccuracy;
  readonly estimated?: boolean;
  readonly key: string;
  readonly kind: "content" | "overhead" | "reserved" | "free";
  readonly label: string;
  readonly percent: number;
  readonly tokens?: number;
  /** Absent only for free space and reserved room, which stay neutral. */
  readonly tone?: ContextTone;
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
      : (snapshot.latestUsage.contextTokens ?? snapshot.latestUsage.actualInputTokens);
  const totalTokens =
    (snapshot.latestSent === undefined ? undefined : snapshot.latestUsage?.contextWindow) ??
    snapshot.modelLimits.contextWindow;
  const byCategory = new Map<
    ContextEntryCategory,
    {
      estimated: boolean;
      readonly key: string;
      readonly label: string;
      tokens: number;
      unknown: boolean;
    }
  >();

  for (const entry of contextCompositionEntries(snapshot, planSnapshot)) {
    if (entry.plannedState === "omitted") continue;
    const retained = byCategory.get(entry.category) ?? {
      estimated: false,
      key: entry.category,
      label: contextCategoryLabel(entry.category),
      tokens: 0,
      unknown: false,
    };
    if (entry.plannedTokens.kind === "unknown") retained.unknown = true;
    else {
      retained.tokens += entry.plannedTokens.tokens;
      if (
        entry.plannedTokens.accuracy === "model-family-estimate" ||
        entry.plannedTokens.accuracy === "conservative-heuristic"
      ) {
        retained.estimated = true;
      }
    }
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
        : snapshot.latestSent !== undefined
          ? "estimated"
          : hasEstimate
            ? "estimated"
            : "measured";
  const overheadTokens = hasUnknown ? 0 : Math.max(0, usedTokens - knownContentTokens);
  const reservedTokens = Object.values(planSnapshot.plan.reserves).reduce(
    (sum, tokens) => sum + tokens,
    0,
  );
  // Unknown entries mean the remaining capacity cannot be proven. Keep the
  // segment visible for orientation, but omit its number rather than showing
  // a fabricated free-space total.
  const freeTokens = hasUnknown
    ? undefined
    : Math.max(0, totalTokens - usedTokens - reservedTokens);
  const segments: Array<ContextWindowSegment> = content.map((entry) => {
    const tone = contextCategoryTone(entry.key);
    return {
      key: entry.key,
      kind: "content",
      label: entry.label,
      percent: percentOf(entry.tokens, totalTokens),
      ...(entry.unknown ? {} : { tokens: entry.tokens }),
      ...(entry.estimated && !entry.unknown ? { estimated: true } : {}),
      ...(tone === undefined ? {} : { tone }),
    };
  });
  if (overheadTokens > 0) {
    segments.push({
      key: "observed-overhead",
      kind: "overhead",
      label: "Observed overhead",
      percent: percentOf(overheadTokens, totalTokens),
      tokens: overheadTokens,
      tone: UNATTRIBUTED_TONE,
    });
  }
  segments.push(
    {
      key: "reserved",
      kind: "reserved",
      label: "Reserved",
      percent: percentOf(reservedTokens, totalTokens),
      tokens: reservedTokens,
    },
    {
      key: "free",
      kind: "free",
      label: "Free space",
      percent: freeTokens === undefined ? 0 : percentOf(freeTokens, totalTokens),
      ...(freeTokens === undefined ? {} : { tokens: freeTokens }),
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
  return `${compact(measurement.tokens)} · ${contextAccuracyLabel(measurement.accuracy)}`;
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

/**
 * One hue per category, the same in the popover's bar and key and on the
 * inspector's entries, whichever thread it is on. Categories that are the same
 * kind of thing share a family (conversation and current request are blues,
 * the tool results and subagent results are oranges), and a darker step
 * separates two members of a family that can stand in one bar. Seven hues in
 * two steps hold the fourteen categories of a planned thread without any two of
 * them sharing a tone; a provider-run window uses a subset of the same table.
 * Free space and reserved room have no tone: they are the window's own space,
 * not something that fills it.
 */
const UNATTRIBUTED_TONE: ContextTone = 6;

const CATEGORY_TONES: Readonly<Record<string, ContextTone>> = {
  // What was said.
  conversation: 1,
  "current-request": 8,
  messages: 1,
  used: 1,
  // What came back.
  "tool-results": 2,
  "subagent-results": 9,
  agents: 9,
  // What the project remembers.
  "project-memory": 3,
  "memory-files": 3,
  "workspace-context": 10,
  // Tool definitions.
  "octant-tools": 4,
  "system-tools": 4,
  mcp: 5,
  "mcp-tools": 5,
  // Instructions.
  "provider-framing": 7,
  "system-prompt": 7,
  "octant-policy": 14,
  "user-instructions": 11,
  "project-instructions": 13,
  "extension-instructions": 12,
  skills: 12,
  // What no category accounts for. Pink is kept for it alone among the
  // first-step hues, so the remainder never reads as a neighbouring tool part.
  "observed-overhead": UNATTRIBUTED_TONE,
  "other-provider": UNATTRIBUTED_TONE,
};

export function contextCategoryTone(key: string): ContextTone | undefined {
  return CATEGORY_TONES[key];
}

const partLabels: Readonly<Record<ProviderContextPartKind, string>> = {
  "system-prompt": "System prompt",
  "system-tools": "System tools",
  "octant-tools": "Octant tools",
  "mcp-tools": "MCP tools",
  "memory-files": "Memory files",
  skills: "Skills",
  agents: "Agents",
  messages: "Messages",
  reserved: "Reserved",
};

export interface ProviderWindowCount {
  readonly key: "tools" | "mcp" | "memory-files" | "skills" | "agents";
  readonly label: string;
  readonly loaded?: number;
  /** Known to the runtime but not loaded: no share of the window. */
  readonly deferred?: { readonly count?: number };
}

export interface ProviderWindowModel {
  /** The counts the runtime or Octant knows; a count nobody has is not a row. */
  readonly counts: ReadonlyArray<ProviderWindowCount>;
  /** The estimated accuracies in play, so the popover can name them. */
  readonly estimatedAccuracies: ReadonlyArray<
    Exclude<ContextSegmentAccuracy, "provider-reported" | "exact-tokenizer">
  >;
  readonly segments: ReadonlyArray<ContextWindowSegment>;
  /** What the window holds. Never less than the parts that were counted in it. */
  readonly usedTokens: number;
}

/**
 * The window of a thread a provider runtime runs, as the parts that fill it.
 *
 * The runtime reports one occupancy figure, and possibly the parts of it; Octant
 * may add parts it counted itself, marked with how exact they are. Whatever the
 * occupancy holds beyond the parts is "Other (provider)", so the parts and that
 * remainder always add up to what the window holds. When the parts outrun the
 * occupancy (the breakdown was taken after the reply, the occupancy before it)
 * the window holds what the parts add up to, and nothing is shown as negative.
 * With no parts the window is a single "Used" segment, as before. Reserved room
 * comes only from a runtime that reported it; free space is what is left.
 */
export function providerWindowModel(input: {
  readonly breakdown?: ProviderContextBreakdown | undefined;
  readonly usedTokens: number;
  readonly windowTokens: number;
}): ProviderWindowModel {
  const { breakdown, windowTokens } = input;
  // Each share is rounded once, when it is shown. Rounding here as well made
  // 85.5% and 14.5% read as 86% and 15%: a window a point over full.
  const share = (tokens: number) =>
    windowTokens <= 0 ? 0 : Math.max(0, Math.min(100, (tokens / windowTokens) * 100));
  const parts = (breakdown?.parts ?? []).filter((part) => part.kind !== "reserved");
  const reservedTokens = (breakdown?.parts ?? [])
    .filter((part) => part.kind === "reserved")
    .reduce((sum, part) => sum + part.tokens, 0);
  const partsTokens = parts.reduce((sum, part) => sum + part.tokens, 0);
  const usedTokens = Math.max(input.usedTokens, partsTokens);
  const remainderTokens = usedTokens - partsTokens;
  const estimatedAccuracies = [
    ...new Set(
      parts.flatMap((part) =>
        part.accuracy === "provider-reported" || part.accuracy === "exact-tokenizer"
          ? []
          : [part.accuracy],
      ),
    ),
  ];
  const estimated = estimatedAccuracies.length > 0;

  const segments: Array<ContextWindowSegment> = [];
  if (parts.length === 0) {
    segments.push({
      key: "used",
      kind: "content",
      label: "Used",
      percent: share(usedTokens),
      tokens: usedTokens,
      tone: 1,
    });
  } else {
    for (const part of parts) {
      const tone = contextCategoryTone(part.kind);
      segments.push({
        key: part.kind,
        kind: "content",
        label: partLabels[part.kind],
        percent: share(part.tokens),
        tokens: part.tokens,
        accuracy: part.accuracy,
        ...(part.accuracy === "provider-reported" || part.accuracy === "exact-tokenizer"
          ? {}
          : { estimated: true }),
        ...(tone === undefined ? {} : { tone }),
      });
    }
    if (remainderTokens > 0) {
      segments.push({
        key: "other-provider",
        kind: "overhead",
        label: "Other (provider)",
        percent: share(remainderTokens),
        tokens: remainderTokens,
        // What remains of a reported figure after an estimate is itself
        // inexact, so it never reads as the provider's own count.
        ...(estimated ? { estimated: true } : { accuracy: "provider-reported" as const }),
        tone: UNATTRIBUTED_TONE,
      });
    }
  }
  if (reservedTokens > 0) {
    segments.push({
      key: "reserved",
      kind: "reserved",
      label: "Reserved",
      percent: share(reservedTokens),
      tokens: reservedTokens,
      accuracy: "provider-reported",
    });
  }
  const freeTokens = Math.max(0, windowTokens - usedTokens - reservedTokens);
  segments.push({
    key: "free",
    kind: "free",
    label: "Free space",
    percent: share(freeTokens),
    tokens: freeTokens,
  });

  const loaded = (...kinds: ReadonlyArray<ProviderContextPartKind>) => {
    const counted = parts.filter((part) => kinds.includes(part.kind) && part.count !== undefined);
    return counted.length === 0
      ? undefined
      : counted.reduce((sum, part) => sum + (part.count ?? 0), 0);
  };
  const deferred = (kind: "system-tools" | "mcp-tools") =>
    breakdown?.deferred?.find((entry) => entry.kind === kind);
  const counts: Array<ProviderWindowCount> = [];
  const countRow = (
    key: ProviderWindowCount["key"],
    label: string,
    loadedCount: number | undefined,
    deferredEntry?: NonNullable<ProviderContextBreakdown["deferred"]>[number],
  ) => {
    if (loadedCount === undefined && deferredEntry === undefined) return;
    counts.push({
      key,
      label,
      ...(loadedCount === undefined ? {} : { loaded: loadedCount }),
      // A group the runtime named as deferred without saying how many still
      // says that it exists, with no share of the window.
      ...(deferredEntry === undefined
        ? {}
        : {
            deferred: deferredEntry.count === undefined ? {} : { count: deferredEntry.count },
          }),
    });
  };
  countRow("tools", "Tools", loaded("system-tools", "octant-tools"), deferred("system-tools"));
  countRow("mcp", "MCP", loaded("mcp-tools"), deferred("mcp-tools"));
  countRow("memory-files", "Memory files", loaded("memory-files"));
  countRow("skills", "Skills", loaded("skills"));
  countRow("agents", "Agents", loaded("agents"));

  return { counts, estimatedAccuracies, segments, usedTokens };
}

export function contextAccuracyLabel(accuracy: ContextSegmentAccuracy): string {
  return {
    "provider-reported": "Provider reported",
    "exact-tokenizer": "Exact tokenizer",
    "model-family-estimate": "Model-family estimate",
    "conservative-heuristic": "Conservative estimate",
  }[accuracy];
}

/**
 * How much room is left before the runtime compacts the session by itself.
 *
 * Only a runtime that compacts automatically has such a point, and only one
 * that reported where it is can say how far off it stands. A kind that is
 * manual, absent, or unknown, a threshold nobody reported, or an occupancy the
 * provider did not measure gives nothing, so the popover shows no line rather
 * than a figure it had to guess. Room never goes negative: a session at or past
 * the threshold has none left.
 */
export function autoCompactRoom(input: {
  readonly compaction: ModelContextLimits["compaction"];
  readonly thresholdTokens?: number | undefined;
  readonly usedTokens?: number | undefined;
}): { readonly tokens: number } | undefined {
  if (input.compaction !== "automatic") return undefined;
  const { thresholdTokens, usedTokens } = input;
  if (thresholdTokens === undefined || usedTokens === undefined) return undefined;
  if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return undefined;
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return undefined;
  return { tokens: Math.max(0, thresholdTokens - usedTokens) };
}

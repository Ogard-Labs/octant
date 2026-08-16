import type {
  ContextEntry,
  ContextEntryId,
  ContextHealth,
  ContextManifest,
  ContextMetadataSource,
  ContextRemedy,
  ContextReserveBreakdown,
  ContextTurnOverrides,
  ModelContextLimits,
} from "@octant/contracts";

export type ContextPolicyRejectionCode =
  | "empty-limit-observations"
  | "mismatched-limit-observations"
  | "unsafe-arithmetic"
  | "unknown-entry"
  | "contradictory-override"
  | "protected-entry"
  | "invalid-health-input";

export class ContextPolicyRejected extends Error {
  readonly code: ContextPolicyRejectionCode;

  constructor(code: ContextPolicyRejectionCode, message: string) {
    super(message);
    this.name = "ContextPolicyRejected";
    this.code = code;
  }
}

function reject(code: ContextPolicyRejectionCode, message: string): never {
  throw new ContextPolicyRejected(code, message);
}

function checkedNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    return reject("unsafe-arithmetic", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function unique<T>(values: ReadonlyArray<T>): ReadonlyArray<T> {
  return [...new Set(values)];
}

function asNonEmpty<T>(values: ReadonlyArray<T>): readonly [T, ...T[]] {
  if (values.length === 0) {
    return reject("empty-limit-observations", "Expected a non-empty limit observation set.");
  }
  return values as readonly [T, ...T[]];
}

const confidenceOrder = ["unknown", "low", "medium", "high"] as const;

export function resolveEffectiveModelLimits(
  observations: ReadonlyArray<ModelContextLimits>,
): ModelContextLimits {
  const orderedObservations = observations.toSorted((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  const first = orderedObservations[0];
  if (first === undefined) {
    return reject("empty-limit-observations", "At least one model-limit observation is required.");
  }
  if (
    orderedObservations.some(
      (observation) =>
        observation.providerInstanceId !== first.providerInstanceId ||
        observation.modelId !== first.modelId,
    )
  ) {
    return reject(
      "mismatched-limit-observations",
      "Model-limit observations must describe one provider instance and model.",
    );
  }

  const contextWindow = Math.min(
    ...orderedObservations.map((observation) => observation.contextWindow),
  );
  const maxOutput = Math.min(...orderedObservations.map((observation) => observation.maxOutput));
  const selected =
    orderedObservations.find((observation) => observation.contextWindow === contextWindow) ?? first;
  const contextValues = unique(
    orderedObservations.map((observation) => observation.contextWindow),
  ).toSorted((left, right) => left - right);
  const outputValues = unique(
    orderedObservations.map((observation) => observation.maxOutput),
  ).toSorted((left, right) => left - right);
  const sources = unique(
    orderedObservations.map((observation) => observation.source),
  ).toSorted() as ReadonlyArray<ContextMetadataSource>;
  const conflicts = orderedObservations.flatMap((observation) => observation.conflicts);
  if (contextValues.length > 1) {
    conflicts.push({
      field: "contextWindow",
      values: asNonEmpty(contextValues),
      sources: asNonEmpty(sources),
    });
  }
  if (outputValues.length > 1) {
    conflicts.push({
      field: "maxOutput",
      values: asNonEmpty(outputValues),
      sources: asNonEmpty(sources),
    });
  }

  const confidence = orderedObservations.reduce<ModelContextLimits["confidence"]>(
    (current, observation) =>
      confidenceOrder.indexOf(observation.confidence) < confidenceOrder.indexOf(current)
        ? observation.confidence
        : current,
    "high",
  );
  const availableExtendedContext = orderedObservations.flatMap((observation) =>
    observation.extendedContext.kind === "available" ? [observation.extendedContext] : [],
  );
  const sharedExtendedModes =
    availableExtendedContext.length === orderedObservations.length
      ? (
          availableExtendedContext[0]?.modes.filter((mode) =>
            availableExtendedContext.every((context) => context.modes.includes(mode)),
          ) ?? []
        ).toSorted()
      : [];
  const sharedActiveMode = availableExtendedContext[0]?.activeMode;
  const extendedContext: ModelContextLimits["extendedContext"] =
    sharedExtendedModes.length === 0
      ? { kind: "unavailable" }
      : {
          kind: "available",
          modes: asNonEmpty(sharedExtendedModes),
          ...(sharedActiveMode !== undefined &&
          availableExtendedContext.every((context) => context.activeMode === sharedActiveMode)
            ? { activeMode: sharedActiveMode }
            : {}),
        };
  const tokenizerRank = { exact: 0, "family-estimate": 1, heuristic: 2, unavailable: 3 } as const;
  const tokenizer = orderedObservations.reduce<ModelContextLimits["tokenizer"]>(
    (current, observation) =>
      tokenizerRank[observation.tokenizer.kind] > tokenizerRank[current.kind]
        ? observation.tokenizer
        : current,
    selected.tokenizer,
  );

  return {
    ...selected,
    contextWindow,
    maxOutput,
    extendedContext,
    reasoning: orderedObservations.every(
      (observation) => observation.reasoning === selected.reasoning,
    )
      ? selected.reasoning
      : "unknown",
    compaction: orderedObservations.every(
      (observation) => observation.compaction === selected.compaction,
    )
      ? selected.compaction
      : "unknown",
    tokenizer,
    confidence,
    conflicts,
  };
}

export interface SafeInputBudgetResult {
  readonly safeInputBudget: number;
  readonly blocked: boolean;
}

export function calculateSafeInputBudget(
  limits: ModelContextLimits,
  reserves: ContextReserveBreakdown,
): SafeInputBudgetResult {
  const contextWindow = checkedNonNegativeInteger(limits.contextWindow, "Context window");
  if (reserves.response > limits.maxOutput) {
    reject("unsafe-arithmetic", "Response reserve cannot exceed the model maximum output.");
  }
  const reserveValues = [
    reserves.response,
    reserves.reasoning,
    reserves.framing,
    reserves.variance,
    reserves.safety,
  ].map((value, index) => checkedNonNegativeInteger(value, `Reserve ${index + 1}`));
  const totalReserve = reserveValues.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next)) {
      return reject("unsafe-arithmetic", "Combined reserves exceed safe integer arithmetic.");
    }
    return next;
  }, 0);
  const remaining = contextWindow - totalReserve;
  return {
    safeInputBudget: Math.max(0, remaining),
    blocked: remaining < 0,
  };
}

function entryIdSet(ids: ReadonlyArray<ContextEntryId>): ReadonlySet<string> {
  return new Set(ids as ReadonlyArray<string>);
}

function isProtectedEntry(entry: ContextEntry, pinned: ReadonlySet<string>): boolean {
  return (
    entry.category === "current-request" ||
    entry.posture === "required" ||
    entry.posture === "reserved" ||
    pinned.has(entry.id)
  );
}

export function applyContextOverrides(
  manifest: ContextManifest,
  overrides: ContextTurnOverrides,
): ContextManifest {
  const knownIds = entryIdSet(manifest.entries.map((entry) => entry.id));
  const pinned = entryIdSet(overrides.pinnedEntryIds);
  const excluded = entryIdSet(overrides.excludedEntryIds);
  for (const entryId of [...pinned, ...excluded]) {
    if (!knownIds.has(entryId)) {
      reject("unknown-entry", `Context override references unknown entry ${entryId}.`);
    }
  }
  for (const entryId of pinned) {
    if (excluded.has(entryId)) {
      reject("contradictory-override", `Context entry ${entryId} cannot be pinned and excluded.`);
    }
  }

  for (const entry of manifest.entries) {
    if (excluded.has(entry.id) && isProtectedEntry(entry, pinned)) {
      reject("protected-entry", `Protected context entry ${entry.id} cannot be excluded.`);
    }
  }
  return { ...manifest, overrides: { ...overrides } };
}

export type ContextReductionReason =
  | "duplicate"
  | "unknown-optional-size"
  | "superseded"
  | "stale"
  | "removable"
  | "replaceable"
  | "compressible";

export interface ReducedContextEntry {
  readonly entryId: ContextEntryId;
  readonly reason: ContextReductionReason;
}

export interface ContextReductionResult {
  readonly includedEntryIds: ReadonlyArray<ContextEntryId>;
  readonly reduced: ReadonlyArray<ReducedContextEntry>;
  readonly plannedInputTokens: number;
  readonly blocked: boolean;
  readonly remedies: ReadonlyArray<ContextRemedy>;
}

function blockedRemedies(): ReadonlyArray<ContextRemedy> {
  return [{ kind: "unpin-context" }, { kind: "reduce-output-reserve" }, { kind: "switch-model" }];
}

interface ReductionCandidate {
  readonly entry: ContextEntry;
  readonly index: number;
  readonly rank: number;
  readonly reason: ContextReductionReason;
}

function reductionRank(
  entry: ContextEntry,
  duplicate: boolean,
): Pick<ReductionCandidate, "rank" | "reason"> | undefined {
  if (duplicate) return { rank: 0, reason: "duplicate" };
  if (entry.tokens.kind === "unknown") return { rank: 1, reason: "unknown-optional-size" };
  if (entry.retention === "superseded") return { rank: 2, reason: "superseded" };
  if (entry.retention === "stale") return { rank: 3, reason: "stale" };
  switch (entry.posture) {
    case "removable":
      return { rank: 4, reason: "removable" };
    case "replaceable":
      return { rank: 5, reason: "replaceable" };
    case "compressible":
      return { rank: 6, reason: "compressible" };
    case "required":
    case "reserved":
      return undefined;
  }
}

export function reduceContextToBudget(
  manifest: ContextManifest,
  safeInputBudget: number,
): ContextReductionResult {
  checkedNonNegativeInteger(safeInputBudget, "Safe input budget");
  const pinned = entryIdSet(manifest.overrides.pinnedEntryIds);
  const excluded = entryIdSet(manifest.overrides.excludedEntryIds);
  const ineligiblePinned = manifest.entries.some(
    (entry) =>
      pinned.has(entry.id) &&
      (entry.state === "omitted" || entry.eligibility.status === "ineligible"),
  );
  const included = manifest.entries.filter(
    (entry) => entry.state !== "omitted" && !excluded.has(entry.id),
  );
  const sourceGroups = new Map<string, Array<ContextEntry>>();
  for (const entry of included) {
    const sourceKey = JSON.stringify([entry.source.kind, entry.source.referenceId]);
    const group = sourceGroups.get(sourceKey) ?? [];
    group.push(entry);
    sourceGroups.set(sourceKey, group);
  }
  const sourceKeepers = new Map<string, ContextEntryId>();
  for (const [sourceKey, group] of sourceGroups) {
    const protectedEntry = group.find((entry) => isProtectedEntry(entry, pinned));
    const keeper = protectedEntry ?? group[0];
    if (keeper !== undefined) sourceKeepers.set(sourceKey, keeper.id);
  }
  const candidates: Array<ReductionCandidate> = [];
  let plannedInputTokens = 0;
  let unknownProtected = false;

  included.forEach((entry, index) => {
    const protectedEntry = isProtectedEntry(entry, pinned);
    if (entry.tokens.kind === "known") {
      const next = plannedInputTokens + entry.tokens.tokens;
      if (!Number.isSafeInteger(next)) {
        reject("unsafe-arithmetic", "Planned context exceeds safe integer arithmetic.");
      }
      plannedInputTokens = next;
    } else if (protectedEntry) {
      unknownProtected = true;
    }

    const sourceKey = JSON.stringify([entry.source.kind, entry.source.referenceId]);
    const duplicate = sourceKeepers.get(sourceKey) !== entry.id;
    if (!protectedEntry) {
      const reduction = reductionRank(entry, duplicate);
      if (reduction !== undefined) candidates.push({ entry, index, ...reduction });
    }
  });

  candidates.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.entry.priority - right.entry.priority ||
      left.index - right.index,
  );
  const reduced: Array<ReducedContextEntry> = [];
  const removedIds = new Set<string>();
  for (const candidate of candidates) {
    const alwaysReduce =
      candidate.reason === "duplicate" || candidate.reason === "unknown-optional-size";
    if (!alwaysReduce && plannedInputTokens <= safeInputBudget) break;
    removedIds.add(candidate.entry.id);
    reduced.push({ entryId: candidate.entry.id, reason: candidate.reason });
    if (candidate.entry.tokens.kind === "known") {
      plannedInputTokens -= candidate.entry.tokens.tokens;
    }
  }

  const blocked = ineligiblePinned || unknownProtected || plannedInputTokens > safeInputBudget;
  return {
    includedEntryIds: included
      .filter((entry) => !removedIds.has(entry.id))
      .map((entry) => entry.id),
    reduced,
    plannedInputTokens,
    blocked,
    remedies: blocked ? blockedRemedies() : [],
  };
}

export interface ContextHealthInput {
  readonly safeInputBudget: number;
  readonly plannedInputTokens: number;
  readonly watchHeadroomTokens: number;
  readonly blocked: boolean;
  readonly actionNeeded: boolean;
  readonly optimizing: boolean;
  readonly rateLimited: boolean;
}

export function evaluateContextHealth(input: ContextHealthInput): ContextHealth {
  checkedNonNegativeInteger(input.safeInputBudget, "Safe input budget");
  checkedNonNegativeInteger(input.plannedInputTokens, "Planned input");
  checkedNonNegativeInteger(input.watchHeadroomTokens, "Watch headroom");
  if (input.blocked || input.plannedInputTokens > input.safeInputBudget) return "blocked";
  if (input.rateLimited) return "rate-limited";
  if (input.actionNeeded) return "action-needed";
  if (input.optimizing) return "optimizing";
  return input.safeInputBudget - input.plannedInputTokens <= input.watchHeadroomTokens
    ? "watch"
    : "healthy";
}

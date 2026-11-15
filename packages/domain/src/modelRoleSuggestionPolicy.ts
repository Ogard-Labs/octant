/**
 * Suggested models for the roles a person sees on the Model roles page.
 *
 * A pure function of what is connected: nothing here reads a provider, saves a
 * role or invents a price. The shipped table below says which model families
 * are strong, middle and fast; everything else comes from facts the catalog
 * already reports (reads images, tools proven, signed in, usage limit). A
 * suggestion is a proposal for the person to preview; Octant never applies one
 * by itself.
 */

export type ModelTier = "top" | "mid" | "fast";

/** What the suggestion needs to know about one connected model. */
export interface RoleSuggestionModel {
  readonly providerInstanceId: string;
  /** The driver family ("claude-code", "openai-compatible", ...): "a different provider" means a different one. */
  readonly providerKind: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly readsImages: boolean;
  /** Whether the model carries the tools a worker needs (proven, not merely claimed). */
  readonly toolsReady: boolean;
  /** Signed in and ready. A model that is not is never a main choice. */
  readonly ready: boolean;
  readonly atUsageLimit: boolean;
  /** The reasoning levels the model offers, for the hint a pick may carry. */
  readonly reasoningLevels?: ReadonlyArray<string>;
}

/**
 * The shipped table: which family is which tier, matched against a model's id
 * or name. Data only; update it each release. An entry with `preferFor` ranks
 * ahead of its tier-mates for those roles (Fable plans; Opus does hard work).
 * Names the table does not know are placed after the ones it does, and the
 * reason says "tier unknown".
 */
export interface ModelFamilyRule {
  readonly family: string;
  readonly pattern: RegExp;
  readonly tier: ModelTier;
  readonly preferFor?: ReadonlyArray<string>;
  /** Without the list's own wording, a tier word read from the name alone. */
  readonly nameOnly?: true;
}

export const MODEL_FAMILY_RULES: ReadonlyArray<ModelFamilyRule> = [
  { family: "Fable", pattern: /fable/, tier: "top", preferFor: ["plan"] },
  { family: "Opus", pattern: /opus/, tier: "top" },
  { family: "Sonnet", pattern: /sonnet/, tier: "mid" },
  { family: "Haiku", pattern: /haiku/, tier: "fast" },
  // Other providers publish no tier of their own; the names that say one do.
  {
    family: "its name",
    pattern: /(^|[^a-z])(mini|nano|flash|lite|small)([^a-z]|$)/,
    tier: "fast",
    nameOnly: true,
  },
  {
    family: "its name",
    pattern: /(^|[^a-z])(pro|max|ultra)([^a-z]|$)/,
    tier: "top",
    nameOnly: true,
  },
];

export interface ModelRoleNeed {
  readonly roleId: string;
  readonly tier: ModelTier;
  readonly needsTools: boolean;
  readonly needsImages: boolean;
  /** Why the tier fits, in the words a preview line ends with. */
  readonly why: string;
}

export const MODEL_ROLE_NEEDS: ReadonlyArray<ModelRoleNeed> = [
  { roleId: "plan", tier: "top", needsTools: true, needsImages: false, why: "planning" },
  { roleId: "task", tier: "fast", needsTools: true, needsImages: false, why: "quick reads" },
  { roleId: "quick", tier: "fast", needsTools: true, needsImages: false, why: "small edits" },
  { roleId: "default", tier: "mid", needsTools: true, needsImages: false, why: "ordinary builds" },
  { roleId: "deep", tier: "top", needsTools: true, needsImages: false, why: "hard problems" },
  { roleId: "slow", tier: "mid", needsTools: true, needsImages: false, why: "reviewing" },
  { roleId: "vision", tier: "fast", needsTools: false, needsImages: true, why: "reading images" },
  { roleId: "smol", tier: "fast", needsTools: false, needsImages: false, why: "small jobs" },
];

const REASONING_HINT: Readonly<Record<string, string>> = {
  plan: "high",
  deep: "high",
  default: "medium",
  slow: "medium",
  quick: "low",
  task: "low",
  vision: "low",
  smol: "low",
};

export interface RoleSuggestionPick {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly providerLabel: string;
  readonly kind: "main" | "fallback";
  /** One line: why this model, for this role. A preview reads "Role → name (provider) — reason". */
  readonly reason: string;
  /** A reasoning level to set when the row was empty and the model offers it. */
  readonly reasoning?: string;
}

export interface RoleSuggestion {
  readonly roleId: string;
  /** Main first, then fallbacks. Empty when no connected model fits. */
  readonly picks: ReadonlyArray<RoleSuggestionPick>;
  /** Said when the role stays empty or has no fallback. */
  readonly note?: string;
}

export interface SuggestModelRolesInput {
  readonly models: ReadonlyArray<RoleSuggestionModel>;
  /** The roles to suggest for; absent means every role. */
  readonly roleIds?: ReadonlyArray<string>;
  /** The Builder's main model as saved; the Reviewer is chosen against it, not against a fresh suggestion. */
  readonly builderMain?: { readonly providerKind: string };
}

interface Classified {
  readonly model: RoleSuggestionModel;
  readonly tier: ModelTier | undefined;
  readonly rule: ModelFamilyRule | undefined;
  readonly version: ReadonlyArray<number>;
}

const TIER_ORDER: Readonly<Record<ModelTier, number>> = { top: 0, mid: 1, fast: 2 };
const TIER_WORD: Readonly<Record<ModelTier, string>> = {
  top: "top-tier",
  mid: "mid-tier",
  fast: "fast",
};

function classify(model: RoleSuggestionModel): Classified {
  const text = `${model.modelId} ${model.displayName}`.toLowerCase();
  // Named families win over the generic name hints, whatever order they sit in.
  const rule =
    MODEL_FAMILY_RULES.find((entry) => entry.nameOnly !== true && entry.pattern.test(text)) ??
    MODEL_FAMILY_RULES.find((entry) => entry.pattern.test(text));
  const version = (model.displayName.match(/\d+/g) ?? []).map(Number);
  return { model, tier: rule?.tier, rule, version };
}

function newerFirst(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** How far a model's tier is from the one the role wants; unknown tiers sort last. */
function distance(entry: Classified, wanted: ModelTier): number {
  return entry.tier === undefined ? 99 : Math.abs(TIER_ORDER[entry.tier] - TIER_ORDER[wanted]);
}

function rank(entry: Classified, need: ModelRoleNeed): ReadonlyArray<number> {
  const preferred = entry.rule?.preferFor?.includes(need.roleId) === true;
  // Among models of the same distance, a role that wants a stronger model
  // takes the stronger side; a Fable that is not preferred sorts behind Opus.
  const side =
    entry.tier === undefined ? 0 : TIER_ORDER[entry.tier] <= TIER_ORDER[need.tier] ? 0 : 1;
  const notPreferred = entry.rule?.preferFor !== undefined && !preferred ? 1 : 0;
  return [distance(entry, need.tier), preferred ? 0 : 1, notPreferred, side];
}

function compare(need: ModelRoleNeed) {
  return (a: Classified, b: Classified): number => {
    const left = rank(a, need);
    const right = rank(b, need);
    for (let index = 0; index < left.length; index += 1) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return newerFirst(a.version, b.version);
  };
}

function reasonFor(entry: Classified, need: ModelRoleNeed): string {
  if (entry.tier === undefined) {
    return "tier unknown, so it sits after the models Octant can place";
  }
  const read = entry.rule?.nameOnly === true ? ", tier read from its name" : "";
  if (entry.rule?.preferFor?.includes(need.roleId) === true) {
    return `your strongest connected model for ${need.why}`;
  }
  if (entry.tier === need.tier) {
    return `a ${TIER_WORD[entry.tier]} model, the right size for ${need.why}${read}`;
  }
  return `the closest tier you have connected for ${need.why} (${TIER_WORD[entry.tier]})${read}`;
}

function key(model: RoleSuggestionModel): string {
  return `${model.providerInstanceId}:${model.modelId}`;
}

/**
 * Per-role main and fallback suggestions from what is connected.
 *
 * A model that fails a fact the role needs is never suggested. A signed-out or
 * at-limit model is never a main choice (and is left out entirely, since a
 * fallback that cannot answer is no backup). Fallbacks prefer another provider,
 * then another account, then a sibling model, so one outage does not stop the
 * role.
 */
export function suggestModelRoles(input: SuggestModelRolesInput): ReadonlyArray<RoleSuggestion> {
  const wanted = new Set(input.roleIds ?? MODEL_ROLE_NEEDS.map((need) => need.roleId));
  const mains = new Map<string, Classified>();
  const out: RoleSuggestion[] = [];
  // The Builder goes first: the Reviewer is chosen against it.
  const ordered = [...MODEL_ROLE_NEEDS].sort(
    (a, b) => Number(b.roleId === "default") - Number(a.roleId === "default"),
  );
  for (const need of ordered) {
    const answers = input.models
      .filter(
        (model) =>
          model.ready &&
          !model.atUsageLimit &&
          (!need.needsTools || model.toolsReady) &&
          (!need.needsImages || model.readsImages),
      )
      .map(classify)
      .sort(compare(need));
    const { suggestion, main } = suggest(need, answers, mains, input);
    if (main !== undefined) mains.set(need.roleId, main);
    if (wanted.has(need.roleId)) out.push(suggestion);
  }
  const order = MODEL_ROLE_NEEDS.map((need) => need.roleId);
  return out.sort((a, b) => order.indexOf(a.roleId) - order.indexOf(b.roleId));
}

function suggest(
  need: ModelRoleNeed,
  answers: ReadonlyArray<Classified>,
  mains: ReadonlyMap<string, Classified>,
  input: SuggestModelRolesInput,
): { readonly suggestion: RoleSuggestion; readonly main?: Classified } {
  if (answers.length === 0) {
    const missing = need.needsImages
      ? "No connected model says it reads images."
      : need.needsTools
        ? "No connected model has its tools proven for this role."
        : "No connected model is signed in and under its usage limit.";
    return { suggestion: { roleId: need.roleId, picks: [], note: missing } };
  }
  let pool = answers;
  let reviewerNote: string | undefined;
  if (need.roleId === "slow") {
    const builderKind = input.builderMain?.providerKind ?? mains.get("default")?.model.providerKind;
    const elsewhere =
      builderKind === undefined
        ? []
        : answers.filter((entry) => entry.model.providerKind !== builderKind);
    if (elsewhere.length > 0) {
      pool = elsewhere;
      reviewerNote = "from a different provider than the Builder";
    }
  }
  const [main] = pool;
  if (main === undefined)
    return { suggestion: { roleId: need.roleId, picks: [], note: "No connected model fits." } };
  const hint = REASONING_HINT[need.roleId];
  const reasoning =
    hint !== undefined && main.model.reasoningLevels?.includes(hint) === true ? hint : undefined;
  const picks: RoleSuggestionPick[] = [
    {
      providerInstanceId: main.model.providerInstanceId,
      modelId: main.model.modelId,
      displayName: main.model.displayName,
      providerLabel: main.model.providerLabel,
      kind: "main",
      reason:
        reviewerNote === undefined
          ? reasonFor(main, need)
          : `${reasonFor(main, need)}, ${reviewerNote}`,
      ...(reasoning === undefined ? {} : { reasoning }),
    },
  ];
  const others = answers.filter((entry) => key(entry.model) !== key(main.model));
  const fallback =
    others.find((entry) => entry.model.providerKind !== main.model.providerKind) ??
    others.find((entry) => entry.model.providerInstanceId !== main.model.providerInstanceId) ??
    others[0];
  if (fallback === undefined) {
    return {
      suggestion: {
        roleId: need.roleId,
        picks,
        note: "No fallback: only one connected model fits.",
      },
      main,
    };
  }
  const why =
    fallback.model.providerKind !== main.model.providerKind
      ? "a different provider, so one outage does not stop the role"
      : fallback.model.providerInstanceId !== main.model.providerInstanceId
        ? "a different account of the same provider"
        : "a sibling model on the same account";
  picks.push({
    providerInstanceId: fallback.model.providerInstanceId,
    modelId: fallback.model.modelId,
    displayName: fallback.model.displayName,
    providerLabel: fallback.model.providerLabel,
    kind: "fallback",
    reason: why,
  });
  return { suggestion: { roleId: need.roleId, picks }, main };
}

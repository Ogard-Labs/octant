import type { ContextMetadataSource } from "@octant/contracts";

/**
 * What Octant knows about one model's context window, from the model's
 * catalogue entry. Every field is optional: an endpoint that lists a
 * deployment by name says nothing about its window until a person, the
 * provider, a refusal or a response says something.
 */
export interface ModelContextWindowFacts {
  readonly id: string;
  /** The window the provider's own model metadata reported. */
  readonly contextLimit?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  /** The window a person typed into the model's details. */
  readonly contextWindowOverride?: number | undefined;
  /** The window the endpoint's own refusal or a larger successful request taught Octant. */
  readonly learnedContextWindow?: number | undefined;
  /** The `model` the endpoint named in its responses, which may differ from a deployment's name. */
  readonly servedModelId?: string | undefined;
}

/** Where a known window came from. The planner's emergency estimate is never one of these. */
export type ModelContextWindowSource = Exclude<
  ContextMetadataSource,
  "conservative-fallback" | "runtime-reported"
>;

export interface ResolvedModelContextWindow {
  readonly contextWindow: number;
  readonly maxOutput?: number;
  readonly source: ModelContextWindowSource;
}

/**
 * One family in the built-in profile catalogue. The catalogue ships with the
 * app and is never fetched: a profile only fills a window nothing more direct
 * named, and each entry cites the published page its figures were read from.
 */
export interface ModelContextProfile {
  /** Normalized names (see `normalizeModelName`) this profile describes. */
  readonly names: ReadonlyArray<string>;
  readonly contextWindow: number;
  readonly maxOutput?: number;
  readonly reference: string;
}

const ANTHROPIC_MODELS = "https://docs.anthropic.com/en/docs/about-claude/models/overview";
const OPENAI_MODELS = "https://platform.openai.com/docs/models";
const GEMINI_MODELS = "https://ai.google.dev/gemini-api/docs/models";

/**
 * Families whose windows their providers publish. Kept small on purpose: an
 * entry that is wrong is worse than none, because it is believed until the
 * endpoint refuses a request. A family missing here is learned from its first
 * refusal instead.
 */
export const MODEL_CONTEXT_PROFILES: ReadonlyArray<ModelContextProfile> = [
  {
    names: ["claude-opus-4-5"],
    contextWindow: 200_000,
    maxOutput: 64_000,
    reference: ANTHROPIC_MODELS,
  },
  {
    names: ["claude-opus-4-1", "claude-opus-4", "claude-opus-4-0"],
    contextWindow: 200_000,
    maxOutput: 32_000,
    reference: ANTHROPIC_MODELS,
  },
  {
    names: [
      "claude-sonnet-4-5",
      "claude-sonnet-4",
      "claude-sonnet-4-0",
      "claude-haiku-4-5",
      "claude-3-7-sonnet",
    ],
    contextWindow: 200_000,
    maxOutput: 64_000,
    reference: ANTHROPIC_MODELS,
  },
  {
    names: ["claude-3-5-haiku"],
    contextWindow: 200_000,
    maxOutput: 8_192,
    reference: ANTHROPIC_MODELS,
  },
  {
    names: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
    contextWindow: 400_000,
    maxOutput: 128_000,
    reference: OPENAI_MODELS,
  },
  {
    names: ["gpt-4-1", "gpt-4-1-mini", "gpt-4-1-nano"],
    contextWindow: 1_047_576,
    maxOutput: 32_768,
    reference: OPENAI_MODELS,
  },
  {
    names: ["gpt-4o", "gpt-4o-mini"],
    contextWindow: 128_000,
    maxOutput: 16_384,
    reference: OPENAI_MODELS,
  },
  {
    names: ["o3", "o3-mini", "o4-mini"],
    contextWindow: 200_000,
    maxOutput: 100_000,
    reference: OPENAI_MODELS,
  },
  {
    names: ["gemini-2-5-pro", "gemini-2-5-flash"],
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    reference: GEMINI_MODELS,
  },
  {
    names: ["deepseek-v4-1-flash"],
    contextWindow: 1_000_000,
    // The window the maintainer's own Azure AI Foundry deployment of this
    // model states; no first-party page lists it yet.
    reference: "Azure AI Foundry model catalog: DeepSeek-V4.1-Flash",
  },
];

const profilesByName = new Map(
  MODEL_CONTEXT_PROFILES.flatMap((profile) => profile.names.map((name) => [name, profile])),
);

/**
 * The name a model is matched by. Providers spell one model many ways —
 * `DeepSeek-V4.1-Flash`, `deepseek_v4.1_flash`, `anthropic/claude-sonnet-4.5`,
 * `gpt-4.1-2025-04-14`, `llama3:latest` — so case, separators, a routing
 * prefix, a tag after `:`, a release date and `-latest` are not part of it.
 * A version (`v4`, `4.1`) is, because a different version is a different model.
 */
export function normalizeModelName(name: string): string {
  let value = name.trim().toLowerCase();
  value = value.slice(value.lastIndexOf("/") + 1);
  const tag = value.indexOf(":");
  if (tag !== -1) value = value.slice(0, tag);
  value = value
    .replace(/[\s._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  value = value.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "").replace(/-latest$/, "");
  return value;
}

/** The built-in profile for a model name, or undefined when the catalogue has none. */
export function findModelContextProfile(name: string): ModelContextProfile | undefined {
  return profilesByName.get(normalizeModelName(name));
}

/**
 * The model's window from the most direct source that names one: what a
 * person set, then what the provider reported, then what its refusals taught,
 * then the built-in profile — matched on the model's id and, for a deployment
 * with a name of its own, on the model the endpoint said it served. A learned
 * window below the reported one wins too, since the endpoint itself refused
 * above it. Undefined means nothing named it, and the caller plans with its
 * labelled estimate.
 */
export function resolveModelContextWindow(
  model: ModelContextWindowFacts,
): ResolvedModelContextWindow | undefined {
  const profile =
    findModelContextProfile(model.id) ??
    (model.servedModelId === undefined ? undefined : findModelContextProfile(model.servedModelId));
  const maxOutput = model.maxOutputTokens ?? profile?.maxOutput;
  const resolved = (contextWindow: number, source: ModelContextWindowSource) => ({
    contextWindow,
    ...(maxOutput !== undefined && maxOutput <= contextWindow ? { maxOutput } : {}),
    source,
  });
  if (model.contextWindowOverride !== undefined) {
    return resolved(model.contextWindowOverride, "user-supplied");
  }
  const learned = model.learnedContextWindow;
  if (
    model.contextLimit !== undefined &&
    (learned === undefined || learned >= model.contextLimit)
  ) {
    return resolved(model.contextLimit, "provider-discovery");
  }
  if (learned !== undefined) return resolved(learned, "observed-evidence");
  if (profile !== undefined) return resolved(profile.contextWindow, "reviewed-catalog");
  return undefined;
}

/** What one request showed about the window: a refusal naming it, or a request that fit. */
export type ContextWindowObservation =
  | { readonly kind: "refused"; readonly contextWindow: number }
  | { readonly kind: "completed"; readonly usedTokens: number };

/**
 * The learned window after one more observation. A refusal names the limit
 * the endpoint enforces, so it lowers what was stored. A request that
 * completed with more tokens than the stored window proves the window is at
 * least that large, so it raises it. A completed request alone never starts
 * a learned value: fitting says nothing about where the window ends.
 */
export function learnContextWindow(
  stored: number | undefined,
  observation: ContextWindowObservation,
): number | undefined {
  if (observation.kind === "refused") {
    return stored === undefined
      ? observation.contextWindow
      : Math.min(stored, observation.contextWindow);
  }
  if (stored === undefined) return undefined;
  return Math.max(stored, observation.usedTokens);
}

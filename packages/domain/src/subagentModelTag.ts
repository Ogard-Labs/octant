import type { ProviderModel } from "@octant/contracts";

/**
 * A prompt's request that a subagent run on one exact route: a configured
 * provider instance, one of its models, and optionally a reasoning value that
 * model advertises. The prompt carries it as plain text,
 * `@model(<provider instance id>/<model id>, reasoning=<value>)`, so copying
 * a prompt keeps the route and pasting it back restores the chip. Omitting
 * reasoning means the provider's own default.
 */
export interface SubagentModelTag {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly reasoning?: string;
}

/** One tag found in a prompt, with the half-open range of its text. */
export interface SubagentModelTagMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly tag: SubagentModelTag;
}

// A provider instance id never holds a slash; a model id may (routers name
// models `vendor/model`), so the first slash splits them. Neither may hold
// whitespace, a comma, or a parenthesis, which the tag itself uses. A tag
// glued to a preceding word (`name@model(...)`) is an address, not a tag.
const TAG = /(?<![\w@.])@model\(([^\s/(),]+)\/([^\s(),]+)(?:,[ ]?reasoning=([A-Za-z0-9._-]+))?\)/g;

/** Every well-formed `@model(...)` tag in `text`, in order. */
export function findSubagentModelTags(text: string): ReadonlyArray<SubagentModelTagMatch> {
  const matches: Array<SubagentModelTagMatch> = [];
  for (const match of text.matchAll(TAG)) {
    const [whole, providerInstanceId, modelId, reasoning] = match;
    if (providerInstanceId === undefined || modelId === undefined) continue;
    const start = match.index;
    matches.push({
      start,
      end: start + whole.length,
      text: whole,
      tag: {
        providerInstanceId,
        modelId,
        ...(reasoning === undefined ? {} : { reasoning }),
      },
    });
  }
  return matches;
}

/** The plain-text form of a tag, the one copy writes and paste reads. */
export function formatSubagentModelTag(tag: SubagentModelTag): string {
  const reasoning = tag.reasoning === undefined ? "" : `, reasoning=${tag.reasoning}`;
  return `@model(${tag.providerInstanceId}/${tag.modelId}${reasoning})`;
}

/**
 * The reasoning values a model advertises for a subagent route: its
 * `reasoning` or `effort` selection option. The launch accepts only these, so
 * the picker offers only these, beside the provider's default.
 */
export function subagentReasoningValues(
  model: Pick<ProviderModel, "options">,
): ReadonlyArray<string> {
  return model.options.flatMap((option) =>
    option.kind === "selection" && (option.id === "reasoning" || option.id === "effort")
      ? option.values
      : [],
  );
}

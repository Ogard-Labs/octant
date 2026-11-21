import type { ProviderModelOption } from "@octant/contracts";

/**
 * Whether an option names how hard the model should think. The picker keeps
 * that one on a segmented level control beside the other declared settings.
 */
export function isComposerReasoningOption(option: {
  readonly id: string;
  readonly displayName: string;
}): boolean {
  return /(reasoning|effort|thinking|thought)/i.test(`${option.id} ${option.displayName}`);
}

/**
 * Finds the declared selection reasoning option on a model when it supports
 * the requested level; returns undefined when absent or retired.
 */
export function findSupportedReasoningOption(
  options: ReadonlyArray<ProviderModelOption>,
  effort: string | undefined,
): { readonly id: string; readonly value: string } | undefined {
  if (effort === undefined) return undefined;
  const option = options.find(
    (entry) => entry.kind === "selection" && isComposerReasoningOption(entry),
  );
  if (option === undefined || option.kind !== "selection" || !option.values.includes(effort)) {
    return undefined;
  }
  return { id: option.id, value: effort };
}

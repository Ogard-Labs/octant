import { keepDeclaredModelOptionValues } from "@octant/client-runtime";
import type { ProviderModelOption, ProviderModelOptionValues } from "@octant/contracts";

/** A value as a person reads it: "high" becomes "High". */
export function modelSettingValueLabel(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * The options the host takes a value for. A boolean option has no value the
 * host accepts, so the phone offers only selections.
 */
export function selectableModelSettings(
  settings: ReadonlyArray<ProviderModelOption> | undefined,
): ReadonlyArray<Extract<ProviderModelOption, { readonly kind: "selection" }>> {
  return (settings ?? []).flatMap((option) => (option.kind === "selection" ? [option] : []));
}

/**
 * The chosen reasoning level, ready to show beside the model's name. It is the
 * one setting a person wants to see without opening the picker; the desktop
 * picks the same option by the same words.
 */
export function chosenReasoningLabel(
  settings: ReadonlyArray<ProviderModelOption> | undefined,
  values: ProviderModelOptionValues,
): string | undefined {
  const option = selectableModelSettings(settings).find((entry) =>
    /(reasoning|effort|thinking|thought)/i.test(`${entry.id} ${entry.displayName}`),
  );
  const value = option === undefined ? undefined : values[option.id];
  return value === undefined ? undefined : modelSettingValueLabel(value);
}

/**
 * The values a Chat send carries, or none. Only a choice the person made on
 * this phone is sent: the thread's values may have changed on another
 * computer since, and sending the phone's copy would quietly undo that. The
 * host replaces the thread's values with what it is sent, so a cleared
 * choice goes as an empty set, not as nothing.
 */
export function chatSettingsToSend(input: {
  readonly settings: ReadonlyArray<ProviderModelOption> | undefined;
  /** What the person chose here; absent until they choose. */
  readonly chosen: ProviderModelOptionValues | undefined;
  readonly thread: ProviderModelOptionValues | undefined;
}): ProviderModelOptionValues | undefined {
  if (input.chosen === undefined) return undefined;
  const chosen = keepDeclaredModelOptionValues(input.settings, input.chosen);
  const thread = keepDeclaredModelOptionValues(input.settings, input.thread);
  const same = (a: ProviderModelOptionValues, b: ProviderModelOptionValues) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([id, value]) => b[id] === value);
  return same(chosen, thread) ? undefined : chosen;
}

/**
 * The model New thread keeps once a computer's list is read. Another computer
 * lists its own models, so a choice its list does not hold falls back to its
 * first, and a new thread never starts on the last computer's model. Nothing
 * changes while no list is read.
 */
export function keptModelChoice(
  chosen: string | undefined,
  options: ReadonlyArray<{ readonly id: string }>,
): string | undefined {
  const first = options[0];
  if (first === undefined) return chosen;
  return chosen !== undefined && options.some((option) => option.id === chosen) ? chosen : first.id;
}

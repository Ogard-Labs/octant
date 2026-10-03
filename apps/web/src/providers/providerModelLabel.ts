import type { PickerGroup } from "@octant/domain";

/**
 * "Provider — Model" as the picker names them, falling back to the raw ids
 * when the picker has never described the pair. Shared by every transcript
 * header so a turn is attributed the same way in Chat, Work, and Code.
 */
export function providerModelLabel(
  groups: ReadonlyArray<PickerGroup>,
  turn: { readonly providerInstanceId: unknown; readonly modelId: unknown },
): string {
  const group = groups.find(
    (candidate) => String(candidate.instance.id) === String(turn.providerInstanceId),
  );
  const providerLabel = group?.instance.displayName ?? String(turn.providerInstanceId);
  return `${providerLabel} — ${modelDisplayName(groups, turn)}`;
}

/** The model alone, for a divider that must not read as a provider change. */
export function modelDisplayName(
  groups: ReadonlyArray<PickerGroup>,
  turn: { readonly providerInstanceId: unknown; readonly modelId: unknown },
): string {
  const model = groups
    .find((candidate) => String(candidate.instance.id) === String(turn.providerInstanceId))
    ?.sections.flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(turn.modelId));
  return model?.model.displayName ?? String(turn.modelId);
}

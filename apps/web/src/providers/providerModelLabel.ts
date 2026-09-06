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
  const model = group?.sections
    .flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(turn.modelId));
  const providerLabel = group?.instance.displayName ?? String(turn.providerInstanceId);
  const modelLabel = model?.model.displayName ?? String(turn.modelId);
  return `${providerLabel} — ${modelLabel}`;
}

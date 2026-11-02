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

const MODEL_ACRONYMS: ReadonlySet<string> = new Set(["ai", "glm", "gpt", "llm"]);

/**
 * A name to show for a model no catalogue has described, so the composer does
 * not wear a raw identifier ("zai-glm-5-2" reads "Zai GLM 5.2"). An id that
 * already has capitals or spaces is somebody's chosen name and stays as it is.
 * The raw id stays in the picker's own details.
 */
export function readableModelId(id: string): string {
  const name = id.slice(id.lastIndexOf("/") + 1);
  if (name === "" || /[A-Z\s]/.test(name)) return id;
  const words: Array<string> = [];
  for (const part of name.split(/[-_:]+/).filter((word) => word !== "")) {
    const previous = words.at(-1);
    if (/^\d{1,2}$/.test(part) && previous !== undefined && /^\d+(\.\d+)*$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`;
    } else if (MODEL_ACRONYMS.has(part)) {
      words.push(part.toUpperCase());
    } else {
      words.push(`${part.charAt(0).toUpperCase()}${part.slice(1)}`);
    }
  }
  return words.join(" ");
}

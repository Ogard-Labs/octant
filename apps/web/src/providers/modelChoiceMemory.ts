import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderModelOptionValues,
} from "@octant/contracts";
import { findPickerModel, type ModelPickerSelection, type PickerGroup } from "@octant/domain";
import { modelFavoriteKey } from "./modelFavorites";

const STORAGE_KEY = "octant.models.last-choice.v1";
export const MODEL_CHOICE_CHANGED = "octant:model-choice-changed";

function readMemory(): {
  selection?: ModelPickerSelection;
  options: Record<string, ProviderModelOptionValues>;
} {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return { options: {} };
    const options: Record<string, ProviderModelOptionValues> = {};
    if ("options" in raw && typeof raw.options === "object" && raw.options !== null) {
      for (const [key, value] of Object.entries(raw.options)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        options[key] = Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    }
    if (!("providerInstanceId" in raw) || !("modelId" in raw)) return { options };
    return {
      options,
      selection: {
        providerInstanceId: decodeProviderInstanceId(raw.providerInstanceId),
        modelId: decodeProviderModelId(raw.modelId),
      },
    };
  } catch {
    return { options: {} };
  }
}

export function readLastModelChoice(): ModelPickerSelection | undefined {
  return readMemory().selection;
}

/** Preferences never make an unavailable model or an unsupported option selectable. */
export function readRememberedModelOptions(
  groups: ReadonlyArray<PickerGroup>,
  selection: ModelPickerSelection | undefined,
): ProviderModelOptionValues {
  if (selection === undefined) return {};
  const model = findPickerModel(groups, selection);
  if (model === undefined || model.unavailableReason !== undefined) return {};
  const stored =
    readMemory().options[modelFavoriteKey(selection.providerInstanceId, selection.modelId)] ?? {};
  return Object.fromEntries(
    (model.model.options ?? []).flatMap((option) => {
      const value = stored[option.id];
      return option.kind === "selection" && value !== undefined && option.values.includes(value)
        ? [[option.id, value]]
        : [];
    }),
  );
}

export function rememberModelChoice(
  selection: ModelPickerSelection,
  option?: { readonly id: string; readonly value: string | undefined },
): void {
  const memory = readMemory();
  const key = modelFavoriteKey(selection.providerInstanceId, selection.modelId);
  const values = { ...memory.options[key] };
  if (option !== undefined) {
    if (option.value === undefined) delete values[option.id];
    else values[option.id] = option.value;
  }
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...selection,
        options: Object.fromEntries(
          [
            [key, values],
            ...Object.entries(memory.options).filter(([entry]) => entry !== key),
          ].slice(0, 50),
        ),
      }),
    );
    window.dispatchEvent(new Event(MODEL_CHOICE_CHANGED));
  } catch {
    /* A local convenience must not block model selection. */
  }
}

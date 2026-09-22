import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import { modelFavoriteKey } from "./modelFavorites";

const STORAGE_KEY = "octant.models.recent.v1";
const LIMIT = 5;

/** Only explicit picks count; discovery and opening a thread do not reorder this list. */
export function readRecentModels(): ReadonlyArray<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(raw)
      ? [...new Set(raw.filter((entry): entry is string => typeof entry === "string"))].slice(
          0,
          LIMIT,
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberModel(
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
): void {
  const key = modelFavoriteKey(providerInstanceId, modelId);
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([key, ...readRecentModels().filter((entry) => entry !== key)].slice(0, LIMIT)),
    );
  } catch {
    // A convenience preference must not prevent choosing a model when storage is unavailable.
  }
}

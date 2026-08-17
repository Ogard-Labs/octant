import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";

export const MODEL_FAVORITES_STORAGE_KEY = "octant.models.favorites.v1";

export function modelFavoriteKey(
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
): string {
  return `${String(providerInstanceId)}:${String(modelId)}`;
}

export function readModelFavorites(storage: Storage | undefined = defaultStorage()): Set<string> {
  if (storage === undefined) return new Set();
  try {
    const raw = storage.getItem(MODEL_FAVORITES_STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

export function writeModelFavorites(
  favorites: ReadonlySet<string>,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
  } catch {
    // Storage may be full or disabled; favorites are a convenience, not data.
  }
}

export function toggleModelFavorite(favorites: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(favorites);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  MODEL_FAVORITES_STORAGE_KEY,
  modelFavoriteKey,
  readModelFavorites,
  toggleModelFavorite,
  writeModelFavorites,
} from "./modelFavorites";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("modelFavorites", () => {
  it("round-trips favorite keys through storage", () => {
    const storage = memoryStorage();
    const key = modelFavoriteKey(
      decodeProviderInstanceId("80000000-0000-4000-8000-0000000000a1"),
      decodeProviderModelId("model-one"),
    );
    expect(key).toBe("80000000-0000-4000-8000-0000000000a1:model-one");

    const toggled = toggleModelFavorite(readModelFavorites(storage), key);
    writeModelFavorites(toggled, storage);
    expect(readModelFavorites(storage).has(key)).toBe(true);

    writeModelFavorites(toggleModelFavorite(toggled, key), storage);
    expect(readModelFavorites(storage).has(key)).toBe(false);
  });

  it("tolerates malformed stored values", () => {
    expect(
      readModelFavorites(memoryStorage({ [MODEL_FAVORITES_STORAGE_KEY]: "{not json" })).size,
    ).toBe(0);
    expect(
      readModelFavorites(memoryStorage({ [MODEL_FAVORITES_STORAGE_KEY]: '{"a":1}' })).size,
    ).toBe(0);
    expect([
      ...readModelFavorites(memoryStorage({ [MODEL_FAVORITES_STORAGE_KEY]: '["a:b", 3, null]' })),
    ]).toEqual(["a:b"]);
    expect(readModelFavorites(undefined).size).toBe(0);
  });
});

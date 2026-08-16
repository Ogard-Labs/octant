import { describe, expect, it } from "vitest";
import { decodeHostId, LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  CREATE_HOST_LAST_HEALTHY_STORAGE_KEY,
  readLastSelectedHealthyHostId,
  rememberHealthyCreateHost,
  writeLastSelectedHealthyHostId,
} from "./createHostPreference";

const STUDIO = decodeHostId("11111111-1111-4111-8111-111111111111");

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    key() {
      return null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

describe("createHostPreference", () => {
  it("round-trips the last selected healthy host id", () => {
    const storage = memoryStorage();
    writeLastSelectedHealthyHostId(STUDIO, storage);
    expect(storage.getItem(CREATE_HOST_LAST_HEALTHY_STORAGE_KEY)).toBe(String(STUDIO));
    expect(readLastSelectedHealthyHostId(storage)).toBe(STUDIO);
  });

  it("ignores corrupt preference values", () => {
    const storage = memoryStorage({ [CREATE_HOST_LAST_HEALTHY_STORAGE_KEY]: "   " });
    expect(readLastSelectedHealthyHostId(storage)).toBeUndefined();
  });

  it("only remembers healthy hosts", () => {
    const storage = memoryStorage();
    expect(
      rememberHealthyCreateHost(
        {
          hostId: LOCAL_HOST_ID,
          displayName: "This Mac",
          health: "stale",
          capabilities: ["chat"],
        },
        storage,
      ),
    ).toBeUndefined();
    expect(
      rememberHealthyCreateHost(
        {
          hostId: LOCAL_HOST_ID,
          displayName: "This Mac",
          health: "healthy",
          capabilities: ["chat"],
        },
        storage,
      ),
    ).toBe(LOCAL_HOST_ID);
  });
});

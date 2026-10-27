import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExpoSecureStringStorage,
  createThisDeviceKeychainStorage,
  removeLegacyWebDeviceKeyCatalog,
  type KeychainCalls,
} from "./expoSecureStorage";

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  }
});

describe("expoSecureStringStorage", () => {
  it("round-trips values on the active platform backend", async () => {
    const storage = createExpoSecureStringStorage();
    const key = `test-${Date.now()}`;
    await storage.setItem(key, "paired-host");
    expect(await storage.getItem(key)).toBe("paired-host");
    await storage.deleteItem(key);
    expect(await storage.getItem(key)).toBeNull();
  });

  it("keeps web values in session memory instead of localStorage by default", async () => {
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    const storage = createExpoSecureStringStorage();
    await storage.setItem("device-key", "private-key-material");

    expect(await storage.getItem("device-key")).toBe("private-key-material");
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem).not.toHaveBeenCalled();
  });

  it("requires explicit opt-in before web values use localStorage", async () => {
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    const storage = createExpoSecureStringStorage({ persistWeb: true });
    await storage.setItem("host-registry", "non-secret metadata");

    expect(localStorage.setItem).toHaveBeenCalledWith(
      "octant.mobile.host-registry",
      "non-secret metadata",
    );
  });
});

const WHEN_UNLOCKED = 5;
const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

interface KeychainItem {
  readonly value: string;
  readonly accessible: number;
}

/**
 * The iOS Keychain as expo-secure-store reaches it: one item per service and
 * key, written with the accessibility it was given (`WHEN_UNLOCKED` when none
 * is named), and a repeat write keeping the item's first accessibility.
 */
function fakeKeychain(items = new Map<string, KeychainItem>()) {
  const at = (key: string, service: string | undefined) => `${service ?? "app"}/${key}`;
  const calls: KeychainCalls = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    async getItemAsync(key, options) {
      return items.get(at(key, options?.keychainService))?.value ?? null;
    },
    async setItemAsync(key, value, options) {
      const existing = items.get(at(key, options?.keychainService));
      items.set(at(key, options?.keychainService), {
        value,
        accessible: existing?.accessible ?? options?.keychainAccessible ?? WHEN_UNLOCKED,
      });
    },
    async deleteItemAsync(key, options) {
      items.delete(at(key, options?.keychainService));
    },
  };
  return { calls, items };
}

describe("the iOS Keychain storage", () => {
  it("writes every item so that a backup cannot carry it to another device", async () => {
    const keychain = fakeKeychain();
    const storage = createThisDeviceKeychainStorage(keychain.calls);

    await storage.setItem("octant.remote.device-keys.v1", "private-key-material");

    expect(await storage.getItem("octant.remote.device-keys.v1")).toBe("private-key-material");
    expect([...keychain.items.values()]).toEqual([
      { value: "private-key-material", accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    ]);
  });

  it("moves an item an earlier build wrote onto this device only, leaving no copy a backup carries", async () => {
    const keychain = fakeKeychain(
      new Map([
        [
          "app/octant.remote.device-keys.v1",
          { value: "private-key-material", accessible: WHEN_UNLOCKED },
        ],
      ]),
    );
    const storage = createThisDeviceKeychainStorage(keychain.calls);

    expect(await storage.getItem("octant.remote.device-keys.v1")).toBe("private-key-material");
    expect([...keychain.items.values()]).toEqual([
      { value: "private-key-material", accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    ]);
  });

  it("removes an earlier build's copy when the item is written or deleted", async () => {
    const keychain = fakeKeychain(
      new Map([["app/host-registry", { value: "earlier", accessible: WHEN_UNLOCKED }]]),
    );
    const storage = createThisDeviceKeychainStorage(keychain.calls);

    await storage.setItem("host-registry", "current");
    expect([...keychain.items.values()]).toEqual([
      { value: "current", accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    ]);

    keychain.items.set("app/host-registry", { value: "earlier", accessible: WHEN_UNLOCKED });
    await storage.deleteItem("host-registry");
    expect(keychain.items.size).toBe(0);
    expect(await storage.getItem("host-registry")).toBeNull();
  });

  it("never brings an earlier value back when a write lands while that value is being moved", async () => {
    const keychain = fakeKeychain(
      new Map([
        ["app/octant.remote.device-keys.v1", { value: "one host", accessible: WHEN_UNLOCKED }],
      ]),
    );
    const storage = createThisDeviceKeychainStorage(keychain.calls);

    const [read] = await Promise.all([
      storage.getItem("octant.remote.device-keys.v1"),
      storage.setItem("octant.remote.device-keys.v1", "two hosts"),
    ]);

    expect(read).toBe("one host");
    expect(await storage.getItem("octant.remote.device-keys.v1")).toBe("two hosts");
  });
});

describe("removeLegacyWebDeviceKeyCatalog", () => {
  it("deletes only the device-key catalog an earlier web build left in localStorage", () => {
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    removeLegacyWebDeviceKeyCatalog();

    expect(localStorage.removeItem).toHaveBeenCalledTimes(1);
    expect(localStorage.removeItem).toHaveBeenCalledWith(
      "octant.mobile.octant.remote.device-keys.v1",
    );
  });

  it("leaves host registry and appearance data untouched", () => {
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    removeLegacyWebDeviceKeyCatalog();

    expect(localStorage.removeItem).not.toHaveBeenCalledWith("octant.mobile.host-registry.v1");
    expect(localStorage.removeItem).not.toHaveBeenCalledWith("octant.mobile.appearance.v1");
  });

  it("is a no-op outside a web document", () => {
    Reflect.deleteProperty(globalThis, "document");
    const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    expect(() => removeLegacyWebDeviceKeyCatalog()).not.toThrow();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it("does not throw when localStorage is unavailable", () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Reflect.deleteProperty(globalThis, "localStorage");

    expect(() => removeLegacyWebDeviceKeyCatalog()).not.toThrow();
  });

  it("does not throw when localStorage.removeItem is blocked, as in Safari private mode", () => {
    const localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(() => {
        throw new Error("QuotaExceededError");
      }),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    expect(() => removeLegacyWebDeviceKeyCatalog()).not.toThrow();
  });

  it("is idempotent when called again after the catalog is already gone", () => {
    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });

    removeLegacyWebDeviceKeyCatalog();
    removeLegacyWebDeviceKeyCatalog();

    expect(localStorage.removeItem).toHaveBeenCalledTimes(2);
    expect(localStorage.removeItem).toHaveBeenNthCalledWith(
      1,
      "octant.mobile.octant.remote.device-keys.v1",
    );
    expect(localStorage.removeItem).toHaveBeenNthCalledWith(
      2,
      "octant.mobile.octant.remote.device-keys.v1",
    );
  });
});

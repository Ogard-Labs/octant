import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExpoSecureStringStorage,
  removeLegacyWebDeviceKeyCatalog,
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

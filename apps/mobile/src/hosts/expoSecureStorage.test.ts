import { afterEach, describe, expect, it, vi } from "vitest";
import { createExpoSecureStringStorage } from "./expoSecureStorage";

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

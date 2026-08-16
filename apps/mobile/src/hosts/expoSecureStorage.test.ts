import { describe, expect, it } from "vitest";
import { createExpoSecureStringStorage } from "./expoSecureStorage";

describe("expoSecureStringStorage", () => {
  it("round-trips values on the active platform backend", async () => {
    const storage = createExpoSecureStringStorage();
    const key = `test-${Date.now()}`;
    await storage.setItem(key, "paired-host");
    expect(await storage.getItem(key)).toBe("paired-host");
    await storage.deleteItem(key);
    expect(await storage.getItem(key)).toBeNull();
  });
});

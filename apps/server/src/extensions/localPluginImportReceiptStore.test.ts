import { describe, expect, it } from "vitest";
import { LocalPluginImportReceiptStore } from "./localPluginImportReceiptStore";

const windowA = "44000000-0000-4000-8000-000000000001";
const windowB = "44000000-0000-4000-8000-000000000002";

describe("LocalPluginImportReceiptStore", () => {
  it("does not exchange a skill-folder purpose receipt for plugin installation", () => {
    const store = new LocalPluginImportReceiptStore();
    const issued = store.issue({
      windowId: windowA,
      absolutePath: "/tmp/skills",
      purpose: "skill-folder",
      now: 100,
    });
    expect(
      store.consume({ receiptId: issued.receiptId, windowId: windowA, now: 200 }),
    ).toBeUndefined();
    expect(
      store.consume({
        receiptId: issued.receiptId,
        windowId: windowB,
        purpose: "skill-folder",
        now: 200,
      }),
    ).toBeUndefined();
    expect(
      store.consume({
        receiptId: issued.receiptId,
        windowId: windowA,
        purpose: "skill-folder",
        now: 200,
      }),
    ).toBe("/tmp/skills");
    expect(
      store.consume({
        receiptId: issued.receiptId,
        windowId: windowA,
        purpose: "skill-folder",
        now: 200,
      }),
    ).toBeUndefined();
  });
  it("consumes a short-lived receipt once for the exact native window", () => {
    const store = new LocalPluginImportReceiptStore({
      randomBytes: () => Uint8Array.from({ length: 32 }, () => 7),
      ttlMs: 1_000,
    });
    const issued = store.issue({
      windowId: windowA,
      absolutePath: "/Users/demo/plugin",
      now: 100,
    });

    expect(issued.receiptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.consume({ receiptId: issued.receiptId, windowId: windowB, now: 200 })).toBe(
      undefined,
    );
    expect(store.consume({ receiptId: issued.receiptId, windowId: windowA, now: 200 })).toBe(
      "/Users/demo/plugin",
    );
    expect(store.consume({ receiptId: issued.receiptId, windowId: windowA, now: 200 })).toBe(
      undefined,
    );
  });

  it("rejects expired receipts", () => {
    const store = new LocalPluginImportReceiptStore({
      randomBytes: () => Uint8Array.from({ length: 32 }, () => 9),
      ttlMs: 50,
    });
    const issued = store.issue({ windowId: windowA, absolutePath: "/tmp/plugin", now: 100 });

    expect(store.consume({ receiptId: issued.receiptId, windowId: windowA, now: 150 })).toBe(
      undefined,
    );
  });
});

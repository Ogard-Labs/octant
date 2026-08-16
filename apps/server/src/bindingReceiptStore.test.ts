import { decodeBindingReceiptId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  BINDING_RECEIPT_TTL_MS,
  BindingReceiptError,
  BindingReceiptStore,
} from "./bindingReceiptStore";

const firstWindow = decodeWindowId("00000000-0000-4000-8000-000000000511");
const secondWindow = decodeWindowId("00000000-0000-4000-8000-000000000512");
const binding = { canonicalRoot: "/private/tmp/project" } as const;

describe("BindingReceiptStore", () => {
  it("issues a canonical 256-bit receipt and consumes it exactly once", () => {
    const store = new BindingReceiptStore();
    const receipt = store.issue({
      windowId: firstWindow,
      projectType: "work",
      canonicalBinding: binding,
      now: 1_000,
    });

    expect(decodeBindingReceiptId(receipt.receiptId)).toBe(receipt.receiptId);
    expect(receipt).toEqual({
      receiptId: receipt.receiptId,
      projectType: "work",
      expiresAt: 1_000 + BINDING_RECEIPT_TTL_MS,
    });
    expect(
      store.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: firstWindow,
        projectType: "work",
        now: 1_001,
      }),
    ).toEqual(binding);
    expect(() =>
      store.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: firstWindow,
        projectType: "work",
        now: 1_002,
      }),
    ).toThrow(BindingReceiptError);
  });

  it("does not burn a valid receipt after wrong-window, wrong-type, or forged attempts", () => {
    const store = new BindingReceiptStore();
    const receipt = store.issue({
      windowId: firstWindow,
      projectType: "code",
      canonicalBinding: binding,
      now: 0,
    });

    for (const attempt of [
      { receiptId: receipt.receiptId, authenticatedWindowId: secondWindow, projectType: "code" },
      { receiptId: receipt.receiptId, authenticatedWindowId: firstWindow, projectType: "work" },
      { receiptId: "A".repeat(43), authenticatedWindowId: firstWindow, projectType: "code" },
    ] as const) {
      expect(() => store.consume({ ...attempt, now: 1 })).toThrow(BindingReceiptError);
    }
    expect(
      store.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: firstWindow,
        projectType: "code",
        now: 2,
      }),
    ).toEqual(binding);
  });

  it("expires and removes a receipt at exactly 60 seconds", () => {
    const store = new BindingReceiptStore();
    const receipt = store.issue({
      windowId: firstWindow,
      projectType: "work",
      canonicalBinding: binding,
      now: 0,
    });

    expect(() =>
      store.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: firstWindow,
        projectType: "work",
        now: BINDING_RECEIPT_TTL_MS,
      }),
    ).toThrow(BindingReceiptError);
  });
});

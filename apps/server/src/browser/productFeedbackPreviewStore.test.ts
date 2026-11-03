import { decodeProductFeedbackPreview, decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { ProductFeedbackPreviewStore } from "./productFeedbackPreviewStore";

const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const threadId = "10000000-0000-4000-8000-000000000002";
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const baseTime = Date.parse("2026-11-03T10:00:00.000Z");
function preview(n: number, expiresAt: number, cropSize = 4) {
  return decodeProductFeedbackPreview({
    id: id(n),
    threadId,
    mode: "code",
    element: {
      kind: "browser-element",
      selector: "#save",
      bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
    },
    provenance: {
      comment: { origin: "user", sourceLabel: "product-feedback-comment" },
      element: { origin: "external-content", sourceLabel: "browser-page" },
    },
    cropDataUrl: "data:image/jpeg;base64," + "A".repeat(cropSize),
    capturedAt: new Date(baseTime).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

describe("host feedback preview ownership and capacity", () => {
  it("reserves aggregate bytes before work starts and releases them without evicting live captures", () => {
    const store = new ProductFeedbackPreviewStore(() => baseTime);
    let accepted = 0;
    for (let n = 1; n <= 32; n++) {
      if (
        store.reserve({ id: id(n), windowId, threadId: id(100 + n), current: () => true }) !==
        undefined
      )
        accepted++;
    }
    expect(accepted).toBe(30); // 30 bounded in-flight reservations fit inside 8 MiB.
    store.release(id(1));
    expect(store.reserve({ id: id(33), windowId, threadId, current: () => true })).toBeDefined();
    store.close();
    expect(store.reserve({ id: id(34), windowId, threadId, current: () => true })).toBeUndefined();
  });

  it("bounds scope and host counts even when completed previews contain very small crops", () => {
    const store = new ProductFeedbackPreviewStore(() => baseTime);
    for (let n = 1; n <= 32; n++) {
      const scope = n <= 8 ? threadId : id(100 + n);
      const expiry = store.reserve({ id: id(n), windowId, threadId: scope, current: () => true });
      expect(expiry).toBeDefined();
      expect(store.put(id(n), { ...preview(n, expiry!), threadId: scope })).toBe(true);
      if (n === 8)
        expect(
          store.reserve({ id: id(99), windowId, threadId, current: () => true }),
        ).toBeUndefined();
    }
    expect(
      store.reserve({ id: id(33), windowId, threadId: id(999), current: () => true }),
    ).toBeUndefined();
    store.close();
  });

  it("keeps decoded copies scoped to their original window and task", () => {
    const store = new ProductFeedbackPreviewStore(() => baseTime);
    const expiry = store.reserve({ id: id(1), windowId, threadId, current: () => true });
    expect(store.put(id(1), preview(1, expiry!))).toBe(true);
    expect(store.read(id(1), decodeWindowId(id(90)), threadId)).toBeUndefined();
    expect(store.read(id(1), windowId, id(91))).toBeUndefined();
    const read = store.read(id(1), windowId, threadId)!;
    Object.assign(read.element, { selector: "#forged" });
    expect(store.read(id(1), windowId, threadId)?.element).toMatchObject({ selector: "#save" });
    store.close();
  });

  it.each(["expired", "revoked", "window", "purged"] as const)(
    "retires a preview on %s without resurrecting it",
    (reason) => {
      let now = baseTime,
        current = true;
      const store = new ProductFeedbackPreviewStore(() => now);
      const expiry = store.reserve({ id: id(1), windowId, threadId, current: () => current });
      store.put(id(1), preview(1, expiry!));
      if (reason === "expired") now = expiry!;
      if (reason === "revoked") current = false;
      if (reason === "window") store.revokeWindow(windowId);
      if (reason === "purged") store.purgeThread(threadId);
      expect(store.read(id(1), windowId, threadId)).toBeUndefined();
      current = true;
      now = baseTime;
      expect(store.read(id(1), windowId, threadId)).toBeUndefined();
      store.close();
    },
  );
});

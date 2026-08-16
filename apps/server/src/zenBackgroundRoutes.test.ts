import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createZenBackgroundRouteHandler } from "./zenBackgroundRoutes";
import { MAX_ZEN_BACKGROUND_BYTES, readRequestBodyWithinLimit } from "./zenBackgroundRoutes";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000121");
const assetId = "00000000-0000-4000-8000-000000000122";
const capability = `${"A".repeat(42)}A`;
const zenSpaceId = "00000000-0000-4000-8000-000000000123" as never;

describe("Zen background routes", () => {
  it("streams an exact-limit upload but cancels an under-declared overflow before staging", async () => {
    let cancelled = false;
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ZEN_BACKGROUND_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const overflowRequest = new Request("http://127.0.0.1/upload", {
      method: "POST",
      headers: { "content-length": "1" },
      body: overflow,
      // Node's Request requires this for a streamed body; Bun ignores it.
      duplex: "half",
    } as RequestInit);
    await expect(
      readRequestBodyWithinLimit(overflowRequest, MAX_ZEN_BACKGROUND_BYTES),
    ).rejects.toMatchObject({
      reason: "too-large",
    });
    expect(cancelled).toBe(true);

    const exact = new Request("http://127.0.0.1/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_ZEN_BACKGROUND_BYTES));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readRequestBodyWithinLimit(exact, MAX_ZEN_BACKGROUND_BYTES)).resolves.toHaveLength(
      MAX_ZEN_BACKGROUND_BYTES,
    );
  });

  it("cancels an upload when its request is aborted", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const request = new Request("http://127.0.0.1/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(streamController) {
          streamController.enqueue(new Uint8Array([1]));
          controller.abort();
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    await expect(
      readRequestBodyWithinLimit(request, MAX_ZEN_BACKGROUND_BYTES),
    ).rejects.toMatchObject({
      reason: "interrupted",
    });
    expect(cancelled).toBe(true);
  });

  it("never stages or mutates an oversized streamed POST body", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, now: 0 });
    const stage = vi.fn();
    const handleCommand = vi.fn();
    const response = await createZenBackgroundRouteHandler({
      store: { stage, reconcile: vi.fn() } as never,
      zenService: { handleCommand } as never,
      windowAuthorityStore: authority,
      liveAssets: () => new Map(),
      now: () => 0,
    })(
      new Request("http://127.0.0.1/api/zen/backgrounds", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-octant-window-capability": capability,
          "x-octant-zen-space-id": zenSpaceId,
          "x-octant-zen-expected-version": "1",
          "x-octant-zen-background-display-name": "huge.png",
          "content-length": "1",
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_ZEN_BACKGROUND_BYTES));
            controller.enqueue(new Uint8Array([1]));
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    expect(response?.status).toBe(413);
    expect(stage).not.toHaveBeenCalled();
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it("reconciles a staged asset when the durable Zen update fails", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, now: 0 });
    const reconcile = vi.fn(async () => undefined);
    const deleteAsset = vi.fn();
    const current = {
      spaceId: zenSpaceId,
      version: 1,
      appearance: { background: { kind: "solid", color: "#000000" } },
    };
    const response = await createZenBackgroundRouteHandler({
      store: {
        stage: vi.fn(async () => ({ assetId })),
        reconcile,
        delete: deleteAsset,
      } as never,
      zenService: {
        bootstrap: vi.fn(() => ({ space: current })),
        handleCommand: vi.fn(() => {
          throw new Error("projection unavailable");
        }),
      } as never,
      windowAuthorityStore: authority,
      liveAssets: () => new Map(),
      now: () => 0,
    })(
      new Request("http://127.0.0.1/api/zen/backgrounds", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-octant-window-capability": capability,
          "x-octant-zen-space-id": zenSpaceId,
          "x-octant-zen-expected-version": "1",
          "x-octant-zen-background-display-name": "background.png",
        },
        body: new Uint8Array([1]),
      }),
    );

    expect(response?.status).toBe(503);
    expect(reconcile).toHaveBeenNthCalledWith(2, new Map(), {
      ownerWindowId: windowId,
      spaceId: zenSpaceId,
    });
    expect(deleteAsset).not.toHaveBeenCalled();
  });

  it("does not call the store for an unauthenticated asset request", async () => {
    const read = vi.fn();
    const response = await createZenBackgroundRouteHandler({
      store: { read, reconcile: vi.fn() } as never,
      zenService: {} as never,
      windowAuthorityStore: new WindowAuthorityStore(),
      liveAssets: () => new Map(),
      now: () => 0,
    })(new Request(`http://127.0.0.1/api/zen/backgrounds/${assetId}`));

    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ category: "unauthorized" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads an asset only through the authenticated owning window capability", async () => {
    const authority = new WindowAuthorityStore();
    authority.register({ windowId, capability, now: 0 });
    const read = vi.fn(async () => ({
      metadata: { mediaType: "image/png" },
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const response = await createZenBackgroundRouteHandler({
      store: { read, reconcile: vi.fn() } as never,
      zenService: {} as never,
      windowAuthorityStore: authority,
      liveAssets: () => new Map(),
      now: () => 0,
    })(
      new Request(`http://127.0.0.1/api/zen/backgrounds/${assetId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenCalledWith(assetId, windowId);
  });
});

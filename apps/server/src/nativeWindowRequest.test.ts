import { randomBytes } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { bindPrincipalRouteContext, readPrincipalRouteContext } from "./principalRouteContext";
import { createMachineChangeRouteHandler } from "./machineChangeRoutes";
import { dispatchNativeWindowRequest } from "./nativeWindowRequest";
import { WindowAuthorityStore } from "./windowAuthorityStore";

function fixture() {
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000594");
  const capability = randomBytes(32).toString("base64url");
  const source = {
    kind: "native-nightly" as const,
    processRegistration: randomBytes(32).toString("base64url"),
    incarnation: "a".repeat(64),
    generation: 1,
  };
  const store = new WindowAuthorityStore(undefined, { elapsedNow: () => 0 });
  store.registerNative({
    windowId,
    capability,
    rendererIdentity: randomBytes(32).toString("base64url"),
    source,
    now: 0,
  });
  const request = new Request("http://127.0.0.1/api/machine/changes?afterSequence=0", {
    headers: { "x-octant-window-capability": capability },
  });
  return { store, windowId, capability, source, request };
}

function deferred() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

describe("Native window request lifetime", () => {
  it("cuts off a held real NDJSON route before a late producer can publish", async () => {
    const f = fixture();
    const gate = deferred();
    const closed = deferred();
    const route = createMachineChangeRouteHandler({
      windowAuthorityStore: f.store,
      now: () => 0,
      feed: {
        subscribe: async function* () {
          try {
            yield { kind: "changed", sequence: 1, topics: ["work-navigation"] };
            await gate.ready;
            yield { kind: "changed", sequence: 2, topics: ["work-navigation"] };
          } finally {
            closed.release();
          }
        },
      },
    });
    const response = await dispatchNativeWindowRequest(f.request, f.store, 0, route);
    const reader = response?.body?.getReader();
    try {
      expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('"sequence":1');
      const pending = reader?.read();
      f.store.revoke(f.windowId);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      gate.release();
      await closed.ready;
      await expect(reader?.read()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      gate.release();
      await reader?.cancel().catch(() => undefined);
      f.store.revoke(f.windowId);
    }
  });

  it("discards prefetched response bytes when the consumer reads only after expiry", async () => {
    const f = fixture();
    const response = await dispatchNativeWindowRequest(
      f.request,
      f.store,
      0,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("private queued bytes"));
            },
          }),
        ),
    );
    // Let the wrapper's automatic pull prefetch into its own queue.
    await Promise.resolve();
    await Promise.resolve();
    f.store.revoke(f.windowId);
    await expect(response?.body?.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not publish a non-stream response that completes after revocation", async () => {
    const f = fixture();
    const gate = deferred();
    const pending = dispatchNativeWindowRequest(f.request, f.store, 0, async () => {
      await gate.ready;
      return Response.json({ privateValue: "late" });
    });
    f.store.revoke(f.windowId);
    gate.release();
    const response = await pending;
    expect(response?.status).toBe(401);
    expect(await response?.text()).not.toContain("privateValue");
  });

  it("returns the expired response without waiting for an uncooperative producer's cancellation", async () => {
    const f = fixture();
    const gate = deferred();
    const cancellation = deferred();
    const pending = dispatchNativeWindowRequest(f.request, f.store, 0, async () => {
      await gate.ready;
      return new Response(new ReadableStream({ cancel: () => cancellation.ready }));
    });
    try {
      f.store.revoke(f.windowId);
      gate.release();
      expect((await pending)?.status).toBe(401);
    } finally {
      cancellation.release();
    }
  }, 500);

  it("preserves a renewed lifetime but never revives the old stream after re-registration", async () => {
    const f = fixture();
    const original = f.store.nativeRequestSignal(f.capability, 0);
    f.store.renewNative({
      windowId: f.windowId,
      capability: f.capability,
      source: f.source,
      now: 1,
    });
    expect(f.store.nativeRequestSignal(f.capability, 1)).toBe(original);
    expect(original?.aborted).toBe(false);
    f.store.revoke(f.windowId);
    expect(original?.aborted).toBe(true);
    f.store.registerNative({
      windowId: f.windowId,
      capability: f.capability,
      rendererIdentity: randomBytes(32).toString("base64url"),
      source: { ...f.source, generation: 2 },
      now: 2,
    });
    expect(f.store.nativeRequestSignal(f.capability, 2)).not.toBe(original);
    expect(original?.aborted).toBe(true);
    f.store.revoke(f.windowId);
  });

  it("preserves a bound native principal and combines its abort lifetime", async () => {
    const f = fixture();
    const contextAbort = new AbortController();
    const context = {
      principal: {
        kind: "local-window" as const,
        windowId: String(f.windowId),
        capabilityGeneration: 1,
      },
      scopeId: f.windowId,
      abortSignal: contextAbort.signal,
    };
    bindPrincipalRouteContext(f.request, context);
    await dispatchNativeWindowRequest(f.request, f.store, 0, async (actual) => {
      expect(actual).not.toBe(f.request);
      const preserved = readPrincipalRouteContext(actual);
      expect(preserved?.principal).toBe(context.principal);
      expect(preserved?.scopeId).toBe(f.windowId);
      expect(preserved?.abortSignal?.aborted).toBe(false);
      contextAbort.abort();
      expect(preserved?.abortSignal?.aborted).toBe(true);
      expect(actual.signal.aborted).toBe(true);
      return Response.json({ privateValue: "withheld" });
    }).then((response) => expect(response?.status).toBe(401));
    f.store.revoke(f.windowId);
  });

  it("passes ordinary local and remote request objects through unchanged", async () => {
    const f = fixture();
    f.store.revoke(f.windowId);
    f.store.register({ windowId: f.windowId, capability: f.capability, now: 0 });
    for (const request of [
      f.request,
      new Request("https://octant.example/api/projects/bootstrap"),
    ]) {
      await dispatchNativeWindowRequest(request, f.store, 0, async (actual) => {
        expect(actual).toBe(request);
        return Response.json({ ok: true });
      });
    }
  });
});

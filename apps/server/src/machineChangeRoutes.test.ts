import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMachineChangeRouteHandler } from "./machineChangeRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Machine change route", () => {
  it("streams bounded invalidations from the authenticated cursor", async () => {
    const subscribe = vi.fn(async function* () {
      yield { kind: "changed" as const, sequence: 5, topics: ["work-navigation" as const] };
    });
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const route = createMachineChangeRouteHandler({
      feed: { subscribe },
      windowAuthorityStore: store,
      now: () => 1,
    });

    const response = await route(
      new Request("http://127.0.0.1/api/machine/changes?afterSequence=4", {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toContain('"topics":["work-navigation"]');
    expect(subscribe).toHaveBeenCalledWith({ afterSequence: 4, signal: expect.any(AbortSignal) });
  });

  it("passes a cursor's epoch to the feed and refuses a malformed one", async () => {
    const subscribe = vi.fn(async function* () {
      yield { kind: "snapshot-required" as const, sequence: 0, epoch: "new-process" };
    });
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const route = createMachineChangeRouteHandler({
      feed: { subscribe },
      windowAuthorityStore: store,
      now: () => 1,
    });
    const request = (query: string) =>
      route(
        new Request(`http://127.0.0.1/api/machine/changes?${query}`, {
          headers: { "x-octant-window-capability": capability },
        }),
      );

    const response = await request("afterSequence=4&epoch=old-process");
    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toContain('"epoch":"new-process"');
    expect(subscribe).toHaveBeenCalledWith({
      afterSequence: 4,
      epoch: "old-process",
      signal: expect.any(AbortSignal),
    });
    expect((await request("afterSequence=4&epoch=not%20valid"))?.status).toBe(400);
    expect((await request("afterSequence=4&other=1"))?.status).toBe(400);
  });

  it("keeps allowed renderer origins visible on authorization failures", async () => {
    const route = createMachineChangeRouteHandler({
      feed: { subscribe: async function* () {} },
      windowAuthorityStore: new WindowAuthorityStore(),
      now: () => 1,
    });

    const response = await route(
      new Request("http://127.0.0.1/api/machine/changes?afterSequence=0", {
        headers: {
          origin: "http://127.0.0.1:5173",
          "x-octant-window-capability": capability,
        },
      }),
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
  });
});

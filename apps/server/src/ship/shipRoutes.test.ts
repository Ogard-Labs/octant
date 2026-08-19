import type { ShipTarget } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import { createShipRouteHandler } from "./shipRoutes";
import { ShipService } from "./shipService";

const targetId = "00000000-0000-4000-8000-000000000601";
const threadId = "00000000-0000-4000-8000-000000000602";

function authStore(): WindowAuthorityStore {
  return { authenticate: vi.fn(() => "w1") } as unknown as WindowAuthorityStore;
}

function service() {
  return new ShipService({
    listTargets: () =>
      [
        {
          id: targetId,
          extensionId: "ship-to-a-branch",
          displayName: "Public site",
          destination: {
            kind: "git-branch",
            remoteName: "origin",
            branch: "published",
            artifactDirectory: "dist",
          },
          enabled: false,
          version: 1,
          updatedAt: "2026-08-19T09:00:00.000Z",
        },
      ] as unknown as ReadonlyArray<ShipTarget>,
    writeTarget: () => undefined,
    checkout: () => undefined,
    observedArtifact: async () => undefined,
    credentialHandle: async () => undefined,
    publish: async () => ({ outcome: "failed" as const, detail: "not wired" }),
    approval: () => undefined,
    journal: { append: () => undefined },
    uuid: () => "00000000-0000-4000-8000-000000000603",
    clock: () => "2026-08-19T09:00:00.000Z" as never,
  });
}

const capability = {
  "x-octant-window-capability": "C".repeat(43),
  "content-type": "application/json",
};

describe("the ship API", () => {
  it("lists the targets installed on this host", async () => {
    const handle = createShipRouteHandler({
      service: service(),
      windowAuthorityStore: authStore(),
      authorizeThread: () => true,
    });

    const response = await handle(
      new Request("http://127.0.0.1/api/ship/targets", { headers: capability }),
    );

    expect(await response?.json()).toMatchObject({ targets: [{ displayName: "Public site" }] });
  });

  it("refuses to publish from a thread the window may not act on, without touching the service", async () => {
    const shipService = service();
    const execute = vi.spyOn(shipService, "execute");
    const handle = createShipRouteHandler({
      service: shipService,
      windowAuthorityStore: authStore(),
      authorizeThread: () => false,
    });

    const response = await handle(
      new Request("http://127.0.0.1/api/ship/commands", {
        method: "POST",
        headers: capability,
        body: JSON.stringify({ kind: "plan-ship", targetId, threadId }),
      }),
    );

    expect(response?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request and a non-loopback one", async () => {
    const unauthenticated = createShipRouteHandler({
      service: service(),
      windowAuthorityStore: {
        authenticate: () => {
          throw new Error("no capability");
        },
      } as unknown as WindowAuthorityStore,
      authorizeThread: () => true,
    });
    expect((await unauthenticated(new Request("http://127.0.0.1/api/ship/targets")))?.status).toBe(
      400,
    );

    const handle = createShipRouteHandler({
      service: service(),
      windowAuthorityStore: authStore(),
      authorizeThread: () => true,
    });
    expect(
      (await handle(new Request("http://octant.example/api/ship/targets", { headers: capability })))
        ?.status,
    ).toBe(400);
  });

  it("leaves paths it does not serve to the next handler", async () => {
    const handle = createShipRouteHandler({
      service: service(),
      windowAuthorityStore: authStore(),
      authorizeThread: () => true,
    });

    expect(await handle(new Request("http://127.0.0.1/api/goals?threadId=x"))).toBeUndefined();
  });
});

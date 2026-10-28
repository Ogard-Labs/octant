import { afterEach, describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { signHubLinkRequest, HUB_LINK_HEADER } from "./hubLink";
import {
  HUB_ADMINISTRATION_ROUTES,
  createHubAdministrationRouteHandler,
} from "./hubAdministrationRoutes";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";

async function setup(listenerStatus?: Parameters<typeof startHubTestHost>[0]["listenerStatus"]) {
  const host = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network: new HubTestNetwork(),
    cleanups,
    ...(listenerStatus === undefined ? {} : { listenerStatus }),
  });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const handle = createHubAdministrationRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    hub: host.hub,
    spoke: host.spoke,
  });
  return { host, handle };
}

function post(path: string, body: unknown = undefined, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("hub administration over the loopback channel", () => {
  it("answers every route it registers and no other", async () => {
    const { handle } = await setup();

    for (const path of Object.values(HUB_ADMINISTRATION_ROUTES)) {
      const response = await handle(
        path === HUB_ADMINISTRATION_ROUTES.status
          ? new Request(`http://127.0.0.1${path}`, {
              headers: {
                "x-octant-desktop-secret": secret,
                "x-octant-window-capability": capability,
              },
            })
          : post(path, path === HUB_ADMINISTRATION_ROUTES.grant ? {} : undefined),
      );
      expect(response, path).toBeDefined();
    }
    expect(await handle(post("/api/desktop/hub/members"))).toBeUndefined();
    expect(await handle(post("/api/desktop/private-listener/enable"))).toBeUndefined();
  });

  it("turns the hub role on and off for a window and journals each change with its principal", async () => {
    const { host, handle } = await setup();

    const enabled = await handle(post(HUB_ADMINISTRATION_ROUTES.enable));
    expect(enabled?.status).toBe(200);
    expect(host.hub.status().enabled).toBe(true);
    const disabled = await handle(post(HUB_ADMINISTRATION_ROUTES.disable));
    expect(disabled?.status).toBe(200);

    expect(host.records.map((record) => [record.change, record.actingPrincipal.kind])).toEqual([
      ["hub-role-enabled", "local-window"],
      ["hub-role-disabled", "local-window"],
    ]);
  });

  it("refuses to turn the hub role on while the listener has a public address", async () => {
    const { host, handle } = await setup({
      hostname: "203.0.113.7",
      origin: "https://203.0.113.7:8443",
    });

    const response = await handle(post(HUB_ADMINISTRATION_ROUTES.enable));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ status: "refused", kind: "listener-not-private" });
    expect(host.hub.status().enabled).toBe(false);
    expect(host.records).toEqual([]);
  });

  it("refuses to turn the hub role on while the listener is off", async () => {
    const { handle } = await setup({ state: "disabled", enabled: false });

    const response = await handle(post(HUB_ADMINISTRATION_ROUTES.enable));

    expect(await response?.json()).toEqual({ status: "refused", kind: "listener-not-running" });
  });

  it("accepts a join code only from a window and refuses one for a hub that is not on", async () => {
    const { handle } = await setup();

    const response = await handle(post(HUB_ADMINISTRATION_ROUTES.joinCode, { owner: true }));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ status: "refused", kind: "hub-role-off" });
  });

  it("refuses a join code that names a public hub address before contacting it", async () => {
    const { handle } = await setup();
    const forged = `octant-pair-1.${Buffer.from(
      JSON.stringify({
        origin: "https://203.0.113.7:8443",
        ticketId: "11111111-1111-4111-8111-111111111111",
        ticketProof: "A".repeat(43),
        pin: `sha256-${Buffer.alloc(32, 1).toString("base64url")}`,
      }),
    ).toString("base64url")}`;

    const response = await handle(post(HUB_ADMINISTRATION_ROUTES.join, { code: forged }));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ status: "refused", kind: "hub-origin-not-private" });
  });

  it("refuses a request with a field it does not take", async () => {
    const { handle } = await setup();

    expect(
      (await handle(post(HUB_ADMINISTRATION_ROUTES.joinCode, { owner: true, extra: 1 })))?.status,
    ).toBe(400);
    expect((await handle(post(HUB_ADMINISTRATION_ROUTES.remove, { memberId: 7 })))?.status).toBe(
      400,
    );
    expect(
      (await handle(post(HUB_ADMINISTRATION_ROUTES.grant, { items: ["root"], actProjects: [] })))
        ?.status,
    ).toBe(400);
  });
});

describe("who may administer the hub role", () => {
  async function refusedEverywhere(
    host: HubTestHost,
    handle: Awaited<ReturnType<typeof setup>>["handle"],
    init: (path: string) => Request,
  ) {
    for (const path of Object.values(HUB_ADMINISTRATION_ROUTES)) {
      const response = await handle(init(path));
      expect(response?.status, path).toBe(401);
    }
    // Nothing changed on the host.
    expect(host.hub.status().enabled).toBe(false);
    expect(host.records).toEqual([]);
  }

  it("refuses a request without the desktop secret or without a window capability", async () => {
    const { host, handle } = await setup();

    await refusedEverywhere(host, handle, (path) =>
      post(path, undefined, { "x-octant-desktop-secret": "wrong" }),
    );
    await refusedEverywhere(host, handle, (path) =>
      post(path, undefined, { "x-octant-window-capability": "B".repeat(43) }),
    );
  });

  it("refuses a remote device, whatever session it holds", async () => {
    const { host, handle } = await setup();

    await refusedEverywhere(
      host,
      handle,
      (path) =>
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: { cookie: "octant-remote-session=abc", "x-octant-csrf": "x" },
        }),
    );
  });

  it("refuses a request that carries a browser origin or names another host", async () => {
    const { host, handle } = await setup();

    await refusedEverywhere(host, handle, (path) =>
      post(path, undefined, { origin: "https://100.101.102.103:8443" }),
    );
    await refusedEverywhere(
      host,
      handle,
      (path) =>
        new Request(`https://100.101.102.103:8443${path}`, {
          method: "POST",
          headers: {
            "x-octant-desktop-secret": secret,
            "x-octant-window-capability": capability,
          },
        }),
    );
  });

  it("refuses the hub and a peer, which are signed with a member key and carry no window", async () => {
    const { host, handle } = await setup();
    const header = signHubLinkRequest({
      signHostPayload: host.signHostPayload,
      senderMemberId: host.hostId,
      recipientMemberId: host.hostId,
      method: "POST",
      path: "/api/desktop/hub/enable",
      body: "",
      now: Date.now(),
    });

    await refusedEverywhere(
      host,
      handle,
      (path) =>
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: { [HUB_LINK_HEADER]: header },
        }),
    );
  });
});

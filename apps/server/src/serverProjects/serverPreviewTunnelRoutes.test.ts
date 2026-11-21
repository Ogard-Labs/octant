import { afterEach, describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { ServerPreviewTunnels } from "./serverPreviewTunnel";
import { createServerPreviewTunnelRoutes } from "./serverPreviewTunnelRoutes";
const id = decodeWindowId("00000000-0000-4000-8000-000000000470");
const projectId = "11111111-1111-4111-8111-111111111111";
const capability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const owned: ServerPreviewTunnels[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((t) => t.close()));
});
function setup() {
  const windows = new WindowAuthorityStore();
  windows.register({ windowId: id, capability, now: 0 });
  const tunnels = new ServerPreviewTunnels({
    now: () => Date.now(),
    address: (key) =>
      key === projectId ? { server: { alias: "web", user: "deploy" }, identity: "one" } : undefined,
    ownerCurrent: () => true,
    agentSocket: () => undefined,
    record: () => true,
  });
  owned.push(tunnels);
  const route = createServerPreviewTunnelRoutes({ windows, tunnels, now: () => 1 });
  const request = (body: unknown) =>
    new Request("http://127.0.0.1/api/server-project-preview", {
      method: "POST",
      headers: { "x-octant-window-capability": capability },
      body: JSON.stringify(body),
    });
  return { route, request, tunnels, windows };
}
describe("person-operated server preview routes", () => {
  it("refuses unauthenticated and paired requests before opening a tunnel", async () => {
    const { route, request, tunnels } = setup();
    expect((await route(new Request("http://127.0.0.1/api/server-project-preview")))?.status).toBe(
      401,
    );
    const remote = request({ kind: "start", projectId, remotePort: 5173, localPort: 0 });
    bindPrincipalRouteContext(remote, {
      principal: {
        kind: "remote-device",
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      } as never,
      scopeId: id,
    });
    expect((await route(remote))?.status).toBe(403);
    expect(tunnels.read(projectId, String(id))).toBeUndefined();
  });
  it("closes an old preview when the same window id receives a new capability", async () => {
    const { route, request, tunnels, windows } = setup();
    await route(request({ kind: "start", projectId, remotePort: 5173, localPort: 0 }));
    windows.revoke(id);
    windows.register({
      windowId: id,
      capability: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA",
      now: 1,
    });
    await tunnels.reconcile();
    expect(tunnels.read(projectId, String(id))).toMatchObject({ status: "revoked" });
  });
  it("rejects extra destinations and starts and stops only a current registered Project", async () => {
    const { route, request } = setup();
    expect(
      (
        await route(
          request({
            kind: "start",
            projectId,
            remotePort: 5173,
            localPort: 0,
            remoteAddress: "10.0.0.1",
          }),
        )
      )?.status,
    ).toBe(400);
    const opened = await route(
      request({ kind: "start", projectId, remotePort: 5173, localPort: 0 }),
    );
    expect(opened?.status).toBe(200);
    expect(await opened?.json()).toMatchObject({
      kind: "tunnel",
      view: { projectId, remotePort: 5173, status: "listening" },
    });
    const stopped = await route(request({ kind: "stop", projectId }));
    expect(await stopped?.json()).toMatchObject({ view: { status: "stopped" } });
  });

  it("opens a relayed preview with no loopback port for a person-paired device and refuses hub-introduced devices", async () => {
    const windows = new WindowAuthorityStore();
    const recorded: Array<{
      readonly status: string;
      readonly localPort: number;
      readonly grantId?: string;
      readonly principal?: unknown;
    }> = [];
    let deviceLive = true;
    const tunnels = new ServerPreviewTunnels({
      now: () => Date.now(),
      address: (key) =>
        key === projectId
          ? { server: { alias: "web", user: "deploy" }, identity: "one" }
          : undefined,
      ownerCurrent: () => deviceLive,
      agentSocket: () => undefined,
      record: (entry, principal) => {
        recorded.push({
          status: entry.status,
          localPort: entry.localPort,
          ...(entry.grantId === undefined ? {} : { grantId: entry.grantId }),
          ...(principal === undefined ? {} : { principal }),
        });
        return true;
      },
    });
    owned.push(tunnels);
    const route = createServerPreviewTunnelRoutes({
      windows,
      tunnels,
      now: () => 1,
      isPersonPairedDeviceCurrent: () => deviceLive,
    });
    const deviceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    const hubStart = new Request("http://127.0.0.1/api/server-project-preview", {
      method: "POST",
      body: JSON.stringify({ kind: "start", projectId, remotePort: 5173, localPort: 0 }),
    });
    bindPrincipalRouteContext(hubStart, {
      principal: {
        kind: "remote-device",
        deviceId,
        credentialGeneration: 2,
        admittedBy: "hub-roster",
      } as never,
      scopeId: id,
    });
    expect((await route(hubStart))?.status).toBe(403);

    const pairedStart = new Request("http://127.0.0.1/api/server-project-preview", {
      method: "POST",
      body: JSON.stringify({ kind: "start", projectId, remotePort: 5173, localPort: 0 }),
    });
    bindPrincipalRouteContext(pairedStart, {
      principal: {
        kind: "remote-device",
        deviceId,
        credentialGeneration: 2,
        sessionId: "sess-1",
        admittedBy: "host-person",
      } as never,
      scopeId: id,
    });
    const started = await route(pairedStart);
    expect(started?.status).toBe(200);
    const body = (await started?.json()) as {
      kind: string;
      view: { localPort: number; endpoint: string; grantId?: string; status: string };
    };
    expect(body.kind).toBe("tunnel");
    expect(body.view.localPort).toBe(0);
    expect(body.view.grantId).toMatch(/^rsg_/);
    expect(body.view.endpoint).toBe(`/api/server-proxy/${body.view.grantId}/`);
    expect(recorded[0]).toMatchObject({
      status: "listening",
      localPort: 0,
      grantId: body.view.grantId,
      principal: { kind: "person-paired-device", credentialGeneration: 2 },
    });

    // Only the matching host-person device + generation may open a relay stream.
    const grantId = body.view.grantId ?? "";
    expect(
      tunnels.openRelayStream(grantId, {
        deviceId,
        credentialGeneration: 2,
        admittedBy: "hub-roster",
      }),
    ).toEqual({ kind: "refused", reason: "grant-closed" });
    expect(
      tunnels.openRelayStream(grantId, {
        deviceId,
        credentialGeneration: 99,
        admittedBy: "host-person",
      }),
    ).toEqual({ kind: "refused", reason: "grant-closed" });

    // Revoking the paired device revokes the relayed preview on reconcile.
    deviceLive = false;
    await tunnels.reconcile();
    expect(tunnels.read(projectId, String(id))).toMatchObject({ status: "revoked" });
  });
});

describe("server port forward routes", () => {
  const deviceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  function forwardSetup() {
    const windows = new WindowAuthorityStore();
    windows.register({ windowId: id, capability, now: 0 });
    const forwards: unknown[] = [];
    const tunnels = new ServerPreviewTunnels({
      now: () => Date.now(),
      address: (key) =>
        key === projectId
          ? { server: { alias: "web", user: "deploy" }, identity: "one" }
          : undefined,
      ownerCurrent: () => true,
      agentSocket: () => undefined,
      record: () => true,
      recordForward: (record) => {
        forwards.push(record);
        return true;
      },
    });
    owned.push(tunnels);
    const route = createServerPreviewTunnelRoutes({
      windows,
      tunnels,
      now: () => 1,
      isPersonPairedDeviceCurrent: () => true,
    });
    const start = (headers: Record<string, string> = {}) =>
      new Request("http://127.0.0.1/api/server-project-forward", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "start", projectId, remotePort: 5432 }),
      });
    return { route, tunnels, forwards, start };
  }

  it("refuses a forward from a device the preview rules do not admit", async () => {
    const { route, tunnels, forwards, start } = forwardSetup();
    const hubStart = start();
    bindPrincipalRouteContext(hubStart, {
      principal: {
        kind: "remote-device",
        deviceId,
        credentialGeneration: 2,
        sessionId: "sess-1",
        admittedBy: "hub-roster",
      } as never,
      scopeId: id,
    });
    expect((await route(hubStart))?.status).toBe(403);
    expect(tunnels.readForward(projectId, String(id))).toBeUndefined();
    expect(forwards).toEqual([]);
  });

  it("refuses a forward from a person-paired device, whose server preview goes through the relay instead", async () => {
    const { route, tunnels, forwards, start } = forwardSetup();
    const pairedStart = start();
    bindPrincipalRouteContext(pairedStart, {
      principal: {
        kind: "remote-device",
        deviceId,
        credentialGeneration: 2,
        sessionId: "sess-1",
        admittedBy: "host-person",
      } as never,
      scopeId: id,
    });
    const refused = await route(pairedStart);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({
      error: "Only a window on this computer can forward a port.",
    });
    expect(tunnels.readForward(projectId, String(id))).toBeUndefined();
    expect(forwards).toEqual([]);
  });

  it("starts, reads and stops a window's forward on this computer's loopback", async () => {
    const { route, start } = forwardSetup();
    const opened = await route(start({ "x-octant-window-capability": capability }));
    expect(opened?.status).toBe(200);
    expect(await opened?.json()).toMatchObject({
      kind: "forward",
      view: { projectId, remotePort: 5432, status: "listening" },
    });
    const read = await route(
      new Request(`http://127.0.0.1/api/server-project-forward?projectId=${projectId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(await read?.json()).toMatchObject({ view: { remotePort: 5432, status: "listening" } });
    const stopped = await route(
      new Request("http://127.0.0.1/api/server-project-forward", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({ kind: "stop", projectId }),
      }),
    );
    expect(await stopped?.json()).toMatchObject({ kind: "forward", view: { status: "stopped" } });
  });
});

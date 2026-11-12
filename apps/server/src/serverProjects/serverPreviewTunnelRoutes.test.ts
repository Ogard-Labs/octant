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
});

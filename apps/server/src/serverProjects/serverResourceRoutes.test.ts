import { Schema } from "effect";
import { decodeHostResourceSnapshot, decodeWindowId } from "@octant/contracts";
import { decodeStableHostId, DeviceId, RemoteSessionId } from "@octant/contracts/remote-access";
import { describe, expect, it } from "vitest";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createServerResourceRoutes } from "./serverResourceRoutes";
import type { ServerResourceRead } from "./serverResources";

const windowId = decodeWindowId("70000000-0000-4000-8000-000000000002");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const URL_PATH = "http://127.0.0.1:3100/api/server-projects/resources?projectId=p1";
const snapshot = decodeHostResourceSnapshot({
  cores: 4,
  cpuPercent: 10,
  memory: { usedBytes: 1, totalBytes: 2 },
  sampledAt: "2026-11-09T12:00:00.000Z",
});

function setup(read: ServerResourceRead | undefined) {
  const windows = new WindowAuthorityStore();
  windows.register({ windowId, capability, now: 0 });
  let asked = 0;
  const routes = createServerResourceRoutes({
    windows,
    now: () => 0,
    readerFor: (projectId) =>
      read === undefined || projectId !== "p1"
        ? undefined
        : async () => {
            asked += 1;
            return read;
          },
  });
  return { routes, asked: () => asked };
}

const local = (url = URL_PATH) =>
  new Request(url, { headers: { "x-octant-window-capability": capability } });

describe("the server resources route", () => {
  it("refuses a caller with no window capability and runs nothing", async () => {
    const { routes, asked } = setup({ status: "ready", snapshot });
    const response = await routes(new Request(URL_PATH));
    expect(response?.status).toBe(401);
    expect(asked()).toBe(0);
  });

  it("refuses a paired device, whose request would run a command under the person's SSH identity", async () => {
    const { routes, asked } = setup({ status: "ready", snapshot });
    const request = new Request(URL_PATH);
    bindPrincipalRouteContext(request, {
      principal: createRemoteDevicePrincipal({
        hostId: decodeStableHostId("33333333-3333-4333-8333-333333333333"),
        deviceId: Schema.decodeUnknownSync(DeviceId)("22222222-2222-4222-8222-222222222222"),
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: Schema.decodeUnknownSync(RemoteSessionId)(
          "55555555-5555-4555-8555-555555555555",
        ),
      }),
      scopeId: decodeWindowId("22222222-2222-4222-8222-222222222222"),
    });
    expect((await routes(request))?.status).toBe(403);
    expect(asked()).toBe(0);
  });

  it("answers the server's snapshot to a local window", async () => {
    const { routes } = setup({ status: "ready", snapshot });
    const response = await routes(local());
    expect(response?.status).toBe(200);
    expect(decodeHostResourceSnapshot(await response?.json())).toEqual(snapshot);
  });

  it("says plainly when the Project is not on a server, the server is not Linux, or it cannot be reached", async () => {
    expect((await setup({ status: "ready", snapshot }).routes(local(`${URL_PATH}x`)))?.status).toBe(
      404,
    );
    expect((await setup({ status: "unsupported" }).routes(local()))?.status).toBe(501);
    expect(
      (await setup({ status: "unavailable", message: "refused" }).routes(local()))?.status,
    ).toBe(502);
  });

  it("ignores other paths", async () => {
    const { routes } = setup(undefined);
    expect(await routes(new Request("http://127.0.0.1:3100/api/other"))).toBeUndefined();
  });
});

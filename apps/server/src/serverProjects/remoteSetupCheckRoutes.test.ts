import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { WindowId } from "@octant/contracts";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createRemoteSetupCheckRoutes } from "./remoteSetupCheckRoutes";
const windowId = Schema.decodeUnknownSync(WindowId)("00000000-0000-4000-8000-000000000470");
const capability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const input = { serverId: "00000000-0000-4000-8000-000000000710", runtime: "octant-harness" };
function fixture() {
  const windows = new WindowAuthorityStore();
  windows.register({ windowId, capability, now: 0 });
  const check = vi.fn(async () => ({
    status: "connected" as const,
    reason: "ready" as const,
    folder: "/srv/app",
  }));
  return {
    check,
    route: createRemoteSetupCheckRoutes({ windows, checks: { check }, now: () => 1 }),
  };
}
const request = (body: unknown = input) =>
  new Request("http://127.0.0.1/api/remote-setup-check", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "x-octant-window-capability": capability },
  });
describe("local read-only setup check route", () => {
  it("authenticates before probing, admits a person-paired device and refuses hub-introduced or restricted devices", async () => {
    let deviceCurrent = true;
    const windows = new WindowAuthorityStore();
    windows.register({ windowId, capability, now: 0 });
    const check = vi.fn(async () => ({
      status: "connected" as const,
      reason: "ready" as const,
      folder: "/srv/app",
    }));
    const route = createRemoteSetupCheckRoutes({
      windows,
      checks: { check },
      isPersonPairedDeviceCurrent: () => deviceCurrent,
      now: () => 1,
    });
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/remote-setup-check", {
            method: "POST",
            body: JSON.stringify(input),
          }),
        )
      )?.status,
    ).toBe(401);
    for (const admittedBy of ["hub-roster", undefined] as const) {
      const restricted = request();
      bindPrincipalRouteContext(restricted, {
        principal: {
          kind: "remote-device",
          deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          credentialGeneration: 1,
          sessionId: "sess-restricted",
          ...(admittedBy === undefined ? {} : { admittedBy }),
        } as never,
        scopeId: windowId,
      });
      const refused = await route(restricted);
      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toMatchObject({ reason: "needs-person" });
    }
    expect(check).not.toHaveBeenCalled();

    const paired = request();
    bindPrincipalRouteContext(paired, {
      principal: {
        kind: "remote-device",
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        credentialGeneration: 2,
        sessionId: "sess-person",
        admittedBy: "host-person",
      } as never,
      scopeId: windowId,
    });
    const pairedAnswer = await route(paired);
    expect(pairedAnswer?.status).toBe(200);
    expect(await pairedAnswer?.json()).toMatchObject({ status: "connected", folder: "/srv/app" });

    deviceCurrent = false;
    const revoked = request();
    bindPrincipalRouteContext(revoked, {
      principal: {
        kind: "remote-device",
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        credentialGeneration: 2,
        sessionId: "sess-person",
        admittedBy: "host-person",
      } as never,
      scopeId: windowId,
    });
    expect((await route(revoked))?.status).toBe(401);

    const response = await route(request());
    expect(await response?.json()).toMatchObject({ status: "connected" });
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(check).toHaveBeenCalledTimes(3);
  });
  it("rejects scripts, credentials, invalid folder paths and nonloopback requests before any SSH", async () => {
    const { route, check } = fixture();
    for (const body of [
      { ...input, script: "touch /x" },
      { ...input, privateKey: "secret" },
      { ...input, folder: "relative" },
    ]) {
      expect((await route(request(body)))?.status).toBe(400);
    }
    expect(
      (
        await route(
          new Request("https://example.test/api/remote-setup-check", {
            method: "POST",
            body: JSON.stringify(input),
          }),
        )
      )?.status,
    ).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });
});

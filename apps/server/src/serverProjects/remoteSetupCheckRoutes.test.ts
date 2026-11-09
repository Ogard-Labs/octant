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
  it("authenticates before probing and refuses a paired principal even with a local capability header", async () => {
    const { route, check } = fixture();
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
    const remote = request();
    bindPrincipalRouteContext(remote, {
      principal: {
        kind: "remote-device",
        deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      } as never,
      scopeId: windowId,
    });
    expect(await (await route(remote))?.json()).toMatchObject({ reason: "needs-local-window" });
    expect(check).not.toHaveBeenCalled();
    const response = await route(request());
    expect(await response?.json()).toMatchObject({ status: "connected" });
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(check).toHaveBeenCalledTimes(1);
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

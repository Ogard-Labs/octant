import { describe, expect, it, vi } from "vitest";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { createPairedDeviceRouteSlot } from "./pairedDeviceRouteSlot";

const deviceId = "73000000-0000-4000-8000-000000000070";

function fromDevice(path: string): Request {
  const request = new Request(`http://127.0.0.1${path}`, { method: "POST" });
  bindPrincipalRouteContext(request, {
    principal: createRemoteDevicePrincipal({
      hostId: "local" as never,
      deviceId: deviceId as never,
      credentialGeneration: 1,
      origin: "https://octant.invalid",
      protocolVersion: 1,
      capabilityDigest: "b".repeat(64),
      sessionId: "73000000-0000-4000-8000-000000000071" as never,
      admittedBy: "host-person",
    }),
    scopeId: deviceId as never,
  });
  return request;
}

describe("the product chain's place for routes the remote wiring builds", () => {
  it("answers a paired device from the first bound route that takes its request, and nothing before the routes are bound", async () => {
    const slot = createPairedDeviceRouteSlot();
    expect(await slot.routes(fromDevice("/api/host-control/status"))).toBeUndefined();

    const passes = vi.fn(async () => undefined);
    const answers = vi.fn(async () => new Response("answered"));
    const never = vi.fn(async () => new Response("later"));
    slot.bind([passes, answers, never]);

    const response = await slot.routes(fromDevice("/api/host-control/status"));
    expect(await response?.text()).toBe("answered");
    expect(passes).toHaveBeenCalledOnce();
    expect(never).not.toHaveBeenCalled();
  });

  it("hands on no request that carries no paired device, so a local caller reaches these routes only on the loopback listener's own chain", async () => {
    const slot = createPairedDeviceRouteSlot();
    const routes = vi.fn(async () => new Response("answered"));
    slot.bind([routes]);

    expect(
      await slot.routes(new Request("http://127.0.0.1/api/host-control/status")),
    ).toBeUndefined();
    expect(routes).not.toHaveBeenCalled();
  });
});

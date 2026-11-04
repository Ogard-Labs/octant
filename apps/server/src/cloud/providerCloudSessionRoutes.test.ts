import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { Schema } from "effect";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { createProviderCloudSessionRoutes } from "./providerCloudSessionRoutes";

describe("provider cloud routes", () => {
  it("requires a local authenticated window and strict data-transfer commands before service admission", async () => {
    const store = new WindowAuthorityStore();
    const windowId = decodeWindowId("a7550000-0000-4000-8000-000000000001");
    const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
    store.register({ windowId, capability, now: Date.now() });
    const execute = vi.fn(async () => ({ status: "ready" as const, profiles: [], jobs: [] }));
    const route = createProviderCloudSessionRoutes({
      service: { execute },
      windowAuthorityStore: store,
    });
    const request = (authorized = true, body: unknown = { kind: "profiles" }) =>
      new Request("http://127.0.0.1:3100/api/provider-cloud", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { "x-octant-window-capability": capability } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await route(request(false)))?.status).toBe(400);
    expect((await route(request(true, { kind: "profiles", projectId: "forged" })))?.status).toBe(
      400,
    );
    expect(execute).not.toHaveBeenCalled();
    const remote = request();
    bindPrincipalRouteContext(remote, {
      scopeId: windowId,
      principal: {
        kind: "remote-device",
        deviceId: Schema.decodeUnknownSync(DeviceId)(windowId),
        hostId: Schema.decodeUnknownSync(StableHostId)(windowId),
        credentialGeneration: 1,
        origin: "https://fixture.invalid",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: Schema.decodeUnknownSync(RemoteSessionId)(windowId),
      },
    });
    expect((await route(remote))?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect((await route(request()))?.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

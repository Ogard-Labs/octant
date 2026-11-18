import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { Schema } from "effect";
import { decodeWindowId } from "@octant/contracts";
import { decodeSandboxRestrictionsSnapshot } from "@octant/contracts/sandbox-policy";
import { describe, expect, it, vi } from "vitest";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createSandboxRestrictionsRoutes } from "./sandboxRestrictionsRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("74000000-0000-4000-8000-000000000001");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4";
function fixture() {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: Date.now() });
  const snapshot = vi.fn(() =>
    decodeSandboxRestrictionsSnapshot({
      kind: "sandbox-restrictions",
      version: 0,
      scope: { kind: "settings", mode: "code" },
      source: "legacy",
      inherited: false,
      running: false,
      summary: "Existing sandbox",
      limitations: [],
      capabilities: {
        folders: true,
        protectedPaths: false,
        isolatedCredentials: false,
        blockedHostServices: true,
      },
      denials: [],
    }),
  );
  const change = vi.fn(() => snapshot());
  return {
    route: createSandboxRestrictionsRoutes({ windowAuthorityStore, service: { snapshot, change } }),
    snapshot,
    change,
  };
}
function request(
  authenticated = true,
  body: unknown = {
    kind: "inherit-policy",
    scope: { kind: "settings", mode: "code" },
    expectedVersion: 0,
  },
) {
  return new Request("http://127.0.0.1:3100/api/sandbox-restrictions/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { "x-octant-window-capability": capability } : {}),
    },
    body: JSON.stringify(body),
  });
}
describe("trusted sandbox settings routes", () => {
  it("requires host-person authority before applying a strict versioned command", async () => {
    const f = fixture();
    expect((await f.route(request(false)))?.status).toBe(401);
    expect(f.change).not.toHaveBeenCalled();
    expect(
      (
        await f.route(
          request(true, {
            kind: "inherit-policy",
            scope: { kind: "settings", mode: "code" },
            expectedVersion: 0,
            forged: true,
          }),
        )
      )?.status,
    ).toBe(400);
    expect(f.change).not.toHaveBeenCalled();
    expect((await f.route(request()))?.status).toBe(200);
    expect(f.change).toHaveBeenCalledOnce();
  });
  it("refuses agent and hub-introduced requests even when transport authentication succeeded", async () => {
    const f = fixture();
    for (const principal of [
      {
        kind: "remote-device",
        deviceId: Schema.decodeUnknownSync(DeviceId)(String(windowId)),
        admittedBy: "hub-roster",
      },
      {
        kind: "remote-device",
        deviceId: Schema.decodeUnknownSync(DeviceId)(String(windowId)),
        origin: "octant-agent-access",
      },
    ]) {
      const incoming = request(false);
      bindPrincipalRouteContext(incoming, {
        principal: {
          kind: "remote-device",
          hostId: Schema.decodeUnknownSync(StableHostId)(String(windowId)),
          sessionId: Schema.decodeUnknownSync(RemoteSessionId)(String(windowId)),
          credentialGeneration: 1,
          protocolVersion: 1,
          capabilityDigest: "b".repeat(64),
          origin: "https://octant.example",
          deviceId: Schema.decodeUnknownSync(DeviceId)(String(windowId)),
          ...(principal.admittedBy === "hub-roster"
            ? { admittedBy: "hub-roster" }
            : { origin: "octant-agent-access" }),
        },
        scopeId: windowId,
      });
      expect((await f.route(incoming))?.status).toBe(403);
    }
    expect(f.change).not.toHaveBeenCalled();
  });
});

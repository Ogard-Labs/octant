import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { ClientPrincipalError } from "./clientPrincipal";
import {
  authenticateRouteWindowId,
  bindPrincipalRouteContext,
  readPrincipalRouteContext,
  resolvePrincipalRouteContext,
} from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const localWindowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const remoteDeviceId = "22222222-2222-4222-8222-222222222222" as DeviceId;
const remotePrincipal = createRemoteDevicePrincipal({
  hostId: "33333333-3333-4333-8333-333333333333" as StableHostId,
  deviceId: remoteDeviceId,
  credentialGeneration: 1,
  origin: "https://octant.example",
  protocolVersion: 1,
  capabilityDigest: "a".repeat(64),
  sessionId: "44444444-4444-4444-8444-444444444444" as RemoteSessionId,
});

describe("principal route context", () => {
  it("resolves local requests through the shared principal adapter", () => {
    const store = new WindowAuthorityStore();
    const capability = randomBytes(32).toString("base64url");
    store.register({ windowId: localWindowId, capability, now: 0 });
    const request = new Request("http://127.0.0.1/api/chat/bootstrap", {
      headers: { "x-octant-window-capability": capability },
    });

    const context = resolvePrincipalRouteContext({ request, store, now: 0 });

    expect(context).toMatchObject({
      principal: { kind: "local-window", windowId: String(localWindowId) },
      scopeId: localWindowId,
    });
    expect(authenticateRouteWindowId({ request, store, now: 0 })).toBe(localWindowId);
  });

  it("binds remote device identity without laundering it into a local principal", () => {
    const request = new Request("https://octant.example/api/chat/bootstrap");
    const context = resolvePrincipalRouteContext({
      request,
      principal: remotePrincipal,
      abortSignal: AbortSignal.timeout(1000),
    });
    bindPrincipalRouteContext(request, context);

    expect(readPrincipalRouteContext(request)).toBe(context);
    expect(context.principal.kind).toBe("remote-device");
    expect(context.scopeId).toBe(decodeWindowId(String(remoteDeviceId)));
    expect(authenticateRouteWindowId({ request, store: new WindowAuthorityStore(), now: 0 })).toBe(
      context.scopeId,
    );
  });

  it("does not reuse a bound principal for another Request object", () => {
    const request = new Request("https://octant.example/api/chat/bootstrap");
    const context = resolvePrincipalRouteContext({ request, principal: remotePrincipal });
    bindPrincipalRouteContext(request, context);

    expect(readPrincipalRouteContext(new Request(request))).toBeUndefined();
  });

  it("still rejects caller-supplied principal identity on a bound request", () => {
    const request = new Request("https://octant.example/api/chat/commands");
    const context = resolvePrincipalRouteContext({ request, principal: remotePrincipal });
    bindPrincipalRouteContext(request, context);

    expect(() =>
      resolvePrincipalRouteContext({ request, body: { windowId: String(localWindowId) } }),
    ).toThrow(ClientPrincipalError);
    expect(() =>
      resolvePrincipalRouteContext({ request: new Request(request), principal: remotePrincipal }),
    ).not.toThrow();
    expect(() =>
      resolvePrincipalRouteContext({
        request: new Request(request),
        principal: remotePrincipal,
        body: { windowId: String(localWindowId) },
      }),
    ).toThrow(ClientPrincipalError);
  });
});

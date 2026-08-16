import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import {
  ClientPrincipalError,
  assertNoPrincipalIdentityInPayload,
  createRemoteDevicePrincipal,
  requireLocalWindowId,
  resolveAuthenticatedPrincipal,
  resolveLocalWindowPrincipal,
} from "./clientPrincipal";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const capability = () => randomBytes(32).toString("base64url");
const hostId = "22222222-2222-4222-8222-222222222222" as StableHostId;
const deviceId = "33333333-3333-4333-8333-333333333333" as DeviceId;
const sessionId = "44444444-4444-4444-8444-444444444444" as RemoteSessionId;
const digest = "a".repeat(64);

describe("clientPrincipal adapter", () => {
  it("resolves a local-window principal from the capability header only", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId, capability: token, now: 0 });
    const request = new Request("https://octant.local/api/chat/threads", {
      headers: { "x-octant-window-capability": token },
    });
    const principal = resolveLocalWindowPrincipal({ request, store, now: 0 });
    expect(principal).toEqual({
      kind: "local-window",
      windowId,
      capabilityGeneration: 0,
    });
    expect(requireLocalWindowId(principal)).toBe(windowId);
  });

  it("rejects missing/invalid capability without leaking store internals", () => {
    const store = new WindowAuthorityStore();
    const request = new Request("https://octant.local/api/chat/threads");
    expect(() => resolveLocalWindowPrincipal({ request, store, now: 0 })).toThrow(
      ClientPrincipalError,
    );
  });

  it("rejects window identity supplied via body or query", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId, capability: token, now: 0 });
    const withQuery = new Request(`https://octant.local/api/chat/threads?windowId=${windowId}`, {
      headers: { "x-octant-window-capability": token },
    });
    expect(() => resolveLocalWindowPrincipal({ request: withQuery, store, now: 0 })).toThrow(
      /query/i,
    );
    const request = new Request("https://octant.local/api/chat/threads", {
      headers: { "x-octant-window-capability": token },
    });
    expect(() =>
      resolveLocalWindowPrincipal({
        request,
        store,
        now: 0,
        body: { windowId },
      }),
    ).toThrow(/body/i);
  });

  it("creates a remote-device principal and never upgrades to local-window", () => {
    const principal = createRemoteDevicePrincipal({
      hostId,
      deviceId,
      credentialGeneration: 1,
      origin: "https://remote.octant.local",
      protocolVersion: 1,
      capabilityDigest: digest,
      sessionId,
    });
    expect(principal.kind).toBe("remote-device");
    expect(JSON.stringify(principal)).not.toContain("local-window");
    expect(() => requireLocalWindowId(principal)).toThrow(/local-window/i);
  });

  it("rejects invalid remote principal materials", () => {
    expect(() =>
      createRemoteDevicePrincipal({
        hostId,
        deviceId,
        credentialGeneration: -1,
        origin: "https://remote.octant.local",
        protocolVersion: 1,
        capabilityDigest: digest,
        sessionId,
      }),
    ).toThrow(ClientPrincipalError);
    expect(() =>
      createRemoteDevicePrincipal({
        hostId,
        deviceId,
        credentialGeneration: 1,
        origin: "https://remote.octant.local",
        protocolVersion: 1,
        capabilityDigest: "not-a-digest",
        sessionId,
      }),
    ).toThrow(ClientPrincipalError);
  });

  it("resolveAuthenticatedPrincipal dispatches local and remote kinds", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId, capability: token, now: 0 });
    const local = resolveAuthenticatedPrincipal({
      kind: "local-window",
      request: new Request("https://octant.local/api/x", {
        headers: { "x-octant-window-capability": token },
      }),
      store,
      now: 0,
    });
    expect(local.kind).toBe("local-window");

    const remote = resolveAuthenticatedPrincipal({
      kind: "remote-device",
      hostId,
      deviceId,
      credentialGeneration: 2,
      origin: "https://tailscale.example",
      protocolVersion: 1,
      capabilityDigest: digest,
      sessionId,
    });
    expect(remote.kind).toBe("remote-device");
  });

  it("rejects local-window resolution when a remote session cookie is present", () => {
    const store = new WindowAuthorityStore();
    const token = capability();
    store.register({ windowId, capability: token, now: 0 });
    const request = new Request("https://octant.local/api/chat/threads", {
      headers: {
        "x-octant-window-capability": token,
        cookie: "__Secure-octant-remote-session=44444444-4444-4444-8444-444444444444",
      },
    });
    expect(() =>
      resolveAuthenticatedPrincipal({ kind: "local-window", request, store, now: 0 }),
    ).toThrow(/remote session/i);
  });

  it("assertNoPrincipalIdentityInPayload is pure and reusable", () => {
    expect(() =>
      assertNoPrincipalIdentityInPayload(new Request("https://octant.local/api/x?deviceId=1")),
    ).toThrow(ClientPrincipalError);
  });
});

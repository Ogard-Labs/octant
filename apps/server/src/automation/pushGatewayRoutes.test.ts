import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  RemoteSessionId,
  StableHostId,
  decodeWindowId,
  type RemoteClientPrincipal,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { createPushGatewaySetting } from "../remote/pushGatewaySetting";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createAutomationNotificationRouteHandler } from "./automationNotificationRoutes";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const localWindow: RemoteClientPrincipal = {
  kind: "local-window",
  windowId: "33333333-3333-4333-8333-333333333333",
  capabilityGeneration: 0,
};
const pairedPhone: RemoteClientPrincipal = {
  kind: "remote-device",
  hostId: Schema.decodeUnknownSync(StableHostId)("11111111-1111-4111-8111-111111111111"),
  deviceId: Schema.decodeUnknownSync(DeviceId)("22222222-2222-4222-8222-222222222222"),
  credentialGeneration: 1,
  origin: "https://remote.example",
  protocolVersion: 1,
  capabilityDigest: "d".repeat(64),
  sessionId: Schema.decodeUnknownSync(RemoteSessionId)("00000000-0000-4000-8000-000000000403"),
};

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "octant-push-gateway-routes-"));
  directories.push(directory);
  const setting = createPushGatewaySetting(directory);
  const handler = createAutomationNotificationRouteHandler({
    windowAuthorityStore: new WindowAuthorityStore(),
    preferences: {
      current: () => {
        throw new Error("not read");
      },
      update: () => {
        throw new Error("not written");
      },
    },
    delivery: {
      status: () => {
        throw new Error("not read");
      },
      queryDeliveries: () => {
        throw new Error("not read");
      },
    },
    pushGateway: setting,
  });
  return { handler, setting };
}

function request(principal: RemoteClientPrincipal, init?: RequestInit): Request {
  const next = new Request("http://127.0.0.1/api/push-notifications/gateway", init);
  bindPrincipalRouteContext(next, {
    principal,
    scopeId: decodeWindowId("33333333-3333-4333-8333-333333333333"),
  });
  return next;
}

const turnOn = (expectedVersion: number) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ enabled: true, gatewayUrl: "https://push.example.test", expectedVersion }),
});

describe("phone notification setting routes", () => {
  it("lets a window on this computer turn phone notifications on and name the gateway", async () => {
    const { handler, setting } = harness();
    const response = await handler(request(localWindow, turnOn(0)));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      settings: {
        kind: "remote-push-gateway-settings",
        enabled: true,
        gatewayUrl: "https://push.example.test",
        version: 1,
      },
    });
    expect(setting.current().enabled).toBe(true);
  });

  it("refuses a paired phone that tries to turn them on, and leaves them off", async () => {
    const { handler, setting } = harness();
    const response = await handler(request(pairedPhone, turnOn(0)));
    expect(response?.status).toBe(403);
    expect(setting.current().enabled).toBe(false);
  });

  it("refuses a save from a stale read", async () => {
    const { handler } = harness();
    await handler(request(localWindow, turnOn(0)));
    const response = await handler(request(localWindow, turnOn(0)));
    expect(response?.status).toBe(409);
  });

  it("refuses a gateway address that is plain http off this computer", async () => {
    const { handler, setting } = harness();
    const response = await handler(
      request(localWindow, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          gatewayUrl: "http://push.example.test",
          expectedVersion: 0,
        }),
      }),
    );
    expect(response?.status).toBe(400);
    expect(setting.current().enabled).toBe(false);
  });
});

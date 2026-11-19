import {
  decodeNewMemberAlert,
  decodeWindowId,
  PairedDeviceAlert,
  type NewMemberAlert,
} from "@octant/contracts";
import { Schema } from "effect";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { describe, expect, it } from "vitest";
import { AGENT_ACCESS_ORIGIN, createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createNewDeviceAlertRouteHandler, NEW_DEVICE_ALERTS_PATH } from "./newDeviceAlertRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");

const tabletAlert: NewMemberAlert = decodeNewMemberAlert({
  alertId: "00000000-0000-4000-8000-000000000a01",
  memberId: "00000000-0000-4000-8000-000000000a02",
  name: "Tablet",
  role: "spoke",
  identityKeyFingerprint: "c".repeat(64),
  raisedAt: "2026-11-19T22:00:00.000Z",
  privateAddress: "100.101.102.106",
});

const phoneAlert: PairedDeviceAlert = Schema.decodeUnknownSync(PairedDeviceAlert)({
  alertId: "00000000-0000-4000-8000-000000000b01",
  deviceId: "00000000-0000-4000-8000-000000000b02",
  name: "Ada's phone",
  deviceKeyFingerprint: "d".repeat(64),
  raisedAt: "2026-11-19T22:05:00.000Z",
  privateAddress: "192.168.1.20",
});

function route(options?: { readonly dismissed?: string[]; readonly paired?: boolean }) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createNewDeviceAlertRouteHandler({
    memberAlerts: () => [tabletAlert],
    ...(options?.paired === true ? { pairedAlerts: () => [phoneAlert] } : {}),
    dismissPaired: (alertId) => {
      options?.dismissed?.push(alertId);
      return { status: "dismissed" };
    },
    windowAuthorityStore: store,
    now: () => 0,
  });
}

function fromDevice(input: {
  readonly admittedBy?: "host-person" | "hub-roster";
  readonly origin?: string;
  readonly dismiss?: string;
}) {
  const request =
    input.dismiss === undefined
      ? new Request(`http://127.0.0.1${NEW_DEVICE_ALERTS_PATH}`)
      : new Request(`http://127.0.0.1${NEW_DEVICE_ALERTS_PATH}/dismiss`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ alertId: input.dismiss }),
        });
  bindPrincipalRouteContext(request, {
    principal: createRemoteDevicePrincipal({
      hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
      deviceId: "22222222-2222-4222-8222-222222222222" as DeviceId,
      credentialGeneration: 1,
      origin: input.origin ?? "https://octant.example",
      protocolVersion: 1,
      capabilityDigest: "b".repeat(64),
      sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
      ...(input.admittedBy === undefined ? {} : { admittedBy: input.admittedBy }),
    }),
    scopeId: decodeWindowId("22222222-2222-4222-8222-222222222222"),
  });
  return request;
}

describe("new-device alerts for every connected device", () => {
  it("shows a new device's name and private address to a window, which may remove it there", async () => {
    const response = await route()(
      new Request(`http://127.0.0.1${NEW_DEVICE_ALERTS_PATH}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      alerts: [
        {
          kind: "hub-member",
          alertId: tabletAlert.alertId,
          name: "Tablet",
          role: "spoke",
          identityKeyFingerprint: "c".repeat(64),
          raisedAt: "2026-11-19T22:00:00.000Z",
          privateAddress: "100.101.102.106",
        },
      ],
      removesHere: true,
    });
  });

  it("shows the same alert to a paired device and to a hub guest, which remove it elsewhere", async () => {
    for (const admittedBy of ["host-person", "hub-roster"] as const) {
      const response = await route()(fromDevice({ admittedBy }));
      expect(response?.status).toBe(200);
      const body = await response?.json();
      expect(
        body.alerts.map((alert: { name: string; privateAddress: string }) => [
          alert.name,
          alert.privateAddress,
        ]),
      ).toEqual([["Tablet", "100.101.102.106"]]);
      expect(body.removesHere).toBe(false);
    }
  });

  it("refuses an agent grant, which is no device", async () => {
    const response = await route()(fromDevice({ origin: AGENT_ACCESS_ORIGIN }));
    expect(response?.status).toBe(403);
  });

  it("tells every device about a phone that paired directly with this host, by name and private address", async () => {
    const response = await route({ paired: true })(fromDevice({ admittedBy: "hub-roster" }));
    const body = await response?.json();
    expect(body.alerts).toContainEqual({
      kind: "paired-device",
      ...JSON.parse(JSON.stringify(phoneAlert)),
    });
  });

  it("clears a paired device's alert only from a window on this host", async () => {
    const dismissed: string[] = [];
    const handler = route({ dismissed, paired: true });
    const fromWindow = await handler(
      new Request(`http://127.0.0.1${NEW_DEVICE_ALERTS_PATH}/dismiss`, {
        method: "POST",
        headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
        body: JSON.stringify({ alertId: String(phoneAlert.alertId) }),
      }),
    );
    expect(fromWindow?.status).toBe(200);
    // Even a device the host's own person paired clears nothing from here.
    const fromPhone = await handler(
      fromDevice({ admittedBy: "host-person", dismiss: String(phoneAlert.alertId) }),
    );
    expect(fromPhone?.status).toBe(403);
    expect(dismissed).toEqual([String(phoneAlert.alertId)]);
  });
});

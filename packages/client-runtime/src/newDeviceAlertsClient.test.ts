import { describe, expect, it, vi } from "vitest";
import { createNewDeviceAlertsClient } from "./newDeviceAlertsClient";

const list = {
  alerts: [
    {
      kind: "paired-device",
      alertId: "00000000-0000-4000-8000-000000000b01",
      deviceId: "00000000-0000-4000-8000-000000000b02",
      name: "Ada's phone",
      deviceKeyFingerprint: "d".repeat(64),
      raisedAt: "2026-11-19T22:05:00.000Z",
      privateAddress: "192.168.1.20",
    },
  ],
  removesHere: false,
};

describe("reading a host's new-device alerts from any connected device", () => {
  it("reads the alerts with their names and private addresses", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(list),
    );
    const client = createNewDeviceAlertsClient({ baseUrl: "http://127.0.0.1", fetch });
    await expect(client.read()).resolves.toEqual(list);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1/api/new-device-alerts");
  });

  it("reads nothing, so the last alerts stay shown, when the host refuses or answers off-contract", async () => {
    for (const answer of [new Response("no", { status: 403 }), Response.json({ alerts: "nope" })]) {
      const client = createNewDeviceAlertsClient({
        baseUrl: "http://127.0.0.1",
        fetch: vi.fn(async () => answer),
      });
      await expect(client.read()).resolves.toBeUndefined();
    }
  });

  it("sends a window's capability with a dismissal and reports whether the host took it", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ status: "dismissed" }),
    );
    const client = createNewDeviceAlertsClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: "cap",
    });
    await expect(client.dismiss("00000000-0000-4000-8000-000000000b01")).resolves.toBe(true);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-octant-window-capability")).toBe("cap");
  });
});

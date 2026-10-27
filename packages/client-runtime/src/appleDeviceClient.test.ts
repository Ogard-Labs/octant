import {
  decodeAppleDeviceRequest,
  type AppleDeviceRequest,
} from "@octant/contracts/apple-toolchain";
import { describe, expect, it, vi } from "vitest";
import { createAppleDeviceClient } from "./appleDeviceClient";

const authority = {
  hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
  mode: "code",
  projectId: "81000000-0000-4000-8000-000000000001",
  providerInstanceId: "81000000-0000-4000-8000-000000000002",
  extension: { kind: "core" },
} as const;
const thread = {
  threadId: "81000000-0000-4000-8000-000000000005",
  checkoutId: "81000000-0000-4000-8000-000000000006",
};
const deviceId = "81000000-0000-4000-8000-000000000009";

function deviceRequest(kind: AppleDeviceRequest["kind"]): AppleDeviceRequest {
  return decodeAppleDeviceRequest({
    actionId: "81000000-0000-4000-8000-000000000003",
    correlationId: "81000000-0000-4000-8000-000000000004",
    authority,
    ...thread,
    kind,
    requestedBy: { kind: "local-user", actorId: "81000000-0000-4000-8000-000000000010" },
    ...(kind === "discover" ? {} : { deviceId }),
    timeoutMs: 30_000,
    approval: { kind: "not-required" },
  });
}

const capability = "A".repeat(43);

describe("appleDeviceClient", () => {
  it("sends each device request to the route that takes its kind", async () => {
    const fetch = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({ kind: "apple-device-refused", reason: "lease-required" }, { status: 200 }),
    );
    const client = createAppleDeviceClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: capability,
    });
    for (const kind of [
      "discover",
      "status",
      "use-device",
      "release-device",
      "screenshot",
    ] as const) {
      await expect(client.request(deviceRequest(kind))).resolves.toEqual({
        kind: "apple-device-refused",
        reason: "lease-required",
      });
    }
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/apple/devices",
      "/api/apple/devices",
      "/api/apple/device-leases",
      "/api/apple/device-leases",
      "/api/apple/device-actions",
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "x-octant-window-capability": capability },
    });
  });

  it("answers a host it cannot reach or understand with a failure instead of throwing", async () => {
    const unreachable = createAppleDeviceClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => Promise.reject(new TypeError("offline"))),
      windowCapability: capability,
    });
    await expect(unreachable.request(deviceRequest("discover"))).resolves.toMatchObject({
      kind: "apple-device-failure",
      failure: { category: "unavailable" },
    });
    const garbled = createAppleDeviceClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => Response.json({ kind: "something-else" })),
      windowCapability: capability,
    });
    await expect(garbled.request(deviceRequest("discover"))).resolves.toMatchObject({
      kind: "apple-device-failure",
      failure: { category: "invalid" },
    });
  });

  it("reads a device screenshot as PNG bytes and anything else as unavailable", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const read = {
      kind: "apple-artifact-request" as const,
      authority: authority as never,
      threadId: thread.threadId as never,
      checkoutId: thread.checkoutId as never,
      reference: "apple-device-screenshot-1",
    };
    const fetch = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(png, { headers: { "content-type": "image/png" } }),
    );
    const client = createAppleDeviceClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: capability,
    });
    const answer = await client.readScreenshot(read);
    expect(answer.status).toBe("succeeded");
    if (answer.status === "succeeded") {
      expect(new Uint8Array(await answer.blob.arrayBuffer())).toEqual(png);
    }
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(
      "/api/apple/device-screenshots",
    );
    const missing = createAppleDeviceClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        Response.json(
          { kind: "apple-device-failure", failure: { category: "unavailable", message: "x" } },
          { status: 404 },
        ),
      ),
      windowCapability: capability,
    });
    await expect(missing.readScreenshot(read)).resolves.toEqual({
      status: "failed",
      message: "That device screenshot is not available.",
    });
  });
});

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

  it("sends an upload to the distribution route and reads what it would send first", async () => {
    const build = {
      bundleIdentifier: "sh.octant.Fixture",
      version: "1.0",
      buildNumber: "2",
      signing: { teamId: "A1B2C3D4E5", identity: "3".repeat(40) },
      profileId: "81000000-0000-4000-8000-0000000000aa",
    };
    const fetch = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/apple/distribution-preparations"
        ? Response.json({ kind: "prepared", upload: build })
        : Response.json({ kind: "apple-device-refused", reason: "upload-changed" }),
    );
    const client = createAppleDeviceClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: capability,
    });
    await expect(
      client.prepareUpload({
        kind: "apple-upload-preparation",
        authority: authority as never,
        threadId: thread.threadId as never,
        checkoutId: thread.checkoutId as never,
        projectPath: "Fixture.xcodeproj" as never,
        teamId: "A1B2C3D4E5" as never,
      }),
    ).resolves.toEqual({ kind: "prepared", upload: build });
    const { deviceId: _deviceId, ...noDevice } = deviceRequest("discover");
    await expect(
      client.request(
        decodeAppleDeviceRequest({
          ...noDevice,
          kind: "upload",
          projectPath: "Fixture.xcodeproj",
          teamId: "A1B2C3D4E5",
          upload: build,
        }),
      ),
    ).resolves.toEqual({ kind: "apple-device-refused", reason: "upload-changed" });
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/apple/distribution-preparations",
      "/api/apple/distribution",
    ]);
  });

  it("sends a submission or release to the distribution route and reads the version first", async () => {
    const storeVersion = {
      bundleIdentifier: "sh.octant.Fixture",
      version: "1.0",
      buildNumber: "2",
      platform: "ios",
    };
    const fetch = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/apple/distribution-versions"
        ? Response.json({
            kind: "prepared",
            storeVersion,
            ready: "release-version",
            state: "PENDING_DEVELOPER_RELEASE",
          })
        : Response.json({ kind: "apple-device-refused", reason: "store-version-changed" }),
    );
    const client = createAppleDeviceClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: capability,
    });
    await expect(
      client.prepareStoreVersion({
        kind: "apple-store-version-preparation",
        authority: authority as never,
        threadId: thread.threadId as never,
        checkoutId: thread.checkoutId as never,
        projectPath: "Fixture.xcodeproj" as never,
      }),
    ).resolves.toMatchObject({ kind: "prepared", ready: "release-version" });
    const { deviceId: _deviceId, ...noDevice } = deviceRequest("discover");
    for (const kind of ["submit-for-review", "release-version"] as const) {
      await client.request(decodeAppleDeviceRequest({ ...noDevice, kind, storeVersion }));
    }
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/apple/distribution-versions",
      "/api/apple/distribution",
      "/api/apple/distribution",
    ]);
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

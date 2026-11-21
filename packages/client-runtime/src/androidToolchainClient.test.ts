import { decodeAndroidDiscoveryRequest } from "@octant/contracts/android-toolchain";
import { decodeAndroidScreenStreamRequest } from "@octant/contracts/android-toolchain-rpc";
import { describe, expect, it, vi } from "vitest";
import { createAndroidToolchainClient } from "./androidToolchainClient";

const authority = {
  hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
  mode: "code",
  projectId: "80000000-0000-4000-8000-000000000001",
  providerInstanceId: "80000000-0000-4000-8000-000000000002",
  extension: { kind: "core" },
} as const;
const request = decodeAndroidDiscoveryRequest({
  actionId: "80000000-0000-4000-8000-000000000003",
  correlationId: "80000000-0000-4000-8000-000000000004",
  authority,
  threadId: "80000000-0000-4000-8000-000000000005",
  checkoutId: "80000000-0000-4000-8000-000000000006",
});

const watchRequest = decodeAndroidScreenStreamRequest({
  kind: "android-screen-stream-request",
  authority,
  threadId: request.threadId,
  checkoutId: request.checkoutId,
  emulatorId: "Pixel_8_API_34",
});

describe("androidToolchainClient", () => {
  it("sends normalized discovery and decodes the shared snapshot", async () => {
    const response = {
      kind: "android-discovery-snapshot",
      snapshot: {
        sdk: {
          sdkId: "80000000-0000-4000-8000-000000000007",
          available: true,
          discoveredAt: "2026-09-20T20:00:00.000Z",
        },
        emulators: [],
      },
    };
    const fetch = vi.fn(async () => Response.json(response));
    const client = createAndroidToolchainClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "A".repeat(43),
    });
    await expect(client.discover(request)).resolves.toEqual(response.snapshot);
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/android/toolchain"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "android-discovery-request",
          request,
        }),
      }),
    );
  });

  it("yields each whole PNG frame from a length-prefixed stream", async () => {
    const chunked = (...chunks: ReadonlyArray<ReadonlyArray<number>>) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
          controller.close();
        },
      });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(chunked([0, 0], [0, 3, 1, 2], [3, 0, 0, 0, 2, 4], [5, 0, 0]), {
          status: 200,
          headers: { "x-octant-simulator-screen": "1080x2400" },
        }),
    );
    const client = createAndroidToolchainClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "A".repeat(43),
    });
    const watch = await client.watchScreen(watchRequest);
    expect(watch.status).toBe("watching");
    if (watch.status !== "watching") return;
    expect(watch.screen).toEqual({ width: 1080, height: 2400 });
    const frames: number[][] = [];
    for await (const frame of watch.frames) frames.push([...frame]);
    expect(frames).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/android/screen-stream"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("says whether the frames are the live stream or screencap snapshots, and why", async () => {
    const watchWith = async (transport: string | undefined) => {
      const headers: Record<string, string> = { "x-octant-simulator-screen": "1080x2400" };
      if (transport !== undefined) headers["x-octant-android-transport"] = transport;
      const client = createAndroidToolchainClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch: vi.fn(async () => new Response(new Uint8Array(), { status: 200, headers })),
        windowCapability: "A".repeat(43),
      });
      const watch = await client.watchScreen(watchRequest);
      if (watch.status !== "watching") throw new Error("expected a watch");
      return watch.transport;
    };
    await expect(watchWith('{"kind":"stream"}')).resolves.toEqual({ kind: "stream" });
    await expect(watchWith('{"kind":"screencap","reason":"tool-missing"}')).resolves.toEqual({
      kind: "screencap",
      reason: "tool-missing",
    });
    await expect(watchWith('{"kind":"screencap","reason":"guess"}')).resolves.toBeUndefined();
    await expect(watchWith(undefined)).resolves.toBeUndefined();
  });
});

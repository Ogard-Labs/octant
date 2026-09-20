import type { AndroidDiscoveryRequest } from "@octant/contracts/android-toolchain";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createAndroidToolchainClient: (options: Record<string, unknown>) => {
  discover(request: AndroidDiscoveryRequest, signal?: AbortSignal): Promise<any>;
  snapshot(request: unknown): Promise<any>;
  watchScreen(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly status: "watching";
        readonly screen: { readonly width: number; readonly height: number };
        readonly frames: AsyncIterable<Uint8Array>;
      }
    | { readonly status: "failed"; readonly kind: string; readonly message: string }
  >;
};

beforeAll(async () => {
  const loaded = await import("./androidToolchainClient");
  expect(loaded.createAndroidToolchainClient).toBeTypeOf("function");
  createAndroidToolchainClient = loaded.createAndroidToolchainClient;
});

const authority = {
  hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
  mode: "code",
  projectId: "80000000-0000-4000-8000-000000000001",
  providerInstanceId: "80000000-0000-4000-8000-000000000002",
  extension: { kind: "core" },
} as const;
const request: AndroidDiscoveryRequest = {
  actionId: "80000000-0000-4000-8000-000000000003" as never,
  correlationId: "80000000-0000-4000-8000-000000000004" as never,
  authority: authority as never,
  threadId: "80000000-0000-4000-8000-000000000005" as never,
  checkoutId: "80000000-0000-4000-8000-000000000006" as never,
};

const watchRequest = {
  kind: "android-screen-stream-request",
  authority,
  threadId: request.threadId,
  checkoutId: request.checkoutId,
  emulatorId: "Pixel_8_API_34",
};

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
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:13773/api/android/toolchain");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "android-discovery-request",
      request,
    });
  });

  it("yields each whole PNG frame from a length-prefixed stream", async () => {
    const chunked = (...chunks: ReadonlyArray<ReadonlyArray<number>>) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
          controller.close();
        },
      });
    const fetch = vi.fn(
      async (_url: URL, _init?: RequestInit) =>
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
    const [url] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:13773/api/android/screen-stream");
  });
});

import type { AppleDiscoveryRequest } from "@octant/contracts/apple-toolchain";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createAppleToolchainClient: (options: Record<string, unknown>) => {
  discover(request: AppleDiscoveryRequest, signal?: AbortSignal): Promise<any>;
  snapshot(request: unknown): Promise<any>;
  readScreenshot(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "succeeded"; readonly blob: Blob }
    | { readonly status: "failed"; readonly kind: string; readonly message: string }
  >;
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
  const path = "./appleToolchainClient";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.createAppleToolchainClient).toBeTypeOf("function");
  createAppleToolchainClient = loaded!.createAppleToolchainClient;
});

const authority = {
  hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
  mode: "code",
  projectId: "80000000-0000-4000-8000-000000000001",
  providerInstanceId: "80000000-0000-4000-8000-000000000002",
  extension: { kind: "core" },
} as const;
const request: AppleDiscoveryRequest = {
  actionId: "80000000-0000-4000-8000-000000000003" as never,
  correlationId: "80000000-0000-4000-8000-000000000004" as never,
  authority: authority as never,
  threadId: "80000000-0000-4000-8000-000000000005" as never,
  checkoutId: "80000000-0000-4000-8000-000000000006" as never,
  projectPath: "Fixture.xcodeproj",
};

describe("appleToolchainClient", () => {
  it("sends normalized discovery and decodes the shared snapshot", async () => {
    const response = {
      kind: "apple-discovery-snapshot",
      snapshot: {
        toolchain: {
          toolchainId: "80000000-0000-4000-8000-000000000007",
          available: true,
          sdks: [],
          discoveredAt: "2026-07-27T20:00:00.000Z",
        },
        workspace: {
          actionId: request.actionId,
          correlationId: request.correlationId,
          authority,
          projectPath: request.projectPath,
          projectKind: "xcode-project",
          schemes: ["Fixture"],
          configurations: ["Debug"],
          targets: ["Fixture"],
          sourceRevision: "a".repeat(40),
          discoveredAt: "2026-07-27T20:00:00.000Z",
        },
        simulators: [],
      },
    };
    const fetch = vi.fn(async () => Response.json(response));
    const client = createAppleToolchainClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "A".repeat(43),
    });
    await expect(client.discover(request)).resolves.toMatchObject({
      workspace: { schemes: ["Fixture"] },
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/apple/toolchain"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-octant-window-capability": "A".repeat(43),
        }),
      }),
    );
  });

  it("keeps interruption and protocol failure distinct", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createAppleToolchainClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
      windowCapability: "A".repeat(43),
    });
    await expect(client.discover(request, controller.signal)).rejects.toMatchObject({
      category: "interrupted",
    });
  });

  it("returns an explicit screenshot failure when host evidence is unavailable", async () => {
    const client = createAppleToolchainClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        Response.json(
          {
            kind: "apple-failure",
            failure: { category: "unavailable", message: "Screenshot evidence is unavailable." },
          },
          { status: 404 },
        ),
      ),
      windowCapability: "A".repeat(43),
    });
    await expect(
      client.readScreenshot({
        kind: "apple-artifact-request",
        authority: request.authority,
        threadId: request.threadId,
        checkoutId: request.checkoutId,
        reference: "apple-screenshot-missing",
      }),
    ).resolves.toEqual({
      status: "failed",
      kind: "unavailable",
      message: "Screenshot evidence is unavailable.",
    });
  });

  it("returns an explicit failure when screenshot body streaming fails", async () => {
    const client = createAppleToolchainClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: vi.fn(async () => Promise.reject(new TypeError("stream failed"))),
      })),
      windowCapability: "A".repeat(43),
    });

    await expect(
      client.readScreenshot({
        kind: "apple-artifact-request",
        authority: request.authority,
        threadId: request.threadId,
        checkoutId: request.checkoutId,
        reference: "apple-screenshot-stream-failed",
      }),
    ).resolves.toEqual({
      status: "failed",
      kind: "unavailable",
      message: "Apple screenshot bytes are unavailable.",
    });
  });

  it("reads a host-held screenshot as image bytes instead of a JSON envelope", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetch = vi.fn(
      async () => new Response(png, { headers: { "content-type": "image/png" } }),
    );
    const client = createAppleToolchainClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "A".repeat(43),
    });
    const result = await client.readScreenshot({
      kind: "apple-artifact-request",
      authority: request.authority,
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      reference: "apple-screenshot-1",
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("Expected screenshot bytes");
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(png);
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/apple/artifacts"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  describe("watching a Simulator's screen", () => {
    const watchRequest = {
      kind: "apple-screen-stream-request",
      authority,
      threadId: request.threadId,
      checkoutId: request.checkoutId,
      simulatorId: "7E29846E-F920-438E-8AB2-930C1A0F7FB7",
    };
    const chunked = (...chunks: ReadonlyArray<ReadonlyArray<number>>) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
          controller.close();
        },
      });

    it("yields each whole frame, however the bytes were split on the way", async () => {
      const fetch = vi.fn(
        async (_url: URL, _init?: RequestInit) =>
          new Response(
            chunked([0, 0], [0, 3, 0xff, 0xd8], [0xd9, 0, 0, 0, 2, 0xff], [0xd9, 0, 0]),
            { status: 200, headers: { "x-octant-simulator-screen": "1206x2622" } },
          ),
      );
      const client = createAppleToolchainClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch,
        windowCapability: "A".repeat(43),
      });

      const watch = await client.watchScreen(watchRequest);

      expect(watch.status).toBe("watching");
      if (watch.status !== "watching") return;
      expect(watch.screen).toEqual({ width: 1206, height: 2622 });
      const frames: number[][] = [];
      for await (const frame of watch.frames) frames.push([...frame]);
      // The trailing two bytes are half a header: the stream ended, no frame.
      expect(frames).toEqual([
        [0xff, 0xd8, 0xd9],
        [0xff, 0xd9],
      ]);
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toBe("http://127.0.0.1:13773/api/apple/screen-stream");
      expect(JSON.parse(String(init?.body))).toEqual(watchRequest);
    });

    it("answers at once when a stream opens without saying how big the screen is", async () => {
      const cancelled = vi.fn();
      // The body never ends, as a live stream's does not.
      const open = new ReadableStream<Uint8Array>({ cancel: cancelled });
      const client = createAppleToolchainClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch: vi.fn(async () => new Response(open, { status: 200 })),
        windowCapability: "A".repeat(43),
      });

      const answer = await Promise.race([
        client.watchScreen(watchRequest),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 200)),
      ]);

      expect(answer).toEqual({
        status: "failed",
        kind: "protocol",
        message: "Apple toolchain service returned an invalid response.",
      });
      expect(cancelled).toHaveBeenCalled();
    });

    it("reports the host's reason when there is no live view", async () => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            kind: "apple-failure",
            failure: { category: "unavailable", message: "not-booted: the Simulator is Shutdown" },
          },
          { status: 409 },
        ),
      );
      const client = createAppleToolchainClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch,
        windowCapability: "A".repeat(43),
      });

      await expect(client.watchScreen(watchRequest)).resolves.toEqual({
        status: "failed",
        kind: "unavailable",
        message: "not-booted: the Simulator is Shutdown",
      });
    });

    it("refuses a frame longer than any screen could be instead of buffering it", async () => {
      const fetch = vi.fn(
        async () =>
          new Response(chunked([0x7f, 0xff, 0xff, 0xff, 1, 2, 3]), {
            status: 200,
            headers: { "x-octant-simulator-screen": "1206x2622" },
          }),
      );
      const client = createAppleToolchainClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch,
        windowCapability: "A".repeat(43),
      });

      const watch = await client.watchScreen(watchRequest);
      if (watch.status !== "watching") throw new Error("expected a stream");
      const frames: Uint8Array[] = [];
      for await (const frame of watch.frames) frames.push(frame);
      expect(frames).toEqual([]);
    });
  });
});

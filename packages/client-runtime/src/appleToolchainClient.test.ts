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
});

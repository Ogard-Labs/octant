import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodePreviewHostId,
  decodePreviewTargetId,
  decodePreviewSourceVersion,
  type PreviewTarget,
} from "@octant/contracts/previews";
import { decodeProjectId } from "@octant/contracts/projects";
import { PreviewClientFailure, createPreviewClient } from "./previewClient";

const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111");
const projectId = decodeProjectId("22222222-2222-4222-8222-222222222222");
const hostId = decodePreviewHostId("33333333-3333-4333-8333-333333333333");

function makeTarget(): PreviewTarget {
  return {
    targetId,
    projectId,
    hostId,
    kind: "file",
    opaqueRef: "opaque-token-1" as never,
    displayName: "notes.md",
  } as PreviewTarget;
}

function makeFetch(responses: Array<(body: unknown) => Response>) {
  let calls = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    void url;
    void init;
    const responder = responses[calls] ?? responses.at(-1);
    if (responder === undefined) throw new Error("no fetch responder configured");
    calls += 1;
    return responder(typeof init?.body === "string" ? JSON.parse(init.body) : {});
  });
  return fetch;
}

function manifestBody() {
  return {
    kind: "ready",
    manifest: {
      target: makeTarget(),
      kind: "markdown",
      sourceVersion: {
        contentSha256: "0".repeat(64),
        byteSize: 12,
        observedAt: "2026-07-22T08:00:00.000Z",
      },
      byteSize: 12,
      fidelity: { level: "full" },
      capabilities: {
        canSearch: false,
        canSelect: true,
        canZoom: false,
        canRevealInFinder: false,
        canOpenExternally: false,
        canQuickLook: false,
        canEditInMonaco: false,
      },
      sniffedMediaType: "text/markdown",
      bounds: {},
      producedAt: "2026-07-22T08:00:00.000Z",
    },
  };
}

describe("PreviewClient", () => {
  it("posts an open request and decodes a ready outcome", async () => {
    const fetch = makeFetch([
      () =>
        new Response(JSON.stringify(manifestBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const client = createPreviewClient({
      baseUrl: "http://127.0.0.1:9999",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });
    const outcome = await client.open(makeTarget());
    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.manifest.kind).toBe("markdown");
    }
    expect(fetch).toHaveBeenCalledOnce();
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe("cap");
  });

  it("posts a chunks request with maxChunks and decodes the reply", async () => {
    const fetch = makeFetch([
      () =>
        new Response(
          JSON.stringify({
            kind: "chunks",
            chunks: [
              {
                chunkId: "66666666-6666-4666-8666-666666666666",
                targetId,
                sourceVersion: {
                  contentSha256: "0".repeat(64),
                  byteSize: 12,
                  observedAt: "2026-07-22T08:00:00.000Z",
                },
                kind: "text",
                sequence: 0,
                descriptor: { kind: "text", startLine: 1, endLine: 1 },
                payload: { kind: "text", text: "hello", encoding: "utf-8" },
                isFinal: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ]);
    const client = createPreviewClient({
      baseUrl: "http://127.0.0.1:9999",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
      maxChunksPerPage: 4,
    });
    const reply = await client.readChunks(
      makeTarget(),
      decodePreviewSourceVersion({
        contentSha256: "0".repeat(64),
        byteSize: 12,
        observedAt: "2026-07-22T08:00:00.000Z",
      }),
      0,
    );
    expect(reply.kind).toBe("chunks");
    if (reply.kind === "chunks") {
      expect(reply.chunks).toHaveLength(1);
    }
    const body = JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.maxChunks).toBe(4);
  });

  it("posts a cancel request and decodes the reply", async () => {
    const fetch = makeFetch([
      () =>
        new Response(JSON.stringify({ kind: "cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const client = createPreviewClient({
      baseUrl: "http://127.0.0.1:9999",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });
    const reply = await client.cancel(makeTarget());
    expect(reply).toEqual({ kind: "cancelled" });
  });

  it("posts a refresh request and decodes a stale outcome", async () => {
    const fetch = makeFetch([
      () =>
        new Response(
          JSON.stringify({
            kind: "stale",
            target: makeTarget(),
            knownVersion: {
              contentSha256: "0".repeat(64),
              byteSize: 12,
              observedAt: "2026-07-22T08:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ]);
    const client = createPreviewClient({
      baseUrl: "http://127.0.0.1:9999",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });
    const outcome = await client.refresh(
      makeTarget(),
      decodePreviewSourceVersion({
        contentSha256: "0".repeat(64),
        byteSize: 12,
        observedAt: "2026-07-22T08:00:00.000Z",
      }),
    );
    expect(outcome.kind).toBe("stale");
  });

  it("throws PreviewClientFailure with status 0 when fetch rejects", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = createPreviewClient({
      baseUrl: "http://127.0.0.1:9999",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });
    await expect(client.open(makeTarget())).rejects.toMatchObject({
      name: "PreviewClientFailure",
      status: 0,
    });
  });

  it("throws PreviewClientFailure with the server status on a non-ok response", async () => {
    const fetch = makeFetch([
      () =>
        new Response(JSON.stringify({ message: "Preview request is unauthorized." }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const client = createPreviewClient({
      baseUrl: "http://127.0.0.1:9999",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });
    await expect(client.open(makeTarget())).rejects.toMatchObject({
      name: "PreviewClientFailure",
      status: 401,
    });
  });

  it("rejects a non-loopback base URL at construction", () => {
    expect(() =>
      createPreviewClient({
        baseUrl: "http://example.com",
        fetch: globalThis.fetch,
        windowCapability: "cap",
      }),
    ).toThrow(PreviewClientFailure);
  });
});

describe("PreviewClient transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards an abort signal to fetch for chunk reads", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) {
        return new Response(JSON.stringify({ kind: "chunks", chunks: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    const client = createPreviewClient({
      baseUrl: "http://127.0.0.1:9999",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });
    const controller = new AbortController();
    controller.abort();
    await client.readChunks(
      makeTarget(),
      decodePreviewSourceVersion({
        contentSha256: "0".repeat(64),
        byteSize: 12,
        observedAt: "2026-07-22T08:00:00.000Z",
      }),
      0,
      controller.signal,
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });
});

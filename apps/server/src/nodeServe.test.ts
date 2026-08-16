import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CODE_FILE_BODY_SIZE,
  MAX_JSON_REQUEST_BODY_SIZE,
  type RequestTransportFacts,
} from "./server";
import { deriveTransportFactsFromPeer } from "./remoteRequestFacts";
import { nodeServe } from "./nodeServe";
import {
  createRemoteAdmissionPolicy,
  createRemoteBoundaryFetch,
} from "./remote/remoteAdmissionPolicy";

interface RawResponse {
  readonly body: string;
  readonly status: number | undefined;
}

function rawRequest(
  url: URL,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly chunks?: readonly string[];
    readonly method?: "GET" | "HEAD" | "POST";
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method: options.method ?? "POST", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks).toString("utf8"), status: response.statusCode }),
        );
      },
    );
    outgoing.on("error", reject);
    for (const chunk of options.chunks ?? []) outgoing.write(chunk);
    outgoing.end();
  });
}

describe("nodeServe", () => {
  it("bridges Node requests and responses through the Fetch handler", async () => {
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) =>
        Response.json(
          {
            body: await request.text(),
            header: request.headers.get("x-octant-test"),
            method: request.method,
            pathname: new URL(request.url).pathname,
          },
          { status: 201, headers: { "x-octant-runtime": "node" } },
        ),
    });

    try {
      const response = await fetch(new URL("/bridge", server.url), {
        method: "POST",
        headers: { "x-octant-test": "present" },
        body: "payload",
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("x-octant-runtime")).toBe("node");
      expect(await response.json()).toEqual({
        body: "payload",
        header: "present",
        method: "POST",
        pathname: "/bridge",
      });
    } finally {
      await server.stop(true);
    }

    await expect(fetch(server.url)).rejects.toThrow();
  });

  it("rejects an oversized declared request before invoking the Fetch handler", async () => {
    const handler = vi.fn(() => new Response("unreachable"));
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 4,
      fetch: handler,
    });

    try {
      const response = await rawRequest(new URL("/declared", server.url), {
        headers: { "content-length": "5" },
      });

      expect(response).toEqual({ body: "Request body too large", status: 413 });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await server.stop(true);
    }
  });

  it("stops buffering and rejects an oversized chunked request", async () => {
    const handler = vi.fn(() => new Response("unreachable"));
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 4,
      fetch: handler,
    });

    try {
      const response = await rawRequest(new URL("/chunked", server.url), {
        chunks: ["1234", "5"],
      });

      expect(response).toEqual({ body: "Request body too large", status: 413 });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await server.stop(true);
    }
  });

  it.each(["GET", "HEAD"] as const)(
    "rejects an oversized declared %s body before invoking the Fetch handler",
    async (method) => {
      const handler = vi.fn(() => new Response(null, { status: 204 }));
      const server = await nodeServe({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: 4,
        fetch: handler,
      });

      try {
        const response = await rawRequest(new URL("/declared", server.url), {
          method,
          headers: { "content-length": "5" },
        });

        expect(response.status).toBe(413);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await server.stop(true);
      }
    },
  );

  it.each(["GET", "HEAD"] as const)(
    "rejects an oversized chunked %s body before invoking the Fetch handler",
    async (method) => {
      const handler = vi.fn(() => new Response(null, { status: 204 }));
      const server = await nodeServe({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: 4,
        fetch: handler,
      });

      try {
        const response = await rawRequest(new URL("/chunked", server.url), {
          method,
          headers: { "transfer-encoding": "chunked" },
          chunks: ["1234", "5"],
        });

        expect(response.status).toBe(413);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await server.stop(true);
      }
    },
  );

  it.each(["GET", "HEAD"] as const)("dispatches a bodyless %s request safely", async (method) => {
    const handler = vi.fn((request: Request) => {
      expect(request.body).toBeNull();
      return new Response(null, { status: 204 });
    });
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 4,
      fetch: handler,
    });

    try {
      const response = await rawRequest(new URL("/safe", server.url), { method });

      expect(response.status).toBe(204);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ method });
    } finally {
      await server.stop(true);
    }
  });

  it("defaults the outer transport ceiling above the JSON route limit", async () => {
    const payload = "x".repeat(1_100_000);
    const handler = vi.fn(() => new Response("ok"));
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: handler,
    });

    try {
      const response = await fetch(new URL("/attachment", server.url), {
        method: "POST",
        body: payload,
      });
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await server.stop(true);
    }

    const jsonLimited = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      fetch: vi.fn(() => new Response("unreachable")),
    });

    try {
      const rejected = await rawRequest(new URL("/attachment", jsonLimited.url), {
        headers: { "content-length": String(Buffer.byteLength(payload, "utf8")) },
      });
      expect(rejected.status).toBe(413);
    } finally {
      await jsonLimited.stop(true);
    }

    expect(MAX_CHAT_ATTACHMENT_BYTES).toBeGreaterThan(MAX_JSON_REQUEST_BODY_SIZE);
  });

  it("admits the inclusive Code save ceiling without reducing the Chat attachment ceiling", async () => {
    const handler = vi.fn(async (request: Request) =>
      Response.json({ byteLength: (await request.arrayBuffer()).byteLength }),
    );
    const server = await nodeServe({ hostname: "127.0.0.1", port: 0, fetch: handler });

    try {
      const response = await fetch(new URL("/api/code/files/content", server.url), {
        method: "PUT",
        body: new Uint8Array(MAX_CODE_FILE_BODY_SIZE),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ byteLength: MAX_CODE_FILE_BODY_SIZE });
      expect(handler).toHaveBeenCalledOnce();
      expect(MAX_CHAT_ATTACHMENT_BYTES).toBeGreaterThan(MAX_CODE_FILE_BODY_SIZE);
    } finally {
      await server.stop(true);
    }
  });

  it("streams response bodies with backpressure instead of buffering", async () => {
    let releaseSecondChunk: (() => void) | undefined;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("chunk-1"));
              await secondChunkGate;
              controller.enqueue(new TextEncoder().encode("chunk-2"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
    });

    try {
      const response = await fetch(new URL("/stream", server.url));
      const reader = response.body?.getReader();
      const first = await reader!.read();
      expect(new TextDecoder().decode(first.value)).toBe("chunk-1");
      releaseSecondChunk?.();
      const second = await reader!.read();
      expect(new TextDecoder().decode(second.value)).toBe("chunk-2");
    } finally {
      await server.stop(true);
    }
  });

  it("stops cleanly while a response stream is waiting on drain", async () => {
    let releaseSecondChunk: (() => void) | undefined;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(256 * 1024)));
              await secondChunkGate;
              controller.enqueue(new TextEncoder().encode("tail"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
    });

    try {
      const responsePromise = fetch(new URL("/drain-stop", server.url));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(server.stop(true)).resolves.toBeUndefined();
      releaseSecondChunk?.();
      await responsePromise.catch(() => undefined);
    } finally {
      await server.stop(true);
    }
  });

  it("cancels active response readers when the server stops", async () => {
    let readerCancelled = false;
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              readerCancelled = true;
            },
          }),
          { status: 200 },
        ),
    });

    try {
      const responsePromise = fetch(new URL("/cancel", server.url));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await server.stop(true);
      await responsePromise.catch(() => undefined);
      expect(readerCancelled).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  it("keeps active response ownership isolated between server instances", async () => {
    let firstCancelled = false;
    let secondCancelled = false;
    const makeStream = (cancelled: () => void) =>
      new ReadableStream<Uint8Array>({
        async pull() {
          await new Promise(() => undefined);
        },
        cancel: cancelled,
      });
    const first = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(makeStream(() => (firstCancelled = true))),
    });
    const second = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(makeStream(() => (secondCancelled = true))),
    });

    try {
      const firstResponse = fetch(new URL("/owned", first.url));
      const secondResponse = fetch(new URL("/owned", second.url));
      await new Promise((resolve) => setTimeout(resolve, 25));

      await first.stop(true);
      await firstResponse.catch(() => undefined);
      expect(firstCancelled).toBe(true);
      expect(secondCancelled).toBe(false);

      await second.stop(true);
      await secondResponse.catch(() => undefined);
      expect(secondCancelled).toBe(true);
    } finally {
      await first.stop(true);
      await second.stop(true);
    }
  });

  it("derives loopback request facts from the accepted socket and forwards them", async () => {
    const captured: RequestTransportFacts[] = [];
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, facts) => {
        captured.push(facts!);
        return new Response(null, { status: 204 });
      },
    });

    try {
      await fetch(new URL("/facts", server.url));
    } finally {
      await server.stop(true);
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      listenerTrust: "loopback",
      sourceClass: "loopback",
    });
    expect(captured[0]?.sourceKey).toHaveLength(64);
  });

  it("derives remote listener facts when listenerTrust is remote", async () => {
    const captured: RequestTransportFacts[] = [];
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      listenerTrust: "remote",
      fetch: (request, facts) => {
        captured.push(facts!);
        return new Response(null, { status: 204 });
      },
    });

    try {
      await fetch(new URL("/facts", server.url));
    } finally {
      await server.stop(true);
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]?.listenerTrust).toBe("remote");
    // Loopback peer over a remote-classified listener still classifies as loopback.
    expect(captured[0]?.sourceClass).toBe("loopback");
  });

  it("ignores forwarded identity headers when deriving trusted facts", async () => {
    const expected = deriveTransportFactsFromPeer({
      peerAddress: "127.0.0.1",
      listenerTrust: "loopback",
    });
    const captured: RequestTransportFacts[] = [];
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (_request, facts) => {
        captured.push(facts!);
        return new Response(null, { status: 204 });
      },
    });

    try {
      await fetch(new URL("/facts", server.url), {
        headers: {
          "x-forwarded-for": "8.8.8.8",
          "x-real-ip": "8.8.8.8",
          forwarded: "for=8.8.8.8",
          "x-forwarded-client-cert": "spki=abc",
        },
      });
    } finally {
      await server.stop(true);
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]?.sourceKey).toBe(expected.sourceKey);
    expect(captured[0]?.sourceClass).toBe("loopback");
  });

  it("HEAD requests cannot pin all 32 product concurrency slots", async () => {
    // This is an end-to-end regression: a handler that returns a non-null body
    // for a HEAD request must not leak the response body reader or hold the
    // admission slot. The nodeServe bridge must cancel/destroy the unused body.
    const admission = createRemoteAdmissionPolicy({
      limits: { productConcurrentPerListener: 32 },
    });
    const boundary = createRemoteBoundaryFetch({
      // Handler returns a streaming body even for HEAD (a misbehaving handler).
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("body-that-head-discards"));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      admission,
    });
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      listenerTrust: "remote",
      fetch: boundary,
    });

    try {
      // Fire 40 HEAD requests (more than the 32-slot limit).
      for (let i = 0; i < 40; i++) {
        const response = await fetch(new URL(`/api/chat/head-${i}`, server.url), {
          method: "HEAD",
        });
        expect(response.status).toBe(200);
      }
      // If HEAD leaked bodies, admission would be pinned at 32 and subsequent
      // requests would get 429. A GET should still be admitted.
      const getResponse = await fetch(new URL("/api/chat/after-head", server.url), {
        method: "GET",
      });
      expect(getResponse.status).toBe(200);
      expect(admission.counts().productConcurrentListener).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  it("normalizes IPv4-mapped dual-stack peer addresses to plain IPv4", async () => {
    // On a dual-stack :: listener, Node reports peer addresses as ::ffff:127.0.0.1.
    // The facts derivation must strip the mapped prefix so Node and Bun agree.
    // This test binds on :: (IPv6 dual-stack) and connects from 127.0.0.1.
    const captured: RequestTransportFacts[] = [];
    let server: Awaited<ReturnType<typeof nodeServe>> | undefined;
    let dualStackSupported = true;
    try {
      server = await nodeServe({
        hostname: "::",
        port: 0,
        fetch: (_request, facts) => {
          captured.push(facts!);
          return new Response(null, { status: 204 });
        },
      });
    } catch {
      // Some environments don't support dual-stack :: binding; skip gracefully.
      dualStackSupported = false;
    }

    if (!dualStackSupported || server === undefined) {
      // Record the exact skip reason so a silently-broken dual-stack path is visible.
      console.log(
        "[nodeServe dual-stack smoke] skipped: :: bind not supported in this environment",
      );
      return;
    }

    try {
      // Once the server exists, fetch/handler/assertion failures must fail the test.
      await fetch(new URL("/dual-stack", server.url));
      expect(captured).toHaveLength(1);
      // The peer must be classified as loopback (not unknown) despite the
      // ::ffff: prefix.
      expect(captured[0]?.sourceClass).toBe("loopback");
      expect(captured[0]?.sourceKey).toHaveLength(64);
    } finally {
      await server.stop(true);
    }
  });
});

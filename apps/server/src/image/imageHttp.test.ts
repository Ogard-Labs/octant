import { MAX_GENERATED_IMAGE_BYTES, MAX_IMAGE_VARIANTS } from "@octant/contracts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  fetchApprovedImageUrl,
  makeImageGenerationPorts,
  makePinnedImageFetch,
  type ImageHttpFetch,
} from "./imageHttp";

const APPROVED_URL = "https://provider.example/signed/generated.png?token=secret";
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function call(fetch: ImageHttpFetch, overrides: { maxBytes?: number; timeoutMs?: number } = {}) {
  return fetchApprovedImageUrl({
    url: APPROVED_URL,
    fetch,
    maxBytes: overrides.maxBytes ?? 1_000_000,
    timeoutMs: overrides.timeoutMs ?? 5_000,
  });
}

describe("fetchApprovedImageUrl", () => {
  it("performs exactly one GET and returns raw bytes on success", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe(APPROVED_URL);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response(png, { status: 200 });
    });

    const result = await call(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("failure");
    if ("bytes" in result) {
      expect(Buffer.from(result.bytes).equals(Buffer.from(png))).toBe(true);
    }
  });

  it("rejects a redirect instead of following it", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } }),
    );

    const result = await call(fetch);
    expect(result).toHaveProperty("failure");
    if ("failure" in result) {
      expect(result.failure.category).toBe("protocol");
      expect(JSON.stringify(result.failure)).not.toContain("elsewhere.example");
    }
  });

  it("rejects a non-2xx response", async () => {
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));

    const result = await call(fetch);
    expect(result).toHaveProperty("failure");
    if ("failure" in result) expect(result.failure.category).toBe("provider-failed");
  });

  it("rejects an oversized response declared via content-length before buffering", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(png, {
          status: 200,
          headers: { "content-length": String(40_000_000) },
        }),
    );

    const result = await call(fetch, { maxBytes: 1_000 });
    expect(result).toHaveProperty("failure");
    if ("failure" in result) expect(result.failure.category).toBe("protocol");
  });

  it("rejects a response that exceeds the byte limit while streaming", async () => {
    const oversized = new Uint8Array(2_000).fill(1);
    const fetch = vi.fn(async () => new Response(oversized, { status: 200 }));

    const result = await call(fetch, { maxBytes: 100 });
    expect(result).toHaveProperty("failure");
    if ("failure" in result) expect(result.failure.category).toBe("protocol");
  });

  it("times out a hanging request", async () => {
    const fetch = vi.fn(async () => new Promise<Response>(() => undefined));

    const result = await call(fetch, { timeoutMs: 20 });
    expect(result).toHaveProperty("failure");
    if ("failure" in result) {
      expect(result.failure.category).toBe("unavailable");
      expect(result.failure.message).toContain("timed out");
    }
  });

  it("cancels a hanging request via AbortSignal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const pending = fetchApprovedImageUrl({
      url: APPROVED_URL,
      fetch,
      maxBytes: 1_000_000,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result).toHaveProperty("failure");
    if ("failure" in result) expect(result.failure.category).toBe("interrupted");
  });

  it("returns the interrupted failure immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => new Response(png, { status: 200 }));

    const result = await fetchApprovedImageUrl({
      url: APPROVED_URL,
      fetch,
      maxBytes: 1_000_000,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toHaveProperty("failure");
    if ("failure" in result) expect(result.failure.category).toBe("interrupted");
  });
});

describe("image generation ports", () => {
  it("accepts a base64 answer for every variant at the image ceiling", async () => {
    const base64Bytes = 4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * MAX_IMAGE_VARIANTS;
    const fetch = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-length": String(base64Bytes) } }),
    );
    const ports = makeImageGenerationPorts({
      instanceId: "a1000000-0000-4000-8000-000000000001",
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      endpoint: { providerHosts: ["images.example.test"] },
      fetch,
    });

    const response = await ports.request({
      url: "https://images.example.test/v1/generate",
      method: "POST",
      auth: { header: "authorization", scheme: "Bearer" },
      body: "{}",
    });

    expect(response.status).toBe(200);
  });
});

describe("the pinned approved-image transport", () => {
  const fetchWith = (fetch: ImageHttpFetch, url: string) =>
    fetchApprovedImageUrl({ url, fetch, maxBytes: 1_000_000, timeoutMs: 5_000 });

  it("refuses a name whose answer at connect time is private, without opening a connection", async () => {
    const resolveAll = vi.fn(async () => ["10.0.0.7"]);
    const result = await fetchWith(
      makePinnedImageFetch({ resolveAll }),
      "https://cdn.provider.example/out.png",
    );
    expect(result).toMatchObject({ failure: { category: "unavailable" } });
    expect(resolveAll).toHaveBeenCalledWith("cdn.provider.example");
  });

  it("refuses a literal private address and any address beside a private one", async () => {
    const literal = await fetchWith(makePinnedImageFetch(), "https://10.0.0.7/out.png");
    expect("failure" in literal).toBe(true);
    const mixed = await fetchWith(
      makePinnedImageFetch({ resolveAll: async () => ["93.184.216.34", "127.0.0.1"] }),
      "https://cdn.provider.example/out.png",
    );
    expect("failure" in mixed).toBe(true);
  });

  it("connects to the address it checked, sending the original name as Host, and allows the profile's own configured origin", async () => {
    const hosts: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host);
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from(png));
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    try {
      const port = (server.address() as AddressInfo).port;
      const origin = `http://images.proxy.test:${port}`;
      const resolveAll = vi.fn(async () => ["127.0.0.1"]);
      const allowed = await fetchWith(
        makePinnedImageFetch({ resolveAll, allowedOrigin: origin }),
        `${origin}/out.png`,
      );
      expect(allowed).toEqual({ bytes: png });
      expect(hosts).toEqual([`images.proxy.test:${port}`]);
      // The same loopback answer for any other origin is refused.
      const refused = await fetchWith(
        makePinnedImageFetch({ resolveAll }),
        `http://images.proxy.test:${port}/out.png`,
      );
      expect("failure" in refused).toBe(true);
      expect(hosts).toHaveLength(1);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("handles HTTP 205 without throwing outside the promise or crashing the host", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(205);
      response.end();
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    try {
      const port = (server.address() as AddressInfo).port;
      const origin = `http://images.proxy.test:${port}`;
      const result = await fetchWith(
        makePinnedImageFetch({ resolveAll: async () => ["127.0.0.1"], allowedOrigin: origin }),
        `${origin}/reset.png`,
      );
      expect(result).toEqual({ bytes: new Uint8Array() });
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("decodes gzip responses and enforces maxBytes on decoded bytes", async () => {
    const gzippedPng = gzipSync(Buffer.from(png));
    const gzippedLarge = gzipSync(Buffer.alloc(10_000, 0x41));
    expect(gzippedLarge.byteLength).toBeLessThan(200);
    const server = createServer((request, response) => {
      if (request.url === "/gzip.png") {
        response.writeHead(200, {
          "content-type": "image/png",
          "content-encoding": "gzip",
          "content-length": String(gzippedPng.byteLength),
        });
        response.end(gzippedPng);
        return;
      }
      if (request.url === "/bomb.png") {
        response.writeHead(200, {
          "content-type": "image/png",
          "content-encoding": "gzip",
          "content-length": String(gzippedLarge.byteLength),
        });
        response.end(gzippedLarge);
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "content-encoding": "unknown-codec",
      });
      response.end(Buffer.from(png));
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    try {
      const port = (server.address() as AddressInfo).port;
      const origin = `http://images.proxy.test:${port}`;
      const fetch = makePinnedImageFetch({
        resolveAll: async () => ["127.0.0.1"],
        allowedOrigin: origin,
      });

      const decoded = await fetchWith(fetch, `${origin}/gzip.png`);
      expect(decoded).toEqual({ bytes: png });

      const oversized = await fetchApprovedImageUrl({
        url: `${origin}/bomb.png`,
        fetch,
        maxBytes: 1_000,
        timeoutMs: 5_000,
      });
      expect(oversized).toMatchObject({ failure: { category: "protocol" } });

      const unsupported = await fetchWith(fetch, `${origin}/unknown.png`);
      expect("failure" in unsupported).toBe(true);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("fails cleanly without uncaught errors when a deflate or Brotli response disconnects after decoder EOF", async () => {
    const payloads = {
      "/deflate-truncated.png": {
        encoding: "deflate",
        body: deflateSync(Buffer.from(png)),
      },
      "/brotli-truncated.png": {
        encoding: "br",
        body: brotliCompressSync(Buffer.from(png)),
      },
    } as const;
    const server = createServer((request, response) => {
      const entry =
        request.url === "/deflate-truncated.png" || request.url === "/brotli-truncated.png"
          ? payloads[request.url]
          : undefined;
      if (entry === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      // Declare more bytes than will ever arrive, write the complete compressed
      // image plus one trailing byte, then abruptly drop the socket.
      response.writeHead(200, {
        "content-type": "image/png",
        "content-encoding": entry.encoding,
        "content-length": String(entry.body.byteLength + 16),
      });
      response.write(Buffer.concat([entry.body, Buffer.from([0x00])]), () => {
        setTimeout(() => response.socket?.destroy(), 10);
      });
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    try {
      const port = (server.address() as AddressInfo).port;
      const origin = `http://images.proxy.test:${port}`;
      const fetch = makePinnedImageFetch({
        resolveAll: async () => ["127.0.0.1"],
        allowedOrigin: origin,
      });
      for (const path of ["/deflate-truncated.png", "/brotli-truncated.png"] as const) {
        const result = await fetchWith(fetch, `${origin}${path}`);
        expect("failure" in result).toBe(true);
      }
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});

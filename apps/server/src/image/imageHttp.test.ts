import { describe, expect, it, vi } from "vitest";
import { fetchApprovedImageUrl, type ImageHttpFetch } from "./imageHttp";

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

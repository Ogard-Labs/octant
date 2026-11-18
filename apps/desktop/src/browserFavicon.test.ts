import { describe, expect, it, vi } from "vitest";
import {
  FAVICON_MAX_BYTES,
  fetchFaviconDataUrl,
  firstHttpIcon,
  type FaviconSession,
} from "./browserFavicon";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function response(bytes: Uint8Array, type: string | null = "image/png", ok = true): Response {
  let sent = false;
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? type : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

const session = (reply: () => Promise<Response>): FaviconSession => ({
  fetch: vi.fn(reply),
});

describe("a page's favicon", () => {
  it("accepts a small image and keeps it as a data URL", async () => {
    const result = await fetchFaviconDataUrl(
      session(async () => response(PNG)),
      "https://example.com/favicon.png",
    );
    expect(result).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });

  it("fetches without the page's cookies, through the session it was given", async () => {
    const own = session(async () => response(PNG));
    await fetchFaviconDataUrl(own, "https://example.com/favicon.png");
    expect(own.fetch).toHaveBeenCalledWith(
      "https://example.com/favicon.png",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("refuses an image over 64 KB", async () => {
    const big = new Uint8Array(FAVICON_MAX_BYTES + 1);
    big.set(PNG);
    expect(
      await fetchFaviconDataUrl(
        session(async () => response(big)),
        "https://example.com/i.png",
      ),
    ).toBeUndefined();
  });

  it("refuses a type that is not an image, and bytes that are not the image they claim", async () => {
    expect(
      await fetchFaviconDataUrl(
        session(async () => response(PNG, "text/html")),
        "https://example.com/i.png",
      ),
    ).toBeUndefined();
    expect(
      await fetchFaviconDataUrl(
        session(async () => response(new TextEncoder().encode("<html></html>"))),
        "https://example.com/i.png",
      ),
    ).toBeUndefined();
  });

  it("refuses an address that is not http or https", async () => {
    const own = session(async () => response(PNG));
    expect(await fetchFaviconDataUrl(own, "file:///etc/hosts")).toBeUndefined();
    expect(await fetchFaviconDataUrl(own, "data:image/png;base64,AAAA")).toBeUndefined();
    expect(own.fetch).not.toHaveBeenCalled();
  });

  it("gives up after the timeout and shows no icon", async () => {
    const hung: FaviconSession = {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    expect(
      await fetchFaviconDataUrl(hung, "https://example.com/i.png", { timeoutMs: 20 }),
    ).toBeUndefined();
  });

  it("refuses a redirect rather than following it to an address nobody checked", async () => {
    const own = session(async () => response(PNG));
    await fetchFaviconDataUrl(own, "https://example.com/i.png");
    expect(own.fetch).toHaveBeenCalledWith(
      "https://example.com/i.png",
      expect.objectContaining({ redirect: "error" }),
    );
    // What the network stack does with a redirect in that mode: the fetch fails.
    const redirecting: FaviconSession = {
      fetch: async () => {
        throw new TypeError("net::ERR_FAILED");
      },
    };
    expect(await fetchFaviconDataUrl(redirecting, "https://example.com/i.png")).toBeUndefined();
    // And a response that says it was redirected anyway is not kept.
    const followed = session(async () => ({ ...response(PNG), redirected: true }) as Response);
    expect(await fetchFaviconDataUrl(followed, "https://example.com/i.png")).toBeUndefined();
  });

  it("stops a fetch the caller ends, as when the page declares another icon", async () => {
    const controller = new AbortController();
    const hung: FaviconSession = {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const pending = fetchFaviconDataUrl(hung, "https://example.com/i.png", {
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBeUndefined();
  });

  it("takes the first http or https icon the page declares", () => {
    expect(
      firstHttpIcon(["data:image/png;base64,AA", "ftp://x/i.ico", "https://a.test/i.png"]),
    ).toBe("https://a.test/i.png");
    expect(firstHttpIcon(["data:image/png;base64,AA"])).toBeUndefined();
  });
});

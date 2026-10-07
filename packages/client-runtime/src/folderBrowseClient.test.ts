import { describe, expect, it, vi } from "vitest";
import { createFolderBrowseClient, FolderBrowseClientFailure } from "./folderBrowseClient";

const hostId = "00000000-0000-4000-8000-000000000001";
const browseRequest = { hostId: hostId as never, mode: "work" as const };

function client(fetch: ReturnType<typeof vi.fn>, requestTimeoutMs = 50) {
  return createFolderBrowseClient({
    baseUrl: "http://127.0.0.1:4317",
    fetch: fetch as never,
    windowCapability: "capability-token",
    requestTimeoutMs,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createFolderBrowseClient", () => {
  it("decodes a browse response and carries the window capability", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [],
        breadcrumbs: [],
        hasMore: false,
        browsedAt: "2026-07-27T12:00:00.000Z",
      }),
    );

    const result = await client(fetch).browse(browseRequest);

    expect(result.hasMore).toBe(false);
    const call = fetch.mock.calls[0];
    expect(String(call?.[0])).toBe("http://127.0.0.1:4317/api/folders/browse");
    expect(call?.[1]?.headers["x-octant-window-capability"]).toBe("capability-token");
  });

  it("surfaces a typed failure from the browse route", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ category: "unavailable", message: "Cannot read directory contents." }, 503),
      );

    const failure = await client(fetch)
      .browse(browseRequest)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FolderBrowseClientFailure);
    expect((failure as FolderBrowseClientFailure).category).toBe("unavailable");
    expect((failure as FolderBrowseClientFailure).message).toBe("Cannot read directory contents.");
  });

  it("fails a browse that produces no response within the request budget", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const startedAt = Date.now();
    const failure = await client(fetch, 50)
      .browse(browseRequest)
      .catch((error: unknown) => error);
    const elapsedMs = Date.now() - startedAt;

    expect(failure).toBeInstanceOf(FolderBrowseClientFailure);
    expect((failure as FolderBrowseClientFailure).category).toBe("unavailable");
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("fails a browse whose response body stalls after the headers arrive", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const failure = await client(fetch, 50)
      .browse(browseRequest)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FolderBrowseClientFailure);
    expect((failure as FolderBrowseClientFailure).category).toBe("unavailable");
  }, 2_000);
});

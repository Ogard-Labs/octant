import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCodeRouteHandler, type CodeRouteService } from "./codeRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

/**
 * Route coverage for the confined Code file listing that makes the already
 * built file explorer reachable. The endpoint is a read: it takes no body, and
 * it answers `unavailable` rather than 404 on a host with no listing
 * capability, so "this host cannot list" stays distinct from "no such route".
 */

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const threadId = "00000000-0000-4000-8000-000000000902";
const checkoutId = "00000000-0000-4000-8000-000000000903";
const listingUrl = `http://127.0.0.1/api/code/files/listing?threadId=${threadId}&checkoutId=${checkoutId}`;

function listedResult() {
  return {
    status: "listed",
    listing: {
      kind: "code-file-listing",
      threadId,
      checkoutId,
      entries: [{ kind: "directory", path: "src" }],
      truncated: false,
      observedAt: "2026-08-14T08:00:00.000Z",
    },
  };
}

function createRoute(overrides: Record<string, unknown> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const listFiles = vi.fn().mockResolvedValue(listedResult());
  const service = {
    bootstrap: vi.fn(),
    read: vi.fn(),
    execute: vi.fn(),
    subscribe: vi.fn(),
    readContent: vi.fn(),
    saveFile: vi.fn(),
    listFiles,
    ...overrides,
  } as unknown as CodeRouteService;
  return {
    handler: createCodeRouteHandler({ service, windowAuthorityStore: store, now: () => 1 }),
    listFiles,
  };
}

function get(url = listingUrl) {
  return new Request(url, {
    method: "GET",
    headers: { "x-octant-window-capability": capability },
  });
}

describe("Code file listing route", () => {
  it("returns the host's typed listing", async () => {
    const { handler, listFiles } = createRoute();
    const response = await handler(get());

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(listedResult());
    expect(listFiles.mock.calls[0]?.[1]).toMatchObject({ threadId, checkoutId });
  });

  it("passes a requested subdirectory through", async () => {
    const { handler, listFiles } = createRoute();
    await handler(get(`${listingUrl}&directory=apps%2Fweb`));
    expect(listFiles.mock.calls[0]?.[1]).toMatchObject({ directory: "apps/web" });
  });

  it("rejects an unauthenticated request", async () => {
    const { handler, listFiles } = createRoute();
    const response = await handler(new Request(listingUrl, { method: "GET" }));
    expect(response?.status).toBe(401);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("rejects a traversal directory and an unknown query parameter", async () => {
    const { handler, listFiles } = createRoute();
    expect((await handler(get(`${listingUrl}&directory=..%2Fetc`)))?.status).toBe(400);
    expect((await handler(get(`${listingUrl}&depth=99`)))?.status).toBe(400);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("rejects a mutating method on a read endpoint", async () => {
    const { handler, listFiles } = createRoute();
    const response = await handler(
      new Request(listingUrl, {
        method: "PUT",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(400);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("answers unavailable when the host wired no listing capability", async () => {
    const { handler } = createRoute({ listFiles: undefined });
    const response = await handler(get());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ category: "unavailable" });
  });
});

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
const watchUrl = `http://127.0.0.1/api/code/files/watch?threadId=${threadId}&checkoutId=${checkoutId}`;

function notice(paths: ReadonlyArray<string>, truncated = false) {
  return {
    kind: "code-file-change",
    threadId,
    checkoutId,
    paths,
    truncated,
    observedAt: "2026-08-14T08:00:01.000Z",
  };
}

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

describe("Code file search route", () => {
  const searchUrl = `http://127.0.0.1/api/code/files/search?threadId=${threadId}&checkoutId=${checkoutId}&scope=path&query=main`;

  function searchedResult() {
    return {
      status: "searched",
      search: {
        kind: "code-search",
        threadId,
        checkoutId,
        scope: "path",
        query: "main",
        matches: [],
        truncated: false,
        observedAt: "2026-08-14T08:00:00.000Z",
      },
    };
  }

  it("returns the host's typed search", async () => {
    const searchFiles = vi.fn().mockResolvedValue(searchedResult());
    const { handler } = createRoute({ searchFiles });
    const response = await handler(get(searchUrl));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(searchedResult());
    expect(searchFiles.mock.calls[0]?.[1]).toMatchObject({ scope: "path", query: "main" });
  });

  it("refuses a scope the contract does not name", async () => {
    const searchFiles = vi.fn();
    const { handler } = createRoute({ searchFiles });
    const url = searchUrl.replace("scope=path", "scope=regex");
    expect((await handler(get(url)))?.status).toBe(400);
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it("refuses a query longer than the contract allows", async () => {
    const searchFiles = vi.fn();
    const { handler } = createRoute({ searchFiles });
    const url = `${searchUrl.replace("query=main", "")}query=${"x".repeat(201)}`;
    expect((await handler(get(url)))?.status).toBe(400);
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it("answers unavailable when the host wired no searcher", async () => {
    const { handler } = createRoute({ searchFiles: undefined });
    const response = await handler(get(searchUrl));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ category: "unavailable" });
  });

  it("refuses an unauthenticated search", async () => {
    const searchFiles = vi.fn();
    const { handler } = createRoute({ searchFiles });
    const response = await handler(new Request(searchUrl, { method: "GET" }));
    expect(response?.status).toBe(401);
    expect(searchFiles).not.toHaveBeenCalled();
  });
});

describe("Code file watch route", () => {
  it("streams the host's change notices as NDJSON", async () => {
    const { handler } = createRoute({
      watchFiles: () =>
        (async function* () {
          yield notice(["src/main.ts"]);
          yield notice([], true);
        })(),
    });
    const response = await handler(get(watchUrl));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await response!.text()).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      notice(["src/main.ts"]),
      notice([], true),
    ]);
  });

  it("answers unavailable when the host wired no watcher", async () => {
    const { handler } = createRoute({ watchFiles: undefined });
    const response = await handler(get(watchUrl));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ category: "unavailable" });
  });

  it("rejects an unknown query parameter and a mutating method", async () => {
    const watchFiles = vi.fn();
    const { handler } = createRoute({ watchFiles });
    expect((await handler(get(`${watchUrl}&directory=src`)))?.status).toBe(400);
    expect(
      (
        await handler(
          new Request(watchUrl, {
            method: "PUT",
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(400);
    expect(watchFiles).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated watch", async () => {
    const watchFiles = vi.fn();
    const { handler } = createRoute({ watchFiles });
    const response = await handler(new Request(watchUrl, { method: "GET" }));
    expect(response?.status).toBe(401);
    expect(watchFiles).not.toHaveBeenCalled();
  });
});

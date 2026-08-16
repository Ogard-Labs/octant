import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCodeRouteHandler, type CodeRouteService } from "./codeRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

/**
 * Route coverage for the repository-test listing that makes the Tests pane
 * reachable. The endpoint is a read, and it answers `unavailable` rather than
 * 404 on a host that wired no discovery, so "this host cannot discover tests"
 * stays distinct from "no such route".
 */

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000911");
const threadId = "00000000-0000-4000-8000-000000000912";
const checkoutId = "00000000-0000-4000-8000-000000000913";
const listingUrl = `http://127.0.0.1/api/code/tests/listing?threadId=${threadId}&checkoutId=${checkoutId}`;

function listing() {
  return {
    kind: "code-repository-test-listing",
    threadId,
    checkoutId,
    definitions: [
      {
        id: "00000000-0000-4000-8000-000000000914",
        name: "test",
        source: {
          kind: "package-script",
          packagePath: "package.json",
          packageManager: "bun",
          script: "test",
        },
        argv: ["bun", "run", "test"],
        cwd: ".",
        environmentRefs: [],
        timeoutMs: 900_000,
        artifactPaths: [],
      },
    ],
    observedAt: "2026-08-15T08:00:00.000Z",
  };
}

function createRoute(overrides: Record<string, unknown> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const listTests = vi.fn().mockResolvedValue(listing());
  const service = {
    bootstrap: vi.fn(),
    read: vi.fn(),
    execute: vi.fn(),
    subscribe: vi.fn(),
    readContent: vi.fn(),
    saveFile: vi.fn(),
    listTests,
    ...overrides,
  } as unknown as CodeRouteService;
  return {
    handler: createCodeRouteHandler({ service, windowAuthorityStore: store, now: () => 1 }),
    listTests,
  };
}

function get(url = listingUrl) {
  return new Request(url, {
    method: "GET",
    headers: { "x-octant-window-capability": capability },
  });
}

describe("Code repository test listing route", () => {
  it("returns the host's typed definitions", async () => {
    const { handler, listTests } = createRoute();
    const response = await handler(get());

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(listing());
    expect(listTests.mock.calls[0]?.[1]).toEqual({ threadId, checkoutId });
  });

  it("rejects an unauthenticated request", async () => {
    const { handler, listTests } = createRoute();
    const response = await handler(new Request(listingUrl, { method: "GET" }));
    expect(response?.status).toBe(401);
    expect(listTests).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter and a mutating method", async () => {
    const { handler, listTests } = createRoute();
    expect((await handler(get(`${listingUrl}&directory=src`)))?.status).toBe(400);
    expect(
      (
        await handler(
          new Request(listingUrl, {
            method: "PUT",
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(400);
    expect(listTests).not.toHaveBeenCalled();
  });

  it("answers unavailable when the host wired no discovery", async () => {
    const { handler } = createRoute({ listTests: undefined });
    const response = await handler(get());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ category: "unavailable" });
  });
});

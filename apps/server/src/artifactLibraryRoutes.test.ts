import { decodeWindowId } from "@octant/contracts";
import type { ArtifactLibraryQuery } from "@octant/contracts/artifact-library";
import { describe, expect, it, vi } from "vitest";
import { createArtifactLibraryRouteHandler } from "./artifactLibraryRoutes";
import type { ArtifactLibraryService } from "./canvas/artifactLibraryService";
import type { ClientPrincipal } from "./clientPrincipal";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000931");
const url = "http://127.0.0.1/api/artifacts/library";

function route() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const list = vi.fn((_query: ArtifactLibraryQuery, _principal: ClientPrincipal) => ({
    kind: "artifact-library-listing",
    entries: [],
    projects: [],
    matchCount: 0,
    truncated: false,
    generatedAt: "2026-08-18T10:00:00.000Z",
  }));
  return {
    list,
    handler: createArtifactLibraryRouteHandler({
      library: { list } as unknown as ArtifactLibraryService,
      windowAuthorityStore: store,
      now: () => 1,
    }),
  };
}

function post(body: unknown, headers: Record<string, string> = {}, target = url) {
  return new Request(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("reading the artifact library over the wire", () => {
  it("answers a query the window is entitled to make", async () => {
    const { handler, list } = route();

    const response = await handler(post({ tab: "all", query: "plan" }));

    expect(response?.status).toBe(200);
    expect(list.mock.calls[0]?.[0]).toEqual({ tab: "all", query: "plan" });
  });

  it("refuses a caller without the window's capability", async () => {
    const { handler, list } = route();

    const response = await handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tab: "all" }),
      }),
    );

    expect(response?.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a request that did not arrive over loopback", async () => {
    const { handler, list } = route();

    const response = await handler(
      post({ tab: "all" }, {}, "http://octant.example/api/artifacts/library"),
    );

    expect(response?.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses an origin that is not the renderer's", async () => {
    const { handler, list } = route();

    const response = await handler(post({ tab: "all" }, { origin: "https://example.test" }));

    expect(response?.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a query the contract does not accept rather than guessing at it", async () => {
    const { handler, list } = route();

    expect((await handler(post({ tab: "everything" })))?.status).toBe(400);
    expect((await handler(post({ tab: "all", projectId: "not-a-uuid" })))?.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("never takes a caller-supplied principal from the body", async () => {
    const { handler } = route();

    // A body field that looked like identity would have to decode first, and
    // the query contract has no room for one.
    const response = await handler(post({ tab: "all", principal: { kind: "local-window" } }));

    expect(response?.status).toBe(400);
  });
});

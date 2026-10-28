import { decodeCanvasId, decodeWindowId } from "@octant/contracts";
import type { ArtifactLibraryQuery } from "@octant/contracts/artifact-library";
import { describe, expect, it, vi } from "vitest";
import { createArtifactLibraryRouteHandler } from "./artifactLibraryRoutes";
import type { ArtifactLibraryService } from "./canvas/artifactLibraryService";
import type { CanvasTagService } from "./canvas/canvasTagService";
import type { ClientPrincipal } from "./clientPrincipal";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000931");
const url = "http://127.0.0.1/api/artifacts/library";
const tagUrl = "http://127.0.0.1/api/artifacts/tag";
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");

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
  const change = vi.fn(
    (_input: unknown, _caller: "local-window" | "remote-device") =>
      ({
        kind: "accepted",
        canvasId,
        sequence: 1,
        tags: ["Launch"],
      }) as const,
  );
  return {
    list,
    change,
    handler: createArtifactLibraryRouteHandler({
      library: { list } as unknown as ArtifactLibraryService,
      windowAuthorityStore: store,
      tags: { change, tags: () => [] } as unknown as CanvasTagService,
      now: () => 1,
    }),
    handlerWithoutTags: createArtifactLibraryRouteHandler({
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

describe("changing an artifact's tags over the wire", () => {
  it("hands a local window's tag command to the service", async () => {
    const { handler, change } = route();

    const response = await handler(
      post({ kind: "canvas-tag-add", canvasId, tag: "Launch" }, {}, tagUrl),
    );

    expect(response?.status).toBe(200);
    expect(change).toHaveBeenCalledWith(
      { kind: "canvas-tag-add", canvasId, tag: "Launch" },
      "local-window",
    );
    expect(await response?.json()).toEqual({
      kind: "accepted",
      canvasId,
      sequence: 1,
      tags: ["Launch"],
    });
  });

  it("answers a refused command as a result, not an error", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const change = vi.fn(() => ({
      kind: "denied" as const,
      denialCode: "duplicate-tag" as const,
      message: "Canvas already carries this tag.",
    }));
    const handler = createArtifactLibraryRouteHandler({
      library: { list: vi.fn() } as unknown as ArtifactLibraryService,
      windowAuthorityStore: store,
      tags: { change, tags: () => [] } as unknown as CanvasTagService,
      now: () => 1,
    });

    const response = await handler(
      post({ kind: "canvas-tag-add", canvasId, tag: "Launch" }, {}, tagUrl),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ kind: "denied", denialCode: "duplicate-tag" });
  });

  it("refuses a caller without the window's capability", async () => {
    const { handler, change } = route();

    const response = await handler(
      new Request(tagUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "canvas-tag-add", canvasId, tag: "Launch" }),
      }),
    );

    expect(response?.status).toBe(401);
    expect(change).not.toHaveBeenCalled();
  });

  it("hands the service whatever body arrives and relays its refusal of it", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const change = vi.fn(() => ({
      kind: "denied" as const,
      denialCode: "malformed-request" as const,
      message: "Canvas tag command is malformed.",
    }));
    const handler = createArtifactLibraryRouteHandler({
      library: { list: vi.fn() } as unknown as ArtifactLibraryService,
      windowAuthorityStore: store,
      tags: { change, tags: () => [] } as unknown as CanvasTagService,
      now: () => 1,
    });

    const response = await handler(post({ kind: "canvas-tag-add" }, {}, tagUrl));

    // The route still answers 200 with the service's own refusal: a malformed
    // command is the host's answer about the command, not a transport failure.
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      kind: "denied",
      denialCode: "malformed-request",
    });
    expect(change).toHaveBeenCalledWith({ kind: "canvas-tag-add" }, "local-window");
  });

  it("says tags are unavailable on a host without the tag service", async () => {
    const { handlerWithoutTags } = route();

    const response = await handlerWithoutTags(
      post({ kind: "canvas-tag-add", canvasId, tag: "Launch" }, {}, tagUrl),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      kind: "denied",
      denialCode: "unavailable",
    });
  });

  it("leaves the library read untouched when the path is neither route", async () => {
    const { handler, list, change } = route();

    expect(await handler(post({ tab: "all" }, {}, "http://127.0.0.1/api/artifacts/other"))).toBe(
      undefined,
    );
    expect(list).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });
});

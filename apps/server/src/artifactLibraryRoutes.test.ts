import { decodeCanvasId, decodeWindowId } from "@octant/contracts";
import type { ArtifactLibraryQuery } from "@octant/contracts/artifact-library";
import { describe, expect, it, vi } from "vitest";
import { createArtifactLibraryRouteHandler } from "./artifactLibraryRoutes";
import type { ArtifactLibraryService } from "./canvas/artifactLibraryService";
import type { CanvasTagService } from "./canvas/canvasTagService";
import type { ClientPrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
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

  it("hands a person-paired device's tag command as a host person while keeping hub-introduced devices remote", async () => {
    const { handler, change } = route();
    const paired = post({ kind: "canvas-tag-add", canvasId, tag: "Launch" }, {}, tagUrl);
    bindPrincipalRouteContext(paired, {
      principal: { kind: "remote-device", admittedBy: "host-person" } as never,
      scopeId: windowId,
    });
    expect((await handler(paired))?.status).toBe(200);

    const hub = post({ kind: "canvas-tag-add", canvasId, tag: "Launch" }, {}, tagUrl);
    bindPrincipalRouteContext(hub, {
      principal: { kind: "remote-device", admittedBy: "hub-roster" } as never,
      scopeId: windowId,
    });
    expect((await handler(hub))?.status).toBe(200);

    expect(change.mock.calls.map((call) => call[1])).toEqual(["local-window", "remote-device"]);
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

describe("reading a Claude page's snapshot from the library", () => {
  const snapshotUrl = "http://127.0.0.1/api/artifacts/claude-snapshot";
  const request = {
    mode: "work",
    threadId: "22222222-2222-4222-8222-222222222222",
    toolCallId: "call-1",
  };

  it("reads the kept copy through the publishing thread's own read check for this window", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const findPublishedSnapshot = vi.fn(async () => ({
      format: "html" as const,
      content: "<h1>Hero</h1>",
    }));
    const handler = createArtifactLibraryRouteHandler({
      library: {} as unknown as ArtifactLibraryService,
      windowAuthorityStore: store,
      findPublishedSnapshot,
      now: () => 1,
    });
    const response = await handler(post(request, {}, snapshotUrl));
    expect(await response?.json()).toEqual({
      kind: "claude-snapshot",
      snapshot: { format: "html", content: "<h1>Hero</h1>" },
    });
    expect(findPublishedSnapshot).toHaveBeenCalledWith(windowId, request);
  });

  it("answers unavailable where the thread's read check finds nothing, and refuses a window without the capability", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const handler = createArtifactLibraryRouteHandler({
      library: {} as unknown as ArtifactLibraryService,
      windowAuthorityStore: store,
      findPublishedSnapshot: async () => undefined,
      now: () => 1,
    });
    expect(await (await handler(post(request, {}, snapshotUrl)))?.json()).toEqual({
      kind: "unavailable",
    });
    const refused = await handler(
      post(request, { "x-octant-window-capability": "B".repeat(43) }, snapshotUrl),
    );
    expect(refused?.status).toBe(401);
    expect((await handler(post({ ...request, mode: "chat" }, {}, snapshotUrl)))?.status).toBe(400);
  });
});

describe("copying a Claude page into a Canvas from the library", () => {
  const copyUrl = "http://127.0.0.1/api/artifacts/claude-copy";
  const request = {
    mode: "work",
    threadId: "22222222-2222-4222-8222-222222222222",
    toolCallId: "call-1",
    title: "Launch plan",
  };

  it("hands a window's copy to the host with the window that asked", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const copyClaudePage = vi.fn(async () => ({
      kind: "refused" as const,
      reason: "not-html" as const,
      message: "Only an HTML page can be copied into a Canvas.",
    }));
    const handler = createArtifactLibraryRouteHandler({
      library: {} as unknown as ArtifactLibraryService,
      windowAuthorityStore: store,
      copyClaudePage,
      now: () => 1,
    });
    const response = await handler(post(request, {}, copyUrl));
    expect(await response?.json()).toMatchObject({ kind: "refused", reason: "not-html" });
    expect(copyClaudePage).toHaveBeenCalledWith(windowId, request);
  });

  it("refuses a paired device, which never reads the kept snapshot", async () => {
    const copyClaudePage = vi.fn();
    const handler = createArtifactLibraryRouteHandler({
      library: {} as unknown as ArtifactLibraryService,
      windowAuthorityStore: new WindowAuthorityStore(),
      copyClaudePage,
      now: () => 1,
    });
    const remote = post(request, {}, copyUrl);
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });
    expect(await (await handler(remote))?.json()).toMatchObject({
      kind: "denied",
      denialCode: "unavailable",
    });
    expect(copyClaudePage).not.toHaveBeenCalled();
  });
});

import { decodeWindowId, decodeWorkFileListingResult } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWorkFileListingRouteHandler } from "./workFileListingRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { Schema } from "effect";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";

/**
 * Route coverage for the confined Work folder listing that makes the Files
 * panel reachable in Work. The route grants nothing on its own: the folder it
 * lists is the one the window's Project is already bound to, so the tests that
 * matter are the ones proving a caller cannot name its own root or reach a
 * Project this window has no claim on.
 */

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectId = "00000000-0000-4000-8000-000000000902";
const threadId = "00000000-0000-4000-8000-000000000903";
const listingUrl = `http://127.0.0.1/api/work/files/listing?projectId=${projectId}&threadId=${threadId}`;

function listedResult() {
  return decodeWorkFileListingResult({
    status: "listed",
    listing: {
      kind: "work-file-listing",
      threadId,
      projectId,
      entries: [{ kind: "file", path: "summary.md", byteLength: 12, origin: "untouched" }],
      truncated: false,
      observedAt: "2026-09-04T10:00:00.000Z",
    },
  });
}

function workProject() {
  return {
    id: projectId,
    type: "work",
    lifecycle: "active",
    binding: { canonicalRoot: "/work" },
  };
}

function createRoute(overrides: Record<string, unknown> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const list = vi.fn().mockResolvedValue(listedResult());
  const handler = createWorkFileListingRouteHandler({
    service: { list, ...overrides } as never,
    persistence: { readProject: () => workProject() } as never,
    projects: { bootstrap: async () => ({ active: [workProject()] }) } as never,
    windowAuthorityStore: store,
    now: () => 0,
  });
  return { handler, list };
}

function authorized(url = listingUrl): Request {
  return new Request(url, { headers: { "x-octant-window-capability": capability } });
}

describe("Work file listing route", () => {
  it("lists an admitted server Work thread without resolving a folder on this host", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const localList = vi.fn();
    const readProject = vi.fn();
    const serverList = vi.fn(async () => listedResult());
    const handler = createWorkFileListingRouteHandler({
      service: { list: localList } as never,
      persistence: { readProject } as never,
      projects: { bootstrap: vi.fn() } as never,
      server: { holds: () => true, list: serverList },
      windowAuthorityStore: store,
      now: () => 0,
    });
    const response = await handler(authorized());
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ status: "listed" });
    expect(serverList).toHaveBeenCalledWith(
      expect.objectContaining({ windowId, projectId, threadId }),
    );
    expect(localList).not.toHaveBeenCalled();
    expect(readProject).not.toHaveBeenCalled();
  });

  it("withholds a server reading after its window capability is revoked", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const handler = createWorkFileListingRouteHandler({
      service: { list: vi.fn() } as never,
      persistence: { readProject: vi.fn() } as never,
      projects: { bootstrap: vi.fn() } as never,
      server: {
        holds: () => true,
        list: async () => {
          store.revoke(windowId);
          return listedResult();
        },
      },
      windowAuthorityStore: store,
      now: () => 0,
    });
    const response = await handler(authorized());
    expect(response?.status).toBe(403);
    expect(JSON.stringify(await response?.json())).not.toContain("summary.md");
  });

  it("refuses a paired device before dispatching a server listing", async () => {
    const store = new WindowAuthorityStore();
    const serverList = vi.fn();
    const handler = createWorkFileListingRouteHandler({
      service: { list: vi.fn() } as never,
      persistence: { readProject: vi.fn() } as never,
      projects: { bootstrap: vi.fn() } as never,
      server: { holds: () => true, list: serverList },
      windowAuthorityStore: store,
      now: () => 0,
    });
    const request = new Request(listingUrl);
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "remote-device",
        deviceId: Schema.decodeUnknownSync(DeviceId)("00000000-0000-4000-8000-00000000c001"),
        hostId: Schema.decodeUnknownSync(StableHostId)("00000000-0000-4000-8000-00000000c002"),
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: Schema.decodeUnknownSync(RemoteSessionId)(
          "00000000-0000-4000-8000-00000000c003",
        ),
      },
      scopeId: windowId,
    });
    expect((await handler(request))?.status).toBe(403);
    expect(serverList).not.toHaveBeenCalled();
  });

  it("lists the folder the window's Project is bound to", async () => {
    const { handler, list } = createRoute();

    const response = await handler(authorized());

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ status: "listed" });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ rootPath: "/work" }));
  });

  it("refuses a caller that supplies no window capability", async () => {
    const { handler, list } = createRoute();

    const response = await handler(new Request(listingUrl));

    expect(response?.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a Project this window cannot reach", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const list = vi.fn();
    const handler = createWorkFileListingRouteHandler({
      service: { list } as never,
      persistence: { readProject: () => workProject() } as never,
      projects: { bootstrap: async () => ({ active: [] }) } as never,
      windowAuthorityStore: store,
      now: () => 0,
    });

    const response = await handler(authorized());

    expect(response?.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a Code Project asked for through the Work listing", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const list = vi.fn();
    const codeProject = { id: projectId, type: "code", lifecycle: "active" };
    const handler = createWorkFileListingRouteHandler({
      service: { list } as never,
      persistence: { readProject: () => codeProject } as never,
      projects: { bootstrap: async () => ({ active: [codeProject] }) } as never,
      windowAuthorityStore: store,
      now: () => 0,
    });

    const response = await handler(authorized());

    expect(response?.status).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a query that tries to name its own window or an unknown parameter", async () => {
    const { handler, list } = createRoute();

    const named = await handler(authorized(`${listingUrl}&windowId=${windowId}`));
    const unknown = await handler(authorized(`${listingUrl}&rootPath=/etc`));

    expect(named?.status).toBe(400);
    expect(unknown?.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a write attempt on a read-only route", async () => {
    const { handler, list } = createRoute();

    const response = await handler(
      new Request(listingUrl, {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("leaves every other path to the rest of the server", async () => {
    const { handler } = createRoute();

    await expect(
      handler(authorized("http://127.0.0.1/api/work/mutations")),
    ).resolves.toBeUndefined();
  });
});

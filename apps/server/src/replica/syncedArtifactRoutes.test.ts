import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createSyncedArtifactRouteHandler } from "./syncedArtifactRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000387");
const url = "http://127.0.0.1/api/artifacts/synced";
const restore = { kind: "restore", canvasId: "10000000-0000-4000-8000-000000000001" };

function route() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const execute = vi.fn(async () => ({
    kind: "artifact-synced-published" as const,
    canvasId: restore.canvasId as never,
    versionId: "20000000-0000-4000-8000-000000000001" as never,
    published: true,
  }));
  return {
    execute,
    handler: createSyncedArtifactRouteHandler({
      service: { execute },
      windowAuthorityStore: store,
      now: () => 1,
    }),
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("synced artifact commands", () => {
  it("runs a command for the local window", async () => {
    const { handler, execute } = route();
    const response = await handler(request(restore));
    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(restore);
  });

  it("refuses a paired device before reading the command", async () => {
    const { handler, execute } = route();
    const remote = request(restore);
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });
    const response = await handler(remote);
    expect(response?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a window without its capability, and a command it cannot read", async () => {
    const { handler, execute } = route();
    expect(
      (await handler(request(restore, { "x-octant-window-capability": "wrong" })))?.status,
    ).toBe(401);
    expect((await handler(request({ kind: "delete-everything" })))?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

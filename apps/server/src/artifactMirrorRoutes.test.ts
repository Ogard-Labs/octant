import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createArtifactMirrorRouteHandler } from "./artifactMirrorRoutes";
import type { ArtifactMirrorService } from "./canvas/artifactMirrorService";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000941");
const url = "http://127.0.0.1/api/artifacts/mirror";

const settings = {
  kind: "artifact-mirror-settings",
  fallback: { kind: "internal-only" },
  overrides: [],
  autoCommit: false,
  version: 0,
  updatedAt: "2026-08-18T10:00:00.000Z",
};

function route() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const execute = vi.fn(async () => ({ kind: "mirror-settings", settings }) as never);
  return {
    execute,
    handler: createArtifactMirrorRouteHandler({
      mirror: { settings: () => settings, execute } as unknown as ArtifactMirrorService,
      windowAuthorityStore: store,
      now: () => 1,
    }),
  };
}

function request(method: string, body?: unknown, target = url) {
  return new Request(target, {
    method,
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("settling where artifacts are mirrored", () => {
  it("reads the setting for the local window", async () => {
    const response = await route().handler(request("GET"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ settings });
  });

  it("takes a change the window is entitled to make", async () => {
    const { handler, execute } = route();

    const response = await handler(
      request("POST", {
        kind: "set-artifact-mirror-fallback",
        expectedVersion: 0,
        destination: { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" },
      }),
    );

    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refuses a paired device outright — naming a local folder is host work", async () => {
    const { handler, execute } = route();
    const remote = request("POST", {
      kind: "set-artifact-mirror-fallback",
      expectedVersion: 0,
      destination: { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" },
    });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });

    const response = await handler(remote);

    expect(response?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a re-import from a paired device, which cannot see the file", async () => {
    const { handler, execute } = route();
    const remote = request("POST", {
      kind: "reimport-artifact-from-file",
      canvasId: "1a2b3c4d-0000-4000-8000-000000000001",
      expectedVersionId: "30000000-0000-4000-8000-000000000001",
    });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });

    expect((await handler(remote))?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a caller without the window's capability", async () => {
    const { handler, execute } = route();

    const response = await handler(new Request(url, { method: "GET" }));

    expect(response?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a request that did not arrive over loopback", async () => {
    const { handler } = route();

    expect(
      (await handler(request("GET", undefined, "http://octant.example/api/artifacts/mirror")))
        ?.status,
    ).toBe(400);
  });

  it("refuses a command the contract does not accept rather than guessing", async () => {
    const { handler, execute } = route();

    expect((await handler(request("POST", { kind: "set-everything" })))?.status).toBe(400);
    // A folder that is not absolute is not a folder this host will write to.
    expect(
      (
        await handler(
          request("POST", {
            kind: "set-artifact-mirror-fallback",
            expectedVersion: 0,
            destination: { kind: "global-folder", canonicalRoot: "relative/path" },
          }),
        )
      )?.status,
    ).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

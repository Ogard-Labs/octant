import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { decodeWindowId, type WindowId } from "@octant/contracts";
import type { ReplicaStoreSettingsView } from "@octant/contracts/replica-store-settings";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { createReplicaStoreSettingsRouteHandler } from "./replicaStoreSettingsRoutes";
import type { ReplicaStoreSettingsService } from "./replicaStoreSettingsService";

const windowId = decodeWindowId("00000000-0000-4000-8000-0000000000a1");
const candidateId = "88888888-8888-4888-8888-888888888888";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const view: ReplicaStoreSettingsView = {
  kind: "replica-store-settings-view",
  store: { kind: "none" },
  syncOn: false,
  version: 0 as ReplicaStoreSettingsView["version"],
  hostId: "local" as ReplicaStoreSettingsView["hostId"],
  mode: "work",
  credentialStore: "available",
  replicaMember: false,
};

function service() {
  const calls: Array<{ readonly method: string; readonly input?: unknown }> = [];
  const instance: Pick<
    ReplicaStoreSettingsService,
    "view" | "chooseFolder" | "configureS3" | "clear" | "setSync" | "testConnection"
  > = {
    view: async () => {
      calls.push({ method: "view" });
      return view;
    },
    chooseFolder: async (input) => {
      calls.push({ method: "chooseFolder", input });
      return view;
    },
    configureS3: async (input) => {
      calls.push({ method: "configureS3", input });
      return view;
    },
    clear: async (input) => {
      calls.push({ method: "clear", input });
      return view;
    },
    setSync: async (input) => {
      calls.push({ method: "setSync", input });
      return view;
    },
    testConnection: async () => {
      calls.push({ method: "testConnection" });
      return {
        kind: "replica-store-connection-tested",
        outcome: "reachable",
        message: "Octant wrote a probe file in the folder.",
      };
    },
  };
  return { calls, instance };
}

function windowStore(): WindowAuthorityStore {
  return {
    authenticate: vi.fn(() => windowId),
  } as unknown as WindowAuthorityStore;
}

function handler(
  options: {
    readonly resolveFolderCandidate?: (windowId: WindowId, input: unknown) => Promise<string>;
  } = {},
) {
  const fake = service();
  const resolved: Array<{ readonly windowId: WindowId; readonly input: unknown }> = [];
  const route = createReplicaStoreSettingsRouteHandler({
    service: fake.instance,
    windowAuthorityStore: windowStore(),
    resolveFolderCandidate:
      options.resolveFolderCandidate ??
      (async (id, input) => {
        resolved.push({ windowId: id, input });
        return "/Users/example/Sync";
      }),
  });
  return { route, calls: fake.calls, resolved };
}

function localWindow(request: Request): Request {
  bindPrincipalRouteContext(request, {
    principal: { kind: "local-window", windowId, capabilityGeneration: 1 },
    scopeId: windowId,
  });
  return request;
}

function command(body: unknown, host = "127.0.0.1:13773"): Request {
  return new Request(`http://${host}/api/replica-store/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-octant-window-capability": "capability" },
    body: JSON.stringify(body),
  });
}

describe("replica store settings routes", () => {
  it("answers only the sync settings paths", async () => {
    const { route } = handler();
    expect(await route(new Request("http://127.0.0.1:13773/api/replica-membership/commands"))).toBe(
      undefined,
    );
  });

  it("refuses a request that did not arrive on a loopback host name", async () => {
    const { route, calls } = handler();
    const response = await route(
      localWindow(
        new Request("http://192.168.50.10:13773/api/replica-store/settings", {
          headers: { "x-octant-window-capability": "capability" },
        }),
      ),
    );
    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses a paired remote device even though the transport accepted it", async () => {
    const { route, calls } = handler();
    const request = command({
      schemaVersion: 1,
      kind: "set-sync",
      syncOn: true,
      expectedVersion: 0,
    });
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
      scopeId: decodeWindowId("00000000-0000-4000-8000-00000000c001"),
    });
    const response = await route(request);
    expect(response?.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a read without a window capability", async () => {
    const route = createReplicaStoreSettingsRouteHandler({
      service: service().instance,
      windowAuthorityStore: {
        authenticate: vi.fn(() => {
          throw new WindowAuthorityError("unauthorized", "Window capability is invalid.");
        }),
      } as unknown as WindowAuthorityStore,
      resolveFolderCandidate: async () => "/Users/example/Sync",
    });
    const response = await route(new Request("http://127.0.0.1:13773/api/replica-store/settings"));
    expect(response?.status).toBe(401);
  });

  it("refuses a renderer origin that is not this machine", async () => {
    const { route, calls } = handler();
    const response = await route(
      localWindow(
        new Request("http://127.0.0.1:13773/api/replica-store/settings", {
          headers: { origin: "https://octant.example", "x-octant-window-capability": "capability" },
        }),
      ),
    );
    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("reads the view for a local window", async () => {
    const { route } = handler();
    const response = await route(
      localWindow(
        new Request("http://127.0.0.1:13773/api/replica-store/settings", {
          headers: { "x-octant-window-capability": "capability" },
        }),
      ),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(view);
  });

  it("resolves a chosen folder from this window's browser candidate, never from a path", async () => {
    const { route, calls, resolved } = handler();
    const response = await route(
      localWindow(
        command({
          schemaVersion: 1,
          kind: "choose-synced-folder",
          mode: "work",
          candidateId,
          expectedVersion: 0,
        }),
      ),
    );
    expect(response?.status).toBe(200);
    expect(resolved).toEqual([{ windowId, input: { hostId: "local", mode: "work", candidateId } }]);
    expect(calls).toEqual([
      { method: "chooseFolder", input: { folder: "/Users/example/Sync", expectedVersion: 0 } },
    ]);
  });

  it("refuses a candidate the folder browser no longer holds", async () => {
    const { route, calls } = handler({
      resolveFolderCandidate: async () => {
        throw new Error("expired");
      },
    });
    const response = await route(
      localWindow(
        command({
          schemaVersion: 1,
          kind: "choose-synced-folder",
          mode: "work",
          candidateId,
          expectedVersion: 0,
        }),
      ),
    );
    expect(await response?.json()).toMatchObject({
      kind: "replica-store-refused",
      reason: "candidate-unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("refuses a plaintext endpoint without echoing the key pair it carried", async () => {
    const { route, calls } = handler();
    const response = await route(
      localWindow(
        command({
          schemaVersion: 1,
          kind: "configure-s3",
          settings: {
            endpoint: "http://s3.example.test",
            region: "eu-north-1",
            bucket: "octant-sync",
            addressing: "path",
          },
          credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
          expectedVersion: 0,
        }),
      ),
    );
    const text = await response?.text();
    expect(response?.status).toBe(200);
    expect(JSON.parse(text ?? "{}")).toMatchObject({
      kind: "replica-store-refused",
      reason: "malformed",
    });
    expect(text).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });

  it("runs Test connection for a local window", async () => {
    const { route, calls } = handler();
    const response = await route(
      localWindow(command({ schemaVersion: 1, kind: "test-connection" })),
    );
    expect(await response?.json()).toMatchObject({ outcome: "reachable" });
    expect(calls).toEqual([{ method: "testConnection" }]);
  });
});

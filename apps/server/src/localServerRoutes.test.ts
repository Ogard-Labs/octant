import { describe, expect, it, vi } from "vitest";
import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import type { CodeCheckoutIdentity, CodeThread } from "@octant/contracts";
import type { ObservedLocalListener } from "./localServers/localListenerPort";
import { createCodeThreadLocalServerScopeResolver } from "./localServers/localServerScopeResolver";
import { LocalServerService } from "./localServers/localServerService";
import {
  createLocalServerRouteHandler,
  type LocalServerRouteDependencies,
} from "./localServerRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000902");
const threadId = "00000000-0000-4000-8000-000000000903";
const requestId = "00000000-0000-4000-8000-000000000904";
const commandsUrl = "http://127.0.0.1/api/code/local-servers/commands";

const listCommand = { kind: "list-local-servers", requestId, threadId, projectId } as const;

const listedResult = {
  kind: "local-servers-listed",
  requestId,
  snapshot: {
    threadId,
    projectId,
    currentCheckout: [],
    other: [],
    observedAt: "2026-08-14T08:00:00.000Z",
  },
} as const;

function createRoute(
  options: {
    readonly accessible?: boolean;
    readonly projectType?: "code" | "work";
    readonly execute?: LocalServerRouteDependencies["service"]["execute"];
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const execute = options.execute ?? vi.fn().mockResolvedValue(listedResult);
  const handler = createLocalServerRouteHandler({
    service: { execute },
    persistence: {
      readProject: vi.fn((id) =>
        String(id) !== String(projectId)
          ? undefined
          : ({
              id: projectId,
              name: "Octant",
              type: options.projectType ?? "code",
              lifecycle: "active",
              binding: { canonicalRoot: "/repo" },
            } as never),
      ),
    },
    projects: {
      bootstrap: vi.fn().mockResolvedValue({
        active:
          options.accessible === false
            ? []
            : [
                {
                  id: projectId,
                  name: "Octant",
                  type: options.projectType ?? "code",
                  lifecycle: "active",
                },
              ],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    windowAuthorityStore: store,
    now: () => 1,
  });
  return { handler, execute };
}

const authHeaders = {
  "content-type": "application/json",
  "x-octant-window-capability": capability,
};

function post(body: unknown, headers: Record<string, string> = authHeaders, url = commandsUrl) {
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("Local servers routes", () => {
  it("ignores paths it does not own", async () => {
    const { handler } = createRoute();
    expect(await handler(new Request("http://127.0.0.1/api/code/bootstrap"))).toBeUndefined();
  });

  it("rejects a non-loopback host before touching authority", async () => {
    const { handler, execute } = createRoute();
    const response = await handler(
      post(listCommand, authHeaders, "http://example.com/api/code/local-servers/commands"),
    );
    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a renderer origin that is not allowed", async () => {
    const { handler } = createRoute();
    const response = await handler(
      post(listCommand, { ...authHeaders, origin: "http://evil.example" }),
    );
    expect(response?.status).toBe(400);
  });

  it("answers preflight with the allowed methods", async () => {
    const { handler } = createRoute();
    const response = await handler(new Request(commandsUrl, { method: "OPTIONS" }));
    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  it("rejects an unauthenticated command", async () => {
    const { handler, execute } = createRoute();
    const response = await handler(post(listCommand, { "content-type": "application/json" }));
    expect(response?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a Local servers command", async () => {
    const { handler, execute } = createRoute();
    const response = await handler(post({ kind: "stop-everything" }));
    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before parsing", async () => {
    const { handler, execute } = createRoute();
    const response = await handler(
      new Request(commandsUrl, {
        method: "POST",
        headers: { ...authHeaders, "content-length": "999999999" },
        body: JSON.stringify(listCommand),
      }),
    );
    expect(response?.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it("re-checks Project access per request", async () => {
    const { handler, execute } = createRoute({ accessible: false });
    const response = await handler(post(listCommand));
    expect(response?.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a Work Project on the Code-only surface", async () => {
    const { handler, execute } = createRoute({ projectType: "work" });
    expect((await handler(post(listCommand)))?.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands an authorized command to the service and returns its typed result", async () => {
    const { handler, execute } = createRoute();
    const response = await handler(post(listCommand));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(listedResult);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports a service failure as unavailable rather than leaking the error", async () => {
    const { handler } = createRoute({
      execute: vi.fn().mockRejectedValue(new Error("lsof exploded at /Users/example")),
    });
    const response = await handler(post(listCommand));
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain("example");
  });
});

// The actor the policy decides on must be the principal that authenticated the
// request. These exercise the route, the service, and the scope resolver
// together because the escalation lives in the seam between them: every unit is
// individually correct while the remote principal never reaches the policy.
const checkoutRoot = "/repo";
const checkoutId = "00000000-0000-4000-8000-000000000905";
const deviceId = "00000000-0000-4000-8000-000000000906";

const leftoverListener: ObservedLocalListener = {
  pid: 9001,
  port: 3000,
  processName: "node",
  ownership: "current-user",
  workingDirectory: `${checkoutRoot}/apps/web`,
  lineage: ["Visual Studio Code"],
  bindAddress: "127.0.0.1",
};

const leftoverConfirmation = {
  acknowledgedProcessName: "node",
  acknowledgedPort: 3000,
  acknowledgedWorkingDirectory: `${checkoutRoot}/apps/web`,
} as const;

function createBoundRoute() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const stop = vi.fn(async () => "stopped" as const);
  const bootstrap = vi.fn().mockResolvedValue({
    active: [
      {
        id: projectId,
        name: "Octant",
        type: "code",
        lifecycle: "active",
        binding: { canonicalRoot: checkoutRoot },
      },
    ],
    archived: [],
    availability: [],
    memory: [],
  });
  const service = new LocalServerService({
    listeners: { observe: async () => ({ status: "observed", listeners: [leftoverListener] }) },
    health: {
      probe: async () => ({ scheme: "http", host: "127.0.0.1", health: "listening" }),
    },
    stopPort: { stop },
    scopes: createCodeThreadLocalServerScopeResolver({
      projects: { bootstrap } as never,
      source: {
        readThread: () =>
          ({
            id: threadId,
            projectId,
            checkoutId,
            executionPolicy: "full-access",
          }) as unknown as CodeThread,
        readCheckout: () => ({ id: checkoutId }) as unknown as CodeCheckoutIdentity,
        resolveCheckoutRoot: async () => checkoutRoot,
        ownedPids: () => new Set<number>(),
      },
    }),
    clock: () => "2026-08-14T08:00:00.000Z",
  });
  const handler = createLocalServerRouteHandler({
    service,
    persistence: {
      readProject: vi.fn(
        () =>
          ({
            id: projectId,
            name: "Octant",
            type: "code",
            lifecycle: "active",
            binding: { canonicalRoot: checkoutRoot },
          }) as never,
      ),
    },
    projects: { bootstrap },
    windowAuthorityStore: store,
    now: () => 1,
  });
  return { handler, stop };
}

function remotePost(body: unknown) {
  const request = new Request(commandsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  bindPrincipalRouteContext(request, {
    principal: {
      kind: "remote-device",
      hostId: "local",
      deviceId,
      credentialGeneration: 1,
      origin: "https://remote.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "00000000-0000-4000-8000-000000000907",
    } as never,
    scopeId: decodeWindowId(deviceId),
  });
  return request;
}

describe("Local servers principal authority", () => {
  it("denies a paired remote device the leftover stop instead of offering confirmation", async () => {
    const { handler, stop } = createBoundRoute();

    const listed = await (await handler(remotePost(listCommand)))?.json();
    expect(listed.kind).toBe("local-servers-listed");
    // A confirmable row published to a paired device is itself the leak: the
    // client can echo the facts back as a confirmation.
    expect(listed.snapshot.currentCheckout[0].stop).toEqual({
      status: "unavailable",
      reason: "Stopping a leftover server must happen on the host, not from a paired device.",
    });

    const stopped = await (
      await handler(
        remotePost({
          kind: "stop-local-server",
          requestId,
          threadId,
          projectId,
          listenerId: listed.snapshot.currentCheckout[0].listenerId,
          confirmation: leftoverConfirmation,
        }),
      )
    )?.json();
    expect(stopped).toMatchObject({
      kind: "local-server-rejected",
      failure: { category: "local-host-required" },
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("still offers the local window the leftover confirmation and honours it", async () => {
    const { handler, stop } = createBoundRoute();

    const listed = await (await handler(post(listCommand)))?.json();
    expect(listed.snapshot.currentCheckout[0].stop).toEqual({
      status: "available",
      confirmationRequired: true,
    });
    const listenerId = listed.snapshot.currentCheckout[0].listenerId;

    const unconfirmed = await (
      await handler(post({ kind: "stop-local-server", requestId, threadId, projectId, listenerId }))
    )?.json();
    expect(unconfirmed).toMatchObject({ failure: { category: "confirmation-required" } });
    expect(stop).not.toHaveBeenCalled();

    const confirmed = await (
      await handler(
        post({
          kind: "stop-local-server",
          requestId,
          threadId,
          projectId,
          listenerId,
          confirmation: leftoverConfirmation,
        }),
      )
    )?.json();
    expect(confirmed.kind).toBe("local-server-stopped");
    expect(stop).toHaveBeenCalledWith({ pid: 9001 });
  });
});

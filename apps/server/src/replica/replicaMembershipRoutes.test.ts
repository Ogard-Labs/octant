import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import {
  ReplicaInstanceId,
  type ReplicaMembershipResult,
  type ReplicaMembershipView,
} from "@octant/contracts";
import { LOCAL_HOST_ID, decodeWindowId } from "@octant/contracts";
import type { WindowAuthorityStore } from "../windowAuthorityStore";

const decodeInstanceId = Schema.decodeUnknownSync(ReplicaInstanceId);
import {
  createReplicaMembershipRouteHandler,
  createReplicaSyncStatusRouteHandler,
} from "./replicaMembershipRoutes";
import { replicaMembershipView } from "./replicaMembershipView";
import { ReplicaMembershipProjection } from "./replicaMembershipProjection";
import { ReplicaMembershipService } from "./replicaMembershipService";

const capability = "capability-test";
const emptyView = replicaMembershipView({
  state: new ReplicaMembershipProjection().state(),
  now: 0,
  computerName: "Studio Mac",
});
const memberId = "11111111-1111-4111-8111-111111111111";
const memberView: ReplicaMembershipView = {
  ...emptyView,
  thisComputer: {
    kind: "founder",
    instanceId: decodeInstanceId(memberId),
    displayName: "Studio Mac",
  },
  members: [
    {
      instanceId: decodeInstanceId(memberId),
      displayName: "Studio Mac",
      role: { kind: "founder" },
      revoked: false,
      thisComputer: true,
      revocable: false,
    },
  ],
};
const thisHost = "00000000-0000-4000-8000-00000000c002";

function remoteDevice(hostId: string) {
  return {
    kind: "remote-device" as const,
    deviceId: Schema.decodeUnknownSync(DeviceId)("00000000-0000-4000-8000-00000000c001"),
    hostId: Schema.decodeUnknownSync(StableHostId)(hostId),
    credentialGeneration: 1,
    origin: "https://octant.example",
    protocolVersion: 1,
    capabilityDigest: "b".repeat(64),
    sessionId: Schema.decodeUnknownSync(RemoteSessionId)("00000000-0000-4000-8000-00000000c003"),
  };
}

const localWindow = {
  principal: {
    kind: "local-window" as const,
    windowId: "00000000-0000-4000-8000-0000000000a1",
    capabilityGeneration: 1,
  },
  scopeId: decodeWindowId("00000000-0000-4000-8000-0000000000a1"),
};

function makeRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:13773/api/replica-membership/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function service(results: ReadonlyArray<ReplicaMembershipResult>) {
  const calls: unknown[] = [];
  const queue = [...results];
  return {
    calls,
    instance: {
      async execute(command: unknown) {
        calls.push(command);
        const next = queue.shift();
        if (next === undefined) throw new Error("no scripted result");
        return next;
      },
    },
  };
}

function windowStore(): WindowAuthorityStore {
  return {
    issue: vi.fn(async () => capability),
    verify: vi.fn(async () => true),
  } as unknown as WindowAuthorityStore;
}

describe("replica membership routes", () => {
  it("refuses a request that is not a POST", async () => {
    const { instance } = service([]);
    const handler = createReplicaMembershipRouteHandler({
      service: instance as never,
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
    });
    const response = await handler(
      new Request("http://127.0.0.1:13773/api/replica-membership/commands"),
    );
    expect(response?.status).toBe(400);
  });

  it("refuses a paired remote device even though the transport accepted it", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const { instance, calls } = service([]);
    const handler = createReplicaMembershipRouteHandler({
      service: instance as never,
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
    });
    const request = makeRequest({
      kind: "revoke",
      subject: "11111111-1111-4111-8111-111111111111",
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
    const response = await handler(request);
    expect(response?.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("refuses a malformed command before the service runs", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const { instance, calls } = service([]);
    const handler = createReplicaMembershipRouteHandler({
      service: instance as never,
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
    });
    const request = makeRequest({ kind: "not-a-command" });
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "local-window",
        windowId: "00000000-0000-4000-8000-0000000000a1",
        capabilityGeneration: 1,
      },
      scopeId: decodeWindowId("00000000-0000-4000-8000-0000000000a1"),
    });
    const response = await handler(request);
    expect(response?.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("decodes a command with the contract and refuses a subject that is not an instance id", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const { instance, calls } = service([]);
    const handler = createReplicaMembershipRouteHandler({
      service: instance as never,
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
    });
    const request = makeRequest({ kind: "revoke", subject: "../../escape" });
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "local-window",
        windowId: "00000000-0000-4000-8000-0000000000a1",
        capabilityGeneration: 1,
      },
      scopeId: decodeWindowId("00000000-0000-4000-8000-0000000000a1"),
    });
    const response = await handler(request);
    expect(response?.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it("stops and resumes a restore for a local window, and refuses a paired device", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const { instance, calls } = service([]);
    const restoreCalls: string[] = [];
    const handler = createReplicaMembershipRouteHandler({
      service: instance as never,
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
      restore: {
        stop: () => {
          restoreCalls.push("stop");
          return { kind: "restore", restore: { state: "stopped", done: 25, total: 60 } };
        },
        resume: () => {
          restoreCalls.push("resume");
          return { kind: "restore", restore: { state: "running", done: 25, total: 60 } };
        },
      },
    });
    const stop = makeRequest({ kind: "stop-restore" });
    bindPrincipalRouteContext(stop, localWindow);
    const stopped = await handler(stop);
    expect(stopped?.status).toBe(200);
    expect(await stopped?.json()).toEqual({
      kind: "restore",
      restore: { state: "stopped", done: 25, total: 60 },
    });
    const resume = makeRequest({ kind: "resume-restore" });
    bindPrincipalRouteContext(resume, {
      principal: remoteDevice(thisHost),
      scopeId: localWindow.scopeId,
    });
    expect((await handler(resume))?.status).toBe(403);
    expect(restoreCalls).toEqual(["stop"]);
    expect(calls).toEqual([]);
  });

  it("stops a join confirmation's read for a local window at once, and refuses a paired device", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const { instance, calls } = service([]);
    const stops: string[] = [];
    const handler = createReplicaMembershipRouteHandler({
      service: {
        ...instance,
        stopJoinRead: () => {
          stops.push("stop");
          return { kind: "join-read", joinRead: { state: "stopped", done: 25, total: 62 } };
        },
      } as never,
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
    });
    const stop = makeRequest({ kind: "stop-join-read" });
    bindPrincipalRouteContext(stop, localWindow);
    const stopped = await handler(stop);
    expect(stopped?.status).toBe(200);
    expect(await stopped?.json()).toEqual({
      kind: "join-read",
      joinRead: { state: "stopped", done: 25, total: 62 },
    });
    const remote = makeRequest({ kind: "stop-join-read" });
    bindPrincipalRouteContext(remote, {
      principal: remoteDevice(thisHost),
      scopeId: localWindow.scopeId,
    });
    expect((await handler(remote))?.status).toBe(403);
    expect(stops).toEqual(["stop"]);
    expect(calls).toEqual([]);
  });

  it("answers a typed not-configured refusal when the host has no replica store", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const projection = new ReplicaMembershipProjection();
    const journaled: unknown[] = [];
    const handler = createReplicaMembershipRouteHandler({
      service: new ReplicaMembershipService({
        store: () => ({ status: "not-configured" }),
        credentials: {
          create: async () => {
            throw new Error("no store, no key");
          },
          sign: async () => {
            throw new Error("no store, no key");
          },
        },
        journal: { append: (event) => journaled.push(event) },
        state: () => projection.state(),
        localHostId: LOCAL_HOST_ID,
        clock: () => 0,
      }),
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
    });
    const request = makeRequest({ kind: "pull" });
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "local-window",
        windowId: "00000000-0000-4000-8000-0000000000a1",
        capabilityGeneration: 1,
      },
      scopeId: decodeWindowId("00000000-0000-4000-8000-0000000000a1"),
    });
    const response = await handler(request);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ kind: "refused", reason: "not-configured" });
    expect(journaled).toHaveLength(1);
  });

  it("reads the full membership view for a local window only", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const { instance, calls } = service([]);
    const handler = createReplicaMembershipRouteHandler({
      service: instance as never,
      view: () => memberView,
      windowAuthorityStore: windowStore(),
    });
    const local = new Request("http://127.0.0.1:13773/api/replica-membership/state");
    bindPrincipalRouteContext(local, localWindow);
    const read = await handler(local);
    expect(read?.status).toBe(200);
    expect(await read?.json()).toEqual(memberView);

    const remote = new Request("http://127.0.0.1:13773/api/replica-membership/state");
    bindPrincipalRouteContext(remote, {
      principal: remoteDevice(thisHost),
      scopeId: decodeWindowId("00000000-0000-4000-8000-0000000000a2"),
    });
    const refused = await handler(remote);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ message: "Replica membership is host-only." });
    expect(calls).toHaveLength(0);
  });

  it("answers the packaged renderer's preflight and refuses a foreign origin", async () => {
    const { instance } = service([]);
    const handler = createReplicaMembershipRouteHandler({
      service: instance as never,
      view: () => emptyView,
      windowAuthorityStore: windowStore(),
      allowedRendererHttpOrigin: null,
    });
    const preflight = await handler(
      new Request("http://127.0.0.1:13773/api/replica-membership/commands", {
        method: "OPTIONS",
        headers: { origin: "null" },
      }),
    );
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("access-control-allow-origin")).toBe("null");
    const foreign = await handler(
      new Request("http://127.0.0.1:13773/api/replica-membership/state", {
        headers: { origin: "https://octant.example" },
      }),
    );
    expect(foreign?.status).toBe(400);
  });
});

describe("replica sync status route", () => {
  it("lets a paired device of this host read status, with no codes, requests, or ids", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const handler = createReplicaSyncStatusRouteHandler({
      windowAuthorityStore: windowStore(),
      hostId: () => thisHost,
      view: () => ({
        ...memberView,
        joinRequests: [],
      }),
    });
    const request = new Request("http://127.0.0.1:13773/api/replica-sync/status");
    bindPrincipalRouteContext(request, {
      principal: remoteDevice(thisHost),
      scopeId: decodeWindowId("00000000-0000-4000-8000-0000000000a2"),
    });
    const response = await handler(request);
    expect(response?.status).toBe(200);
    const body: unknown = await response?.json();
    expect(body).toEqual({
      kind: "replica-sync-status",
      thisComputer: "founder",
      members: [
        {
          displayName: "Studio Mac",
          role: { kind: "founder" },
          revoked: false,
          thisComputer: true,
        },
      ],
      status: memberView.status,
    });
    expect(JSON.stringify(body)).not.toContain(memberId);
  });

  it("refuses a device paired with another host", async () => {
    const { bindPrincipalRouteContext } = await import("../principalRouteContext");
    const handler = createReplicaSyncStatusRouteHandler({
      windowAuthorityStore: windowStore(),
      hostId: () => thisHost,
      view: () => memberView,
    });
    const request = new Request("http://127.0.0.1:13773/api/replica-sync/status");
    bindPrincipalRouteContext(request, {
      principal: remoteDevice("00000000-0000-4000-8000-00000000c009"),
      scopeId: decodeWindowId("00000000-0000-4000-8000-0000000000a2"),
    });
    const response = await handler(request);
    expect(response?.status).toBe(403);
    expect(JSON.stringify(await response?.json())).not.toContain("Studio Mac");
  });
});

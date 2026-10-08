import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import type { ReplicaMembershipResult } from "@octant/contracts";
import { LOCAL_HOST_ID, decodeWindowId } from "@octant/contracts";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import { createReplicaMembershipRouteHandler } from "./replicaMembershipRoutes";
import { ReplicaMembershipProjection } from "./replicaMembershipProjection";
import { ReplicaMembershipService } from "./replicaMembershipService";

const capability = "capability-test";

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
});

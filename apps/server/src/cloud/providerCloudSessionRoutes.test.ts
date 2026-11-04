import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { Schema } from "effect";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { createProviderCloudSessionRoutes } from "./providerCloudSessionRoutes";
import { ProviderCloudSessionService } from "./providerCloudSessionService";
import { makeProviderCloudPorts } from "./providerCloudHttp";
import {
  makeOpenAiCloudSessionAdapter,
  supportsOpenAiCloudSessions,
} from "../providers/openAiCloudSessions";
import {
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstance,
  decodeProviderModelId,
} from "@octant/contracts";
import type { ProviderCloudJob } from "@octant/contracts/provider-cloud-sessions";
import { createHash } from "node:crypto";

describe("provider cloud routes", () => {
  it("refuses an old capability replaced under the same window while its body is arriving", async () => {
    const store = new WindowAuthorityStore();
    const windowId = decodeWindowId("a7550000-0000-4000-8000-000000000001");
    const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
    store.register({ windowId, capability, now: Date.now() });
    const execute = vi.fn(async () => ({ status: "ready" as const, profiles: [], jobs: [] }));
    const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const init = {
      method: "POST",
      headers: { "x-octant-window-capability": capability },
      duplex: "half",
      body: new ReadableStream<Uint8Array>({ start: body.resolve }),
    };
    const request = new Request("http://127.0.0.1:3100/api/provider-cloud", init);
    const response = createProviderCloudSessionRoutes({
      service: { execute },
      windowAuthorityStore: store,
    })(request);
    store.revoke(windowId);
    store.register({
      windowId,
      capability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4",
      now: Date.now(),
    });
    const stream = await body.promise;
    stream.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ kind: "opt-in", instanceId: windowId, enabled: true }),
      ),
    );
    stream.close();
    expect((await response)?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("carries the exact window capability through a delayed credential unlock before create dispatch", async () => {
    const store = new WindowAuthorityStore();
    const windowId = decodeWindowId("a7550000-0000-4000-8000-000000000001");
    const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
    store.register({ windowId, capability, now: Date.now() });
    const threadId = decodeCodeThreadId("a7550000-0000-4000-8000-000000000002");
    const now = "2026-11-04T12:00:00.000Z";
    const instance = decodeProviderInstance({
      id: windowId,
      driverKind: "openai-compatible",
      displayName: "Fixture",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://api.openai.com/v1",
        authentication: "bearer",
        protocol: "responses",
        manualModelIds: ["fixture-model"],
      },
    });
    const jobs = new Map<string, ProviderCloudJob>();
    const unlock = Promise.withResolvers<string>();
    const unlocking = Promise.withResolvers<void>();
    let enabled = false;
    let calls = 0;
    let usage = 0;
    const service = new ProviderCloudSessionService({
      now: () => now,
      instances: () => [instance],
      supports: supportsOpenAiCloudSessions,
      models: () => [decodeProviderModelId("fixture-model")],
      canManageProvider: () => true,
      context: () => ({
        threadId,
        projectId: decodeProjectId("a7550000-0000-4000-8000-000000000003"),
        executionPolicy: "full-access",
        current: () => true,
        canSubmit: () => true,
        requiresUnsupportedBound: () => false,
      }),
      store: {
        get: (id) => jobs.get(id),
        put: (job) => {
          jobs.set(job.id, job);
          return job;
        },
        list: () => [...jobs.values()],
        active: () => [...jobs.values()].filter((job) => job.state === "submitting"),
        enabled: () => enabled,
        setEnabled: (_id, value) => {
          enabled = value;
        },
        hasCreateDispatch: () => usage > 0,
      },
      adapter: (_instance, intent, admission = () => true, onCreated) =>
        makeOpenAiCloudSessionAdapter({
          instanceId: instance.id,
          ports: makeProviderCloudPorts({
            instanceId: instance.id,
            intent,
            admission,
            ...(onCreated === undefined ? {} : { onCreated }),
            credentialResolver: {
              has: async () => true,
              resolve: () => {
                unlocking.resolve();
                return unlock.promise;
              },
            },
            onCreateDispatch: () => {
              usage += 1;
            },
            fetch: async () => {
              calls += 1;
              return Response.json({ id: "sess_fixture", status: "idle" });
            },
          }),
        }),
    });
    const route = createProviderCloudSessionRoutes({ service, windowAuthorityStore: store });
    const request = (body: unknown) =>
      new Request("http://127.0.0.1:3100/api/provider-cloud", {
        method: "POST",
        headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await route(request({ kind: "opt-in", instanceId: instance.id, enabled: true }));
    const input = "Synthetic reviewed input";
    const response = route(
      request({
        kind: "start",
        jobId: "a7550000-0000-4000-8000-000000000004",
        threadId,
        instanceId: instance.id,
        modelId: "fixture-model",
        input,
        reviewedInputDigest: createHash("sha256").update(input).digest("hex"),
        cloudExecutionConsent: true,
      }),
    );
    await unlocking.promise;
    store.revoke(windowId);
    store.register({
      windowId,
      capability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4",
      now: Date.now(),
    });
    unlock.resolve("synthetic-not-an-account-key");
    expect((await response)?.status).toBe(403);
    expect(calls).toBe(0);
    expect(usage).toBe(0);
    await service.close();
  });

  it("requires a local authenticated window and strict data-transfer commands before service admission", async () => {
    const store = new WindowAuthorityStore();
    const windowId = decodeWindowId("a7550000-0000-4000-8000-000000000001");
    const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
    store.register({ windowId, capability, now: Date.now() });
    const execute = vi.fn(async () => ({ status: "ready" as const, profiles: [], jobs: [] }));
    const route = createProviderCloudSessionRoutes({
      service: { execute },
      windowAuthorityStore: store,
    });
    const request = (authorized = true, body: unknown = { kind: "profiles" }) =>
      new Request("http://127.0.0.1:3100/api/provider-cloud", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { "x-octant-window-capability": capability } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await route(request(false)))?.status).toBe(400);
    expect((await route(request(true, { kind: "profiles", projectId: "forged" })))?.status).toBe(
      400,
    );
    expect(execute).not.toHaveBeenCalled();
    const remote = request();
    bindPrincipalRouteContext(remote, {
      scopeId: windowId,
      principal: {
        kind: "remote-device",
        deviceId: Schema.decodeUnknownSync(DeviceId)(windowId),
        hostId: Schema.decodeUnknownSync(StableHostId)(windowId),
        credentialGeneration: 1,
        origin: "https://fixture.invalid",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: Schema.decodeUnknownSync(RemoteSessionId)(windowId),
      },
    });
    expect((await route(remote))?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect((await route(request()))?.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

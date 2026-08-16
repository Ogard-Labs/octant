import { decodeProviderInstanceId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { ProviderServiceError } from "./providerService";
import { createProviderRouteHandler } from "./providerRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000020");
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000021");
const command = {
  kind: "create-opencode-provider",
  instanceId,
  expectedVersion: 0,
  displayName: "OpenCode local",
  binaryPath: "/opt/homebrew/bin/opencode",
} as const;

describe("ProviderRoutes", () => {
  it("leaves OPTIONS requests for unknown provider routes unhandled", async () => {
    const route = routeFixture({});

    await expect(
      route(new Request("http://127.0.0.1/api/providers/not-real", { method: "OPTIONS" })),
    ).resolves.toBeUndefined();
  });

  it("authenticates provider commands without accepting caller authority", async () => {
    const execute = vi.fn(() => ({ kind: "provider-created", instance: provider() }));
    const route = routeFixture({ execute });
    const response = await route(
      new Request("http://127.0.0.1/api/providers/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(command),
      }),
    );
    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(windowId, command);
    expect(JSON.stringify(await response?.json())).not.toMatch(/password|token|serverUrl/i);

    const forged = await route(
      new Request("http://127.0.0.1/api/providers/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ ...command, windowId }),
      }),
    );
    expect(forged?.status).toBe(400);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enforces loopback, origin, capability, query, and method policy", async () => {
    const route = routeFixture({});
    const headers = { "x-octant-window-capability": capability };
    for (const request of [
      new Request("http://example.com/api/providers/bootstrap", { headers }),
      new Request("http://127.0.0.1/api/providers/bootstrap", {
        headers: { ...headers, origin: "https://evil.example" },
      }),
      new Request("http://127.0.0.1/api/providers/bootstrap?windowId=x", { headers }),
      new Request("http://127.0.0.1/api/providers/bootstrap", { method: "POST", headers }),
      new Request("http://127.0.0.1/api/providers/bootstrap"),
    ]) {
      expect((await route(request))?.status).toBeLessThan(500);
      expect((await route(request.clone()))?.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("limits command and probe bodies before service invocation", async () => {
    const execute = vi.fn();
    const probe = vi.fn();
    const route = routeFixture({ execute, probe }, 16);
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const commandResponse = await route(
      new Request("http://127.0.0.1/api/providers/commands", {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      }),
    );
    const probeResponse = await route(
      new Request(`http://127.0.0.1/api/providers/${instanceId}/probe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ padding: "too large" }),
      }),
    );
    expect(commandResponse?.status).toBe(413);
    expect(probeResponse?.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("decodes probe paths and maps only typed provider failures", async () => {
    const probe = vi.fn(() => observation());
    const route = routeFixture({ probe });
    const response = await route(
      new Request(`http://127.0.0.1/api/providers/${instanceId}/probe`, {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
    expect(probe).toHaveBeenCalledWith(windowId, instanceId);

    const failed = routeFixture({
      bootstrap: vi.fn(() => {
        throw new ProviderServiceError({
          category: "unavailable",
          message: "Provider registry unavailable.",
        });
      }),
    });
    const unavailable = await failed(
      new Request("http://127.0.0.1/api/providers/bootstrap", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(unavailable?.status).toBe(503);
    expect(await unavailable?.json()).toEqual({
      category: "unavailable",
      message: "Provider registry unavailable.",
    });
  });

  it("keeps packaged turn control disabled by default and authenticates it when enabled", async () => {
    const smokeTurn = vi.fn(() => ({
      events: [{ kind: "completed" }],
      observation: observation(),
    }));
    const disabled = routeFixture({ smokeTurn });
    const request = () =>
      new Request(`http://127.0.0.1/api/providers/${instanceId}/packaged-smoke-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          sessionId: "80000000-0000-4000-8000-000000000022",
          modelId: "model-a",
          prompt: "octant packaged smoke",
          action: "complete",
        }),
      });
    await expect(disabled(request())).resolves.toBeUndefined();
    expect(smokeTurn).not.toHaveBeenCalled();

    const enabled = routeFixture({ smokeTurn }, undefined, true);
    const response = await enabled(request());
    expect(response?.status).toBe(200);
    expect(smokeTurn).toHaveBeenCalledWith(windowId, instanceId, {
      sessionId: "80000000-0000-4000-8000-000000000022",
      modelId: "model-a",
      prompt: "octant packaged smoke",
      action: "complete",
    });

    const authorityResponse = await enabled(
      new Request(`http://127.0.0.1/api/providers/${instanceId}/packaged-smoke-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          sessionId: "80000000-0000-4000-8000-000000000024",
          modelId: "model-a",
          prompt: "octant packaged plan smoke",
          action: "complete",
          mode: "code",
          executionPolicy: "plan",
        }),
      }),
    );
    expect(authorityResponse?.status).toBe(200);
    expect(smokeTurn).toHaveBeenLastCalledWith(windowId, instanceId, {
      sessionId: "80000000-0000-4000-8000-000000000024",
      modelId: "model-a",
      prompt: "octant packaged plan smoke",
      action: "complete",
      mode: "code",
      executionPolicy: "plan",
    });

    for (const action of [
      { action: "answer-approval", approved: false },
      { action: "answer-question", answer: "bounded answer" },
    ] as const) {
      const actionResponse = await enabled(
        new Request(`http://127.0.0.1/api/providers/${instanceId}/packaged-smoke-turn`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({
            sessionId: "80000000-0000-4000-8000-000000000023",
            modelId: "model-a",
            prompt: "octant packaged smoke",
            ...action,
          }),
        }),
      );
      expect(actionResponse?.status).toBe(200);
      expect(smokeTurn).toHaveBeenLastCalledWith(windowId, instanceId, {
        sessionId: "80000000-0000-4000-8000-000000000023",
        modelId: "model-a",
        prompt: "octant packaged smoke",
        ...action,
      });
    }
  });
});

function routeFixture(
  overrides: Record<string, unknown>,
  maxRequestBodySize?: number,
  packagedProviderSmokeControl = false,
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createProviderRouteHandler({
    service: {
      bootstrap: vi.fn(() => ({
        instances: [],
        defaults: { permissionPersistence: "current-session", version: 0 },
        observedStates: [],
      })),
      execute: vi.fn(() => ({ kind: "provider-created", instance: provider() })),
      probe: vi.fn(() => observation()),
      ...overrides,
    } as never,
    windowAuthorityStore: store,
    now: () => 1,
    packagedProviderSmokeControl,
    ...(maxRequestBodySize === undefined ? {} : { maxRequestBodySize }),
  });
}

function provider() {
  return {
    id: instanceId,
    displayName: "OpenCode local",
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
  };
}

function observation() {
  const support = {
    streaming: "supported",
    resume: "supported",
    interruption: "supported",
    approvals: "supported",
    userQuestions: "supported",
    reasoning: "supported",
    usage: "supported",
    toolActivity: "supported",
    fileChanges: "supported",
    diffs: "supported",
    taskProgress: "supported",
    nativeChildAgents: "supported",
    nativeAttachments: "supported",
    nativeWebResearch: "supported",
    appManagedTools: "supported",
    citations: "supported",
  };
  return {
    instanceId,
    readiness: "ready",
    processState: "running",
    models: [],
    capabilities: support,
    observedAt: "2026-07-14T10:00:00.000Z",
  };
}

import { decodeAgentProfileId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { AgentProfileServiceError } from "./agentProfileService";
import { createAgentProfileRouteHandler } from "./agentProfileRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000020");
const profileId = decodeAgentProfileId("00000000-0000-0000-0000-000000000001");

const ts = "2026-07-25T10:00:00.000Z";

const sampleProfile = {
  id: profileId,
  displayName: "Code Reviewer",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "approval-gated" as const,
  defaultPermissionPersistence: "current-session" as const,
  compatibleModes: ["code" as const],
  version: 1,
  createdAt: ts,
  updatedAt: ts,
};

const createCommand = {
  kind: "create-agent-profile" as const,
  displayName: "Reviewer",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "plan" as const,
  defaultPermissionPersistence: "current-session" as const,
  compatibleModes: ["code" as const],
  scope: { scopeKind: "user" as const, scopeRef: "00000000-0000-0000-0000-000000000010" },
};

const resolveRequest = {
  mode: "code" as const,
  hostId: "local",
  projectExecutionPolicy: "approval-gated" as const,
  scope: { scopeKind: "user" as const, scopeRef: "00000000-0000-0000-0000-000000000010" },
};

describe("AgentProfileRoutes", () => {
  it("leaves unknown routes unhandled", async () => {
    const route = routeFixture({});
    await expect(
      route(new Request("http://127.0.0.1/api/agent-profiles/not-real", { method: "OPTIONS" })),
    ).resolves.toBeUndefined();
  });

  it("returns 401 when capability is missing", async () => {
    const route = routeFixture({});
    const response = await route(new Request("http://127.0.0.1/api/agent-profiles"));
    expect(response?.status).toBe(401);
  });

  it("rejects caller-supplied windowId in command body", async () => {
    const execute = vi.fn(() => ({ kind: "profile-created", profile: sampleProfile }));
    const route = routeFixture({ execute });
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ ...createCommand, windowId }),
      }),
    );
    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces loopback, origin, query, and method policy", async () => {
    const route = routeFixture({});
    const headers = { "x-octant-window-capability": capability };
    for (const request of [
      new Request("http://example.com/api/agent-profiles", { headers }),
      new Request("http://127.0.0.1/api/agent-profiles", {
        headers: { ...headers, origin: "https://evil.example" },
      }),
      new Request("http://127.0.0.1/api/agent-profiles?windowId=x", { headers }),
      new Request("http://127.0.0.1/api/agent-profiles", { method: "POST", headers }),
      new Request("http://127.0.0.1/api/agent-profiles"),
    ]) {
      expect((await route(request))?.status).toBeLessThan(500);
      expect((await route(request.clone()))?.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("lists profiles with authentication", async () => {
    const list = vi.fn(() => [sampleProfile]);
    const route = routeFixture({ list });
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toHaveLength(1);
    expect(body[0].displayName).toBe("Code Reviewer");
  });

  it("reads a single profile by id", async () => {
    const read = vi.fn(() => sampleProfile);
    const route = routeFixture({ read });
    const response = await route(
      new Request(`http://127.0.0.1/api/agent-profiles/${profileId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.id).toBe(profileId);
  });

  it("returns 404 when profile is not found", async () => {
    const read = vi.fn(() => undefined);
    const route = routeFixture({ read });
    const response = await route(
      new Request(`http://127.0.0.1/api/agent-profiles/${profileId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(404);
  });

  it("leaves non-UUID profile paths unhandled", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles/not-a-uuid", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response).toBeUndefined();
  });

  it("executes create command with authentication", async () => {
    const execute = vi.fn(() => ({ kind: "profile-created", profile: sampleProfile }));
    const route = routeFixture({ execute });
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(createCommand),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.kind).toBe("profile-created");
    expect(execute).toHaveBeenCalledWith(createCommand);
  });

  it("resolves effective profile with authentication", async () => {
    const resolveEffectiveProfile = vi.fn(() => ({
      providerInstanceId: "00000000-0000-0000-0000-000000000030",
      modelId: "gpt-4",
      hostId: "local",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      effectivePermissions: {
        filesystem: true,
        shell: true,
        git: true,
        network: false,
        tools: true,
        subagents: false,
      },
      source: "user-default",
      fallbackChain: ["one-off-override", "project-default", "mode-default", "user-default"],
      downgradeReasons: [],
    }));
    const route = routeFixture({ resolveEffectiveProfile });
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles/resolve-effective-profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(resolveRequest),
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.source).toBe("user-default");
    expect(body.fallbackChain).toEqual([
      "one-off-override",
      "project-default",
      "mode-default",
      "user-default",
    ]);
  });

  it("returns 400 for invalid resolution request", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles/resolve-effective-profile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ invalid: true }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("maps service errors to appropriate HTTP status codes", async () => {
    const execute = vi.fn(() => {
      throw new AgentProfileServiceError({
        reason: "stale-version",
        message: "Profile was modified by another session.",
      });
    });
    const route = routeFixture({ execute });
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(createCommand),
      }),
    );
    expect(response?.status).toBe(409);
    const body = await response?.json();
    expect(body.reason).toBe("stale-version");
  });

  it("returns 503 on unexpected service errors", async () => {
    const list = vi.fn(() => {
      throw new Error("unexpected");
    });
    const route = routeFixture({ list });
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(503);
  });

  it("limits command body size before service invocation", async () => {
    const execute = vi.fn();
    const route = routeFixture({ execute }, 16);
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(createCommand),
      }),
    );
    expect(response?.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it("handles OPTIONS preflight requests", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/agent-profiles", { method: "OPTIONS" }),
    );
    expect(response?.status).toBe(204);
  });
});

function routeFixture(overrides: Record<string, unknown>, maxRequestBodySize?: number) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createAgentProfileRouteHandler({
    service: {
      list: vi.fn(() => []),
      read: vi.fn(() => undefined),
      execute: vi.fn(() => ({ kind: "profile-created", profile: sampleProfile })),
      resolveEffectiveProfile: vi.fn(() => ({
        providerInstanceId: "00000000-0000-0000-0000-000000000030",
        modelId: "gpt-4",
        hostId: "local",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        effectivePermissions: {
          filesystem: true,
          shell: true,
          git: true,
          network: false,
          tools: true,
          subagents: false,
        },
        source: "none",
        fallbackChain: ["one-off-override", "project-default", "mode-default", "user-default"],
        downgradeReasons: [],
      })),
      ...overrides,
    } as never,
    windowAuthorityStore: store,
    now: () => 1,
    ...(maxRequestBodySize === undefined ? {} : { maxRequestBodySize }),
  });
}

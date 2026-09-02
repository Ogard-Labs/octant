import {
  decodeCodeThreadId,
  decodeMemoryEntryId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createProjectRouteHandler } from "./projectRoutes";
import { ProjectServiceError } from "./projectService";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000701");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000702");
const entryId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000703");
const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000704");

describe("Project routes", () => {
  it("authenticates an encoded environment request and returns the strict observation", async () => {
    const observation = {
      status: "ready",
      projectId,
      projectName: "Octant",
      repositoryRoot: "/repo",
      worktreeRoot: "/repo/.agent-worktrees/issue-52",
      branch: { kind: "named", name: "feature/issue-52" },
      changes: "dirty",
      observedAt: "2026-07-16T10:00:00.000Z",
    } as const;
    const observe = vi.fn().mockResolvedValue(observation);
    const route = routeFixture({}, { observe });
    const encodedProjectId = projectId.replace("0", "%30");

    const response = await route(
      new Request(`http://127.0.0.1/api/projects/${encodedProjectId}/environment`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(observation);
    expect(observe).toHaveBeenCalledWith(windowId, projectId, expect.any(AbortSignal));
  });

  it("rejects malformed environment IDs, query strings, and unsupported methods", async () => {
    const observe = vi.fn();
    const route = routeFixture({}, { observe });
    const headers = { "x-octant-window-capability": capability };

    expect(
      (await route(new Request("http://127.0.0.1/api/projects/%/environment", { headers })))
        ?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request(`http://127.0.0.1/api/projects/${projectId}/environment?windowId=forged`, {
            headers,
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request(`http://127.0.0.1/api/projects/${projectId}/environment`, {
            method: "POST",
            headers,
          }),
        )
      )?.status,
    ).toBe(400);
    expect(observe).not.toHaveBeenCalled();
  });

  it("routes a thread-scoped environment request with the authenticated window", async () => {
    const observeThread = vi.fn().mockResolvedValue({ status: "unavailable" });
    const route = routeFixture({}, { observeThread });

    const response = await route(
      new Request(`http://127.0.0.1/api/projects/${projectId}/environment?threadId=${threadId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    expect(observeThread).toHaveBeenCalledWith(
      windowId,
      projectId,
      threadId,
      expect.any(AbortSignal),
    );
  });

  it("routes an explicit environment refresh past the observation cache", async () => {
    const observeThread = vi.fn().mockResolvedValue({ status: "unavailable" });
    const route = routeFixture({}, { observeThread });

    const response = await route(
      new Request(
        `http://127.0.0.1/api/projects/${projectId}/environment?threadId=${threadId}&fresh=1`,
        { headers: { "x-octant-window-capability": capability } },
      ),
    );

    expect(response?.status).toBe(200);
    expect(observeThread).toHaveBeenCalledWith(
      windowId,
      projectId,
      threadId,
      expect.any(AbortSignal),
      true,
    );
  });

  it("rejects missing, forged, and expired capabilities for environment requests", async () => {
    const observe = vi.fn();
    const { route, now } = routeFixtureWithClock({}, undefined, { observe });
    const url = `http://127.0.0.1/api/projects/${projectId}/environment`;

    for (const token of [undefined, "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"]) {
      const response = await route(
        new Request(url, {
          headers: token === undefined ? {} : { "x-octant-window-capability": token },
        }),
      );
      expect(response?.status).toBe(401);
    }
    now.value = 24 * 60 * 60 * 1_000;
    expect(
      (
        await route(
          new Request(url, {
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(401);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", 400],
    ["not-found", 404],
    ["unavailable", 503],
  ] as const)("maps typed %s environment failures to %i", async (category, status) => {
    const observe = vi.fn().mockRejectedValue(
      new ProjectServiceError({
        category,
        message: "Environment observation failed.",
      }),
    );
    const route = routeFixture({}, { observe });

    const response = await route(
      new Request(`http://127.0.0.1/api/projects/${projectId}/environment`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(status);
    expect(await response?.json()).toEqual({
      category,
      message: "Environment observation failed.",
    });
  });

  it("authenticates a window capability and never accepts caller window identity", async () => {
    const executeProject = vi.fn(() => ({ kind: "chat-project-created", project: project() }));
    const route = routeFixture({ executeProject });
    const response = await route(
      new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "create-chat-project",
          hostId: "local",
          projectId,
          expectedVersion: 0,
          name: "Chat",
        }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(executeProject).toHaveBeenCalledWith(windowId, expect.objectContaining({ projectId }));

    for (const body of [
      { kind: "create-chat-project", projectId, expectedVersion: 0, name: "Chat", windowId },
    ]) {
      const forged = await route(
        new Request("http://127.0.0.1/api/projects/commands", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify(body),
        }),
      );
      expect(forged?.status).toBe(400);
    }
  });

  it("rejects missing, forged, and expired capabilities", async () => {
    const { route, now } = routeFixtureWithClock();
    for (const token of [undefined, "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"]) {
      const response = await route(
        new Request("http://127.0.0.1/api/projects/bootstrap", {
          headers: token === undefined ? {} : { "x-octant-window-capability": token },
        }),
      );
      expect(response?.status).toBe(401);
    }
    now.value = 24 * 60 * 60 * 1_000;
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/projects/bootstrap", {
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(401);
  });

  it("fails closed on origin, methods, query injection, and malformed JSON", async () => {
    const route = routeFixture({});
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/projects/bootstrap", {
            headers: {
              origin: "https://evil.example",
              "x-octant-window-capability": capability,
            },
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/projects/bootstrap?windowId=x", {
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/projects/search", {
            method: "POST",
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/projects/commands", {
            method: "POST",
            headers: { "x-octant-window-capability": capability },
            body: "{",
          }),
        )
      )?.status,
    ).toBe(400);
  });

  it("maps typed service conflicts without exposing internal details", async () => {
    const route = routeFixture({
      executeProject: vi.fn(() => {
        throw new ProjectServiceError({
          category: "conflict",
          message: "Project changed; reload and retry.",
          currentVersion: 3 as never,
        });
      }),
    });
    const response = await route(
      new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "create-chat-project",
          hostId: "local",
          projectId,
          expectedVersion: 0,
          name: "Chat",
        }),
      }),
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      category: "conflict",
      message: "Project changed; reload and retry.",
      currentVersion: 3,
    });
  });

  it("rejects oversized JSON before invoking the Project service", async () => {
    const executeProject = vi.fn();
    const { route } = routeFixtureWithClock({ executeProject }, 32);
    const response = await route(
      new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "create-chat-project",
          projectId,
          expectedVersion: 0,
          name: "This body exceeds the configured limit",
        }),
      }),
    );
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      category: "invalid",
      message: "Request body is too large.",
    });
    expect(executeProject).not.toHaveBeenCalled();
  });

  it("authenticates memory reads and commands without accepting caller authority", async () => {
    const memory = vi.fn(() => ({ projectId, active: [], history: [] }));
    const executeMemory = vi.fn(() => ({ kind: "memory-entry-created", entry: memoryEntry() }));
    const route = routeFixture({ memory, executeMemory });
    const read = await route(
      new Request(`http://127.0.0.1/api/projects/${projectId}/memory`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(read?.status).toBe(200);
    expect(memory).toHaveBeenCalledWith(projectId);

    const command = {
      kind: "create-memory-entry",
      projectId,
      entryId,
      memoryKind: "fact",
      content: "Explicit",
      expectedVersion: 0,
    };
    const write = await route(
      new Request("http://127.0.0.1/api/projects/memory/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(command),
      }),
    );
    expect(write?.status).toBe(200);
    expect(executeMemory).toHaveBeenCalledWith(command);

    const forged = await route(
      new Request("http://127.0.0.1/api/projects/memory/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ ...command, windowId }),
      }),
    );
    expect(forged?.status).toBe(400);
    expect(executeMemory).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed memory paths, query injection, methods, and forged transfer content", async () => {
    const executeMemory = vi.fn();
    const memory = vi.fn();
    const route = routeFixture({ executeMemory, memory });
    const headers = { "x-octant-window-capability": capability };
    expect(
      (await route(new Request("http://127.0.0.1/api/projects/not-a-uuid/memory", { headers })))
        ?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request(`http://127.0.0.1/api/projects/${projectId}/memory?windowId=x`, { headers }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request(`http://127.0.0.1/api/projects/${projectId}/memory`, {
            method: "POST",
            headers,
          }),
        )
      )?.status,
    ).toBe(400);
    const forged = await route(
      new Request("http://127.0.0.1/api/projects/memory/commands", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "transfer-memory-entry",
          sourceProjectId: projectId,
          sourceEntryId: entryId,
          destinationProjectId: projectId,
          destinationEntryId: decodeMemoryEntryId("00000000-0000-4000-8000-000000000704"),
          expectedVersion: 0,
          content: "forged",
        }),
      }),
    );
    expect(forged?.status).toBe(400);
    expect(memory).not.toHaveBeenCalled();
    expect(executeMemory).not.toHaveBeenCalled();
  });
});

function routeFixture(
  overrides: Record<string, unknown>,
  environmentOverrides: Record<string, unknown> = {},
) {
  return routeFixtureWithClock(overrides, undefined, environmentOverrides).route;
}

function routeFixtureWithClock(
  overrides: Record<string, unknown> = {},
  maxRequestBodySize?: number,
  environmentOverrides: Record<string, unknown> = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const now = { value: 1 };
  const service = {
    bootstrap: vi.fn(() => ({ active: [], archived: [], availability: [], memory: [] })),
    search: vi.fn(() => []),
    executeProject: vi.fn(() => ({ kind: "chat-project-created", project: project() })),
    memory: vi.fn(() => ({ projectId, active: [], history: [] })),
    executeMemory: vi.fn(() => ({ kind: "memory-entry-created", entry: memoryEntry() })),
    ...overrides,
  } as never;
  const environmentService = {
    observe: vi.fn(),
    ...environmentOverrides,
  } as never;
  return {
    route: createProjectRouteHandler({
      service,
      environmentService,
      windowAuthorityStore: store,
      now: () => now.value,
      ...(maxRequestBodySize === undefined ? {} : { maxRequestBodySize }),
    }),
    now,
  };
}

function memoryEntry() {
  return {
    id: entryId,
    projectId,
    kind: "fact",
    content: "Explicit",
    provenance: { kind: "user-authored" },
    author: {
      kind: "local-user",
      actorId: "00000000-0000-4000-8000-000000000001",
    },
    status: "active",
    version: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
  };
}

function project() {
  return {
    id: projectId,
    type: "chat",
    name: "Chat",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
  };
}

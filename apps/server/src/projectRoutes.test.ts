import {
  decodeCodeThreadId,
  decodeMemoryEntryId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { bindPrincipalRouteContext } from "./principalRouteContext";
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
    expect(observe).toHaveBeenCalledWith(windowId, projectId, expect.any(AbortSignal), false);
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
      false,
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

  it("refuses a paired device's access-grant change while a local window keeps the route", async () => {
    const executeProject = vi.fn(() => ({ kind: "code-project-access-changed" }));
    const route = routeFixture({ executeProject });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const command = JSON.stringify({
      kind: "change-code-project-access",
      projectId,
      expectedVersion: 0,
      codeAccessPersistence: "project-default",
    });

    const remote = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body: command,
    });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });
    expect((await route(remote))?.status).toBe(403);
    expect(executeProject).not.toHaveBeenCalled();

    const local = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body: command,
    });
    expect((await route(local))?.status).toBe(200);
    expect(executeProject).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ kind: "change-code-project-access" }),
    );
  });

  it("refuses a paired device trusting a provider's own setup in a Project while a local window keeps the route", async () => {
    const executeProject = vi.fn(() => ({ kind: "project-native-providers-changed" }));
    const route = routeFixture({ executeProject });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const command = JSON.stringify({
      kind: "change-project-native-providers",
      projectId,
      expectedVersion: 1,
      providers: ["claude"],
    });
    const remote = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body: command,
    });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });
    expect((await route(remote))?.status).toBe(403);
    expect(executeProject).not.toHaveBeenCalled();

    const local = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body: command,
    });
    expect((await route(local))?.status).toBe(200);
    expect(executeProject).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ kind: "change-project-native-providers" }),
    );
  });

  it("refuses a paired device letting agents merge while a local window keeps the route", async () => {
    const executeProject = vi.fn(() => ({ kind: "code-project-agent-merge-changed" }));
    const route = routeFixture({ executeProject });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const body = JSON.stringify({
      kind: "change-code-project-agent-merge",
      projectId,
      expectedVersion: 1,
      agentMerge: "enabled",
    });
    const remote = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body,
    });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });
    expect((await route(remote))?.status).toBe(403);
    expect(executeProject).not.toHaveBeenCalled();

    const local = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body,
    });
    expect((await route(local))?.status).toBe(200);
    expect(executeProject).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ kind: "change-code-project-agent-merge" }),
    );
  });

  it("refuses a paired device turning on a Project's own toolchain while a local window keeps the route", async () => {
    const executeProject = vi.fn(() => ({ kind: "code-project-own-toolchain-changed" }));
    const route = routeFixture({ executeProject });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const body = JSON.stringify({
      kind: "change-code-project-own-toolchain",
      projectId,
      expectedVersion: 1,
      ownToolchain: "enabled",
    });
    const remote = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body,
    });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });
    expect((await route(remote))?.status).toBe(403);
    expect(executeProject).not.toHaveBeenCalled();

    const local = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body,
    });
    expect((await route(local))?.status).toBe(200);
    expect(executeProject).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ kind: "change-code-project-own-toolchain" }),
    );
  });

  it("refuses a paired device's desktop recipe change while a local window keeps the route", async () => {
    const executeProject = vi.fn(() => ({ kind: "code-project-desktop-recipe-changed" }));
    const route = routeFixture({ executeProject });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const recipe = {
      providerId: "host-local",
      screen: { width: 1280, height: 800 },
      network: "none",
      leaseMinutes: 30,
      maximumLeaseMinutes: 240,
      idleMinutes: 15,
    };
    const command = JSON.stringify({
      kind: "change-code-project-desktop-recipe",
      projectId,
      expectedVersion: 1,
      recipe,
    });

    // A paired device is refused before the service runs, so a key it sends
    // never reaches the credential store, and the refusal does not echo it.
    const key = "e2b_paired-device-key-never-stored";
    for (const body of [
      command,
      JSON.stringify({
        kind: "change-code-project-desktop-recipe",
        projectId,
        expectedVersion: 1,
        recipe: { ...recipe, providerId: "e2b" },
        key: { action: "enter", key },
      }),
    ]) {
      const remote = new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers,
        body,
      });
      bindPrincipalRouteContext(remote, {
        principal: { kind: "remote-device" } as never,
        scopeId: windowId,
      });
      const refused = await route(remote);
      expect(refused?.status).toBe(403);
      expect(await refused?.text()).not.toContain(key);
    }
    expect(executeProject).not.toHaveBeenCalled();

    const local = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body: command,
    });
    expect((await route(local))?.status).toBe(200);
    expect(executeProject).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ kind: "change-code-project-desktop-recipe" }),
    );
  });

  it("refuses a paired device setting a Work Project's Developer tools or actions while a local window keeps both", async () => {
    const executeProject = vi.fn(() => ({ kind: "work-project-developer-tools-changed" }));
    const route = routeFixture({ executeProject });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };
    const commands = [
      { kind: "change-work-project-developer-tools", projectId, expectedVersion: 1, enabled: true },
      { kind: "change-work-project-actions", projectId, expectedVersion: 1, actions: [] },
    ];
    for (const command of commands) {
      const remote = new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      });
      bindPrincipalRouteContext(remote, {
        principal: { kind: "remote-device" } as never,
        scopeId: windowId,
      });
      expect((await route(remote))?.status).toBe(403);
    }
    expect(executeProject).not.toHaveBeenCalled();

    for (const command of commands) {
      const local = new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      });
      expect((await route(local))?.status).toBe(200);
    }
    expect(executeProject).toHaveBeenCalledTimes(2);
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

describe("Project memory proposal routes", () => {
  const headers = { "x-octant-window-capability": capability };
  const proposalId = "00000000-0000-4000-8000-000000000705";

  it("lists and answers only the authenticated window's proposals", async () => {
    const list = vi.fn(() => []);
    const decide = vi.fn(async () => ({ kind: "project-memory-proposal-declined" }));
    const { route } = routeFixtureWithClock({}, undefined, {}, { list, decide });

    const listed = await route(
      new Request("http://127.0.0.1/api/projects/memory/proposals", { headers }),
    );
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual({ kind: "project-memory-proposal-list", proposals: [] });
    expect(list).toHaveBeenCalledWith(windowId);

    const answered = await route(
      new Request("http://127.0.0.1/api/projects/memory/proposals/decide", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ proposalId, decision: "decline" }),
      }),
    );
    expect(answered?.status).toBe(200);
    expect(await answered?.json()).toEqual({ kind: "project-memory-proposal-declined" });
    expect(decide).toHaveBeenCalledWith(windowId, { proposalId, decision: "decline" });
  });

  it("refuses an unauthenticated, forged, or malformed answer before it reaches a proposal", async () => {
    const decide = vi.fn();
    const { route } = routeFixtureWithClock({}, undefined, {}, { list: vi.fn(() => []), decide });
    const post = (body: unknown, requestHeaders: Record<string, string>) =>
      route(
        new Request("http://127.0.0.1/api/projects/memory/proposals/decide", {
          method: "POST",
          headers: { ...requestHeaders, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect((await post({ proposalId, decision: "confirm" }, {}))?.status).toBe(401);
    expect((await post({ proposalId, decision: "confirm", windowId }, headers))?.status).toBe(400);
    expect((await post({ proposalId, decision: "always" }, headers))?.status).toBe(400);
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/projects/memory/proposals/decide", { headers }),
        )
      )?.status,
    ).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("Project icon route", () => {
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const found = {
    status: "found",
    bytes,
    mediaType: "image/svg+xml",
    etag: '"2a-1f"',
  } as const;
  const iconUrl = `http://127.0.0.1/api/projects/${projectId}/icon`;
  const headers = { "x-octant-window-capability": capability };

  function iconRoute(result: unknown) {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const read = vi.fn().mockResolvedValue(result);
    const route = createProjectRouteHandler({
      service: {} as never,
      environmentService: {} as never,
      windowAuthorityStore: store,
      icons: { read },
      now: () => 1,
    });
    return { route, read };
  }

  it("serves the icon bytes with headers that keep an SVG from running", async () => {
    const { route, read } = iconRoute(found);

    const response = await route(new Request(iconUrl, { headers }));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/svg+xml");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response?.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response?.headers.get("etag")).toBe('"2a-1f"');
    expect(new Uint8Array(await (response as Response).arrayBuffer())).toEqual(bytes);
    expect(read).toHaveBeenCalledWith(windowId, projectId);
  });

  it("answers not modified when the person's copy is current", async () => {
    const { route } = iconRoute(found);

    const response = await route(
      new Request(iconUrl, { headers: { ...headers, "if-none-match": '"2a-1f"' } }),
    );

    expect(response?.status).toBe(304);
    expect(await response?.text()).toBe("");
  });

  it("answers a plain 404 when the Project has no icon", async () => {
    const { route } = iconRoute({ status: "none" });

    const response = await route(new Request(iconUrl, { headers }));

    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ category: "not-found" });
  });

  it("refuses a request without a window credential and reads nothing", async () => {
    const { route, read } = iconRoute(found);

    const response = await route(new Request(iconUrl));

    expect(response?.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a query string and a malformed Project id", async () => {
    const { route, read } = iconRoute(found);

    expect((await route(new Request(`${iconUrl}?windowId=forged`, { headers })))?.status).toBe(400);
    expect(
      (await route(new Request("http://127.0.0.1/api/projects/%/icon", { headers })))?.status,
    ).toBe(400);
    expect(read).not.toHaveBeenCalled();
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
  memoryProposals?: Record<string, unknown>,
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
      ...(memoryProposals === undefined ? {} : { memoryProposals: memoryProposals as never }),
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

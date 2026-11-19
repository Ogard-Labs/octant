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
const pairedDeviceId = "00000000-0000-4000-8000-000000000705";
// What a local window's change is journaled as.
const localUser = { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" };

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
    expect(executeProject).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ projectId }),
      localUser,
    );

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

  it("lets a device the host's own person paired change a Project's access grant and set its level to Full access, and refuses a hub-introduced device both", async () => {
    const executeProject = vi.fn(() => ({ kind: "code-project-access-changed" }));
    const route = routeFixture({ executeProject });
    const commands = [
      {
        kind: "change-code-project-access",
        projectId,
        expectedVersion: 0,
        codeAccessPersistence: "project-default",
      },
      {
        kind: "change-code-project-permission-mode",
        projectId,
        expectedVersion: 0,
        permissionMode: "full-access",
        strict: true,
      },
    ];
    const from = (command: unknown, admittedBy: "host-person" | "hub-roster") => {
      const remote = new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(command),
      });
      bindPrincipalRouteContext(remote, {
        principal: { kind: "remote-device", admittedBy, deviceId: pairedDeviceId } as never,
        scopeId: windowId,
      });
      return remote;
    };

    for (const command of commands) {
      expect((await route(from(command, "hub-roster")))?.status).toBe(403);
    }
    expect(executeProject).not.toHaveBeenCalled();
    for (const command of commands) {
      expect((await route(from(command, "host-person")))?.status).toBe(200);
    }
    expect(executeProject).toHaveBeenCalledTimes(commands.length);
    // The device is who the journal names for each change.
    for (const call of executeProject.mock.calls as ReadonlyArray<ReadonlyArray<unknown>>) {
      expect(call[2]).toEqual({
        kind: "remote-device",
        actorId: pairedDeviceId,
        deviceId: pairedDeviceId,
      });
    }
  });

  it("refuses a hub-introduced device's access-grant change while a local window keeps the route", async () => {
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
      localUser,
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
      localUser,
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
      localUser,
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
      localUser,
    );

    const paired = new Request("http://127.0.0.1/api/projects/commands", {
      method: "POST",
      headers,
      body,
    });
    bindPrincipalRouteContext(paired, {
      principal: {
        kind: "remote-device",
        deviceId: "90000000-0000-4000-8000-000000000001",
        admittedBy: "host-person",
      } as never,
      scopeId: windowId,
    });
    expect((await route(paired))?.status).toBe(200);
  });
  it.each([
    {
      kind: "change-code-project-agent-pull-request-comments",
      agentPullRequestComments: "enabled",
    },
    { kind: "change-code-project-agent-default-branch-push", agentDefaultBranchPush: "enabled" },
    { kind: "change-project-agent-memory-writes", agentMemoryWrites: "enabled" },
    {
      kind: "change-project-image-generation-choice",
      imageGenerationChoice: {
        profileInstanceId: "a3000000-0000-4000-8000-000000000001",
        modelId: "gpt-image-2",
      },
    },
  ] as const)(
    "admits a person-paired device and local window on $kind while refusing hub-introduced and restricted devices",
    async (setting) => {
      const executeProject = vi.fn(() => ({ kind: "code-project-agent-merge-changed" }));
      const route = routeFixture({ executeProject });
      const headers = {
        "content-type": "application/json",
        "x-octant-window-capability": capability,
      };
      const body = JSON.stringify({ ...setting, projectId, expectedVersion: 1 });
      for (const admittedBy of [undefined, "hub-roster"] as const) {
        const remote = new Request("http://127.0.0.1/api/projects/commands", {
          method: "POST",
          headers,
          body,
        });
        bindPrincipalRouteContext(remote, {
          principal: {
            kind: "remote-device",
            ...(admittedBy === undefined ? {} : { admittedBy }),
          } as never,
          scopeId: windowId,
        });
        expect((await route(remote))?.status).toBe(403);
      }
      expect(executeProject).not.toHaveBeenCalled();

      const paired = new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers,
        body,
      });
      bindPrincipalRouteContext(paired, {
        principal: {
          kind: "remote-device",
          deviceId: "90000000-0000-4000-8000-000000000001",
          admittedBy: "host-person",
        } as never,
        scopeId: windowId,
      });
      expect((await route(paired))?.status).toBe(200);

      const local = new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers,
        body,
      });
      expect((await route(local))?.status).toBe(200);
      expect(executeProject).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({ kind: setting.kind }),
        localUser,
      );
    },
  );

  it.each([
    { kind: "change-code-project-agent-merge", agentMerge: "enabled" },
    {
      kind: "change-code-project-agent-pull-request-comments",
      agentPullRequestComments: "enabled",
    },
    { kind: "change-code-project-agent-default-branch-push", agentDefaultBranchPush: "enabled" },
    { kind: "change-project-agent-memory-writes", agentMemoryWrites: "enabled" },
  ] as const)(
    "lets a device the host's own person paired turn on $kind, journaled with the device as actor",
    async (setting) => {
      const executeProject = vi.fn(() => ({ kind: "project-agent-memory-writes-changed" }));
      const route = routeFixture({ executeProject });
      const deviceId = "55000000-0000-4000-8000-000000000001";
      const remote = new Request("http://127.0.0.1/api/projects/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...setting, projectId, expectedVersion: 1 }),
      });
      bindPrincipalRouteContext(remote, {
        principal: {
          kind: "remote-device",
          hostId: "11111111-1111-4111-8111-111111111111",
          deviceId,
          credentialGeneration: 1,
          origin: "https://remote.example",
          protocolVersion: 1,
          capabilityDigest: "a".repeat(64),
          sessionId: "55000000-0000-4000-8000-0000000000aa",
          admittedBy: "host-person",
        } as never,
        scopeId: deviceId as never,
      });
      expect((await route(remote))?.status).toBe(200);
      expect(executeProject).toHaveBeenCalledWith(
        deviceId,
        expect.objectContaining({ kind: setting.kind }),
        { kind: "remote-device", actorId: deviceId, deviceId },
      );
    },
  );

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
      localUser,
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
    expect(executeMemory).toHaveBeenCalledWith(command, localUser);

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
    expect(decide).toHaveBeenCalledWith(
      windowId,
      { proposalId, decision: "decline" },
      expect.objectContaining({ kind: "local-user" }),
    );
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

describe("Project icon change route", () => {
  const iconUrl = `http://127.0.0.1/api/projects/${projectId}/icon`;
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function changeRoute(options: { reachable?: boolean; refuse?: boolean } = {}) {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const write = vi.fn(async () =>
      options.refuse === true
        ? ({ status: "refused", reason: "not-an-image", message: "Not an image." } as const)
        : ({ status: "stored" } as const),
    );
    const remove = vi.fn(async () => undefined);
    const route = createProjectRouteHandler({
      service: {
        bootstrap: async () => ({
          active: options.reachable === false ? [] : [{ id: projectId }],
        }),
      } as never,
      environmentService: {} as never,
      windowAuthorityStore: store,
      customIcons: { write, remove },
      now: () => 1,
    });
    return { route, write, remove };
  }

  const authed = { "x-octant-window-capability": capability };

  it("copies the image a window on this host sends for a Project it can reach", async () => {
    const { route, write } = changeRoute();

    const response = await route(
      new Request(iconUrl, {
        method: "PUT",
        headers: { ...authed, "content-type": "image/png" },
        body: png,
      }),
    );

    expect(response?.status).toBe(204);
    expect(write).toHaveBeenCalledWith(projectId, png, "image/png");
  });

  it("answers the refusal's message when the file is not an acceptable icon", async () => {
    const { route } = changeRoute({ refuse: true });

    const response = await route(
      new Request(iconUrl, {
        method: "PUT",
        headers: { ...authed, "content-type": "image/png" },
        body: png,
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ message: "Not an image." });
  });

  it("refuses an image that declares more than 256 KB before reading it", async () => {
    const { route, write } = changeRoute();

    const response = await route(
      new Request(iconUrl, {
        method: "PUT",
        headers: { ...authed, "content-type": "image/png", "content-length": "300000" },
        body: png,
      }),
    );

    expect(response?.status).toBe(413);
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a window that cannot reach the Project and a request without a credential", async () => {
    const stranger = changeRoute({ reachable: false });
    const anonymous = changeRoute();

    const unreachable = await stranger.route(
      new Request(iconUrl, {
        method: "PUT",
        headers: { ...authed, "content-type": "image/png" },
        body: png,
      }),
    );
    const unauthenticated = await anonymous.route(
      new Request(iconUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: png }),
    );

    expect(unreachable?.status).toBe(404);
    expect(unauthenticated?.status).toBe(401);
    expect(stranger.write).not.toHaveBeenCalled();
    expect(anonymous.write).not.toHaveBeenCalled();
  });

  it("drops the chosen icon with a DELETE", async () => {
    const { route, remove } = changeRoute();

    const response = await route(new Request(iconUrl, { method: "DELETE", headers: authed }));

    expect(response?.status).toBe(204);
    expect(remove).toHaveBeenCalledWith(projectId);
  });

  it("serves which icon it is so the page can offer the folder's own", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const route = createProjectRouteHandler({
      service: {} as never,
      environmentService: {} as never,
      windowAuthorityStore: store,
      icons: {
        read: async () => ({
          status: "found",
          bytes: png,
          mediaType: "image/png",
          etag: '"1-1"',
          source: "custom",
          foundAvailable: false,
        }),
      },
      now: () => 1,
    });

    const response = await route(new Request(iconUrl, { headers: authed }));

    expect(response?.headers.get("x-octant-project-icon-source")).toBe("custom");
    expect(response?.headers.get("x-octant-project-icon-found")).toBe("0");
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

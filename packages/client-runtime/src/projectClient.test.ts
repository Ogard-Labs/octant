import {
  decodeMemoryCommand,
  decodeMemoryEntryId,
  decodeCodeThreadId,
  decodeProjectCommand,
  decodeProjectId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createProjectClient, ProjectClientFailure } from "./projectClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000801");
const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000803");
const entryId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000802");
const bootstrap = { active: [], archived: [], availability: [], memory: [] };
const command = decodeProjectCommand({
  kind: "create-chat-project",
  projectId,
  expectedVersion: 0,
  name: "Chat",
  hostId: "local",
});
const memoryCommand = decodeMemoryCommand({
  kind: "create-memory-entry",
  projectId,
  entryId,
  memoryKind: "fact",
  content: "Explicit",
  expectedVersion: 0,
});

describe("ProjectClient", () => {
  it("sends only the scoped capability and strictly decodes bootstrap/search/commands", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("bootstrap")) return Response.json(bootstrap);
      if (path.endsWith("search")) return Response.json([]);
      return Response.json({ kind: "chat-project-created", project: project() });
    });
    const client = createProjectClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.bootstrap()).resolves.toEqual(bootstrap);
    await expect(client.search(" Chat ")).resolves.toEqual([]);
    await expect(client.executeProject(command)).resolves.toMatchObject({
      kind: "chat-project-created",
    });
    for (const call of fetch.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({ "x-octant-window-capability": capability });
      expect(JSON.stringify(init)).not.toContain("windowId");
      expect(JSON.stringify(init)).not.toContain("desktop-secret");
    }
  });

  it("strictly decodes typed failures and redacts transport details", async () => {
    const conflictFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { category: "conflict", message: "Reload.", currentVersion: 4 },
        { status: 409 },
      ),
    );
    const conflict = createProjectClient({
      baseUrl: "http://localhost",
      fetch: conflictFetch,
      windowCapability: capability,
    });
    await expect(conflict.executeProject(command)).rejects.toMatchObject({
      category: "conflict",
      currentVersion: 4,
    });

    const transport = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => {
        throw new Error("ECONNREFUSED secret");
      },
    });
    const failure = await rejected(transport.bootstrap());
    expect(failure).toMatchObject({
      category: "unavailable",
      message: "Octant Project service is unavailable.",
    });
    expect(failure.message).not.toContain("secret");
  });

  it("rejects malformed success and failure payloads", async () => {
    const success = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...bootstrap, extra: true }),
    });
    await expect(success.bootstrap()).rejects.toMatchObject({ category: "unavailable" });
    const failure = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () =>
        Response.json({ category: "invalid", message: "No", extra: true }, { status: 400 }),
    });
    await expect(failure.bootstrap()).rejects.toMatchObject({ category: "unavailable" });
  });

  it("reads and mutates memory through encoded scoped routes with strict decoding", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "GET") {
        expect(url.pathname).toBe(`/api/projects/${encodeURIComponent(projectId)}/memory`);
        return Response.json({ projectId, active: [], history: [] });
      }
      expect(url.pathname).toBe("/api/projects/memory/commands");
      expect(JSON.parse(String(init?.body))).toEqual(memoryCommand);
      return Response.json({ kind: "memory-entry-created", entry: memoryEntry() });
    });
    const client = createProjectClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.memory(projectId)).resolves.toEqual({ projectId, active: [], history: [] });
    await expect(client.executeMemory(memoryCommand)).resolves.toMatchObject({
      kind: "memory-entry-created",
      entry: { id: entryId, content: "Explicit" },
    });
    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        "x-octant-window-capability": capability,
      });
      expect(JSON.stringify(call[1])).not.toContain("windowId");
    }
  });

  it("strictly decodes memory successes and typed failures", async () => {
    const malformed = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ projectId, active: [], history: [], extra: true }),
    });
    await expect(malformed.memory(projectId)).rejects.toMatchObject({ category: "unavailable" });

    const conflict = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () =>
        Response.json(
          { category: "conflict", message: "Reload.", currentVersion: 2 },
          { status: 409 },
        ),
    });
    await expect(conflict.executeMemory(memoryCommand)).rejects.toMatchObject({
      category: "conflict",
      currentVersion: 2,
    });

    const malformedResult = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ kind: "memory-entry-created", entry: { bad: true } }),
    });
    await expect(malformedResult.executeMemory(memoryCommand)).rejects.toMatchObject({
      category: "unavailable",
    });
  });

  it("loads a strictly decoded code environment from the encoded scoped route", async () => {
    const observation = {
      status: "ready",
      projectId,
      projectName: "Octant",
      repositoryRoot: "/Users/example/Dev/Repos/octant",
      worktreeRoot: "/Users/example/Dev/Repos/octant",
      branch: { kind: "named", name: "feature/issue-52" },
      changes: "clean",
      observedAt: "2026-07-16T09:00:00.000Z",
    } as const;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(observation));
    const client = createProjectClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });

    await expect(client.environment(projectId)).resolves.toMatchObject({
      status: "ready",
      projectId,
      branch: { kind: "named", name: "feature/issue-52" },
    });
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:13773/api/projects/${encodeURIComponent(projectId)}/environment`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );

    const malformed = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...observation, extra: true }),
    });
    await expect(malformed.environment(projectId)).rejects.toMatchObject({
      category: "unavailable",
      message: "Project service returned an invalid response.",
    });

    const transport = createProjectClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => {
        throw new Error("ECONNREFUSED private-host");
      },
    });
    const failure = await rejected(transport.environment(projectId));
    expect(failure).toMatchObject({
      category: "unavailable",
      message: "Octant Project service is unavailable.",
    });
    expect(failure.message).not.toContain("private-host");
  });

  it("requests a thread-scoped environment observation", async () => {
    const observation = {
      status: "ready",
      projectId,
      projectName: "Octant",
      threadId,
      checkoutId: "00000000-0000-4000-8000-000000000804",
      repositoryRoot: "/repo",
      worktreeRoot: "/repo/.octant-worktrees/thread",
      branch: { kind: "named", name: "feature/thread" },
      changes: "dirty",
      observedAt: "2026-07-16T09:00:00.000Z",
    } as const;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(observation));
    const client = createProjectClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });

    await expect(client.environmentForThread(projectId, threadId)).resolves.toMatchObject({
      threadId,
      checkoutId: observation.checkoutId,
      worktreeRoot: observation.worktreeRoot,
    });
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:13773/api/projects/${encodeURIComponent(projectId)}/environment?threadId=${encodeURIComponent(threadId)}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("forwards environment cancellation to the authenticated fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ category: "unavailable", message: "Stopped." }, { status: 503 }),
    );
    const client = createProjectClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });

    await expect(
      (
        client.environment as unknown as (
          id: typeof projectId,
          signal: AbortSignal,
        ) => Promise<unknown>
      )(projectId, controller.signal),
    ).rejects.toBeInstanceOf(ProjectClientFailure);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/projects/${projectId}/environment`),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

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

async function rejected(value: Promise<unknown>): Promise<ProjectClientFailure> {
  try {
    await value;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectClientFailure);
    return error as ProjectClientFailure;
  }
  throw new Error("expected rejection");
}

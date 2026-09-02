import {
  decodeMemoryEntryId,
  decodeProjectId,
  type MemoryCommandResult,
  type ProjectBootstrap,
  type ProjectCommand,
  type ProjectCommandResult,
  type ProjectId,
  type ProjectSummary,
} from "@octant/contracts";
import type { ProjectClient, ProjectClientFailure } from "@octant/client-runtime/project-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProjectController } from "./useProjectController";

const chatId = decodeProjectId("00000000-0000-4000-8000-000000000801");
const codeId = decodeProjectId("00000000-0000-4000-8000-000000000802");
const memoryId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000821");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

function project(
  id: ProjectId,
  type: "chat" | "work" | "code",
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  const common = {
    id,
    type,
    name: type === "chat" ? "Research" : "Octant",
    lifecycle: "active" as const,
    pinned: type === "code",
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: "2026-07-14T08:00:00.000Z" as ProjectSummary["createdAt"],
    updatedAt: "2026-07-14T08:00:00.000Z" as ProjectSummary["updatedAt"],
    ...overrides,
  };
  if (type === "chat") return common as ProjectSummary;
  return {
    ...common,
    binding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
    ...(type === "code" ? { codeAccessPersistence: "current-session" as const } : {}),
  } as ProjectSummary;
}

function bootstrap(): ProjectBootstrap {
  return {
    active: [project(chatId, "chat"), project(codeId, "code")],
    archived: [],
    availability: [
      {
        projectId: codeId,
        status: "unavailable",
        reason: "The repository root could not be found.",
        observedAt:
          "2026-07-14T09:00:00.000Z" as ProjectBootstrap["availability"][number]["observedAt"],
      },
    ],
    memory: [],
  };
}

function client(initial = bootstrap()) {
  let state = initial;
  const api: ProjectClient = {
    bootstrap: vi.fn(async () => state),
    search: vi.fn(async (query: string) =>
      state.active.filter((candidate) =>
        candidate.name.toLowerCase().includes(query.toLowerCase()),
      ),
    ),
    executeProject: vi.fn(async (command: ProjectCommand): Promise<ProjectCommandResult> => {
      if (command.kind === "rename-project") {
        const current = state.active.find((candidate) => candidate.id === command.projectId)!;
        const renamed = { ...current, name: command.name, version: 2 as typeof current.version };
        state = {
          ...state,
          active: state.active.map((candidate) =>
            candidate.id === renamed.id ? renamed : candidate,
          ),
        };
        return { kind: "project-renamed", project: renamed as never };
      }
      throw new Error(`Unhandled ${command.kind}`);
    }),
    memory: vi.fn(),
    environment: vi.fn(async () => {
      throw new Error("Unexpected environment request.");
    }),
    environmentForThread: vi.fn(async () => {
      throw new Error("Unexpected thread environment request.");
    }),
    executeMemory: vi.fn(),
  };
  return { api, read: () => state };
}

describe("useProjectController", () => {
  it("exposes the authoritative Project client to composed Project views", async () => {
    const server = client();
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", activeProjectId: chatId, client: server.api }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.client).toBe(server.api);
  });

  it("loads memory on demand and sends authoritative versioned mutations without source content", async () => {
    const server = client();
    vi.mocked(server.api.memory).mockResolvedValue({
      projectId: chatId,
      active: [
        {
          id: memoryId,
          projectId: chatId,
          kind: "decision",
          content: "Keep memory explicit.",
          provenance: { kind: "user-authored" },
          author: { kind: "local-user", actorId: chatId as never },
          status: "active",
          version: 3 as never,
          createdAt: "2026-07-14T08:00:00.000Z" as never,
          updatedAt: "2026-07-14T08:00:00.000Z" as never,
        },
      ],
      history: [],
    });
    vi.mocked(server.api.executeMemory).mockResolvedValue({
      kind: "memory-entry-transferred",
      entry: {} as never,
    });
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", activeProjectId: chatId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.loadMemory(chatId));
    expect(result.current.memory?.active[0]?.content).toBe("Keep memory explicit.");

    await act(async () => result.current.transferMemory(memoryId, codeId));
    expect(server.api.memory).toHaveBeenCalledWith(codeId);
    const command = vi.mocked(server.api.executeMemory).mock.calls[0]?.[0];
    expect(command).toMatchObject({
      kind: "transfer-memory-entry",
      sourceProjectId: chatId,
      sourceEntryId: memoryId,
      destinationProjectId: codeId,
      expectedVersion: 3,
    });
    expect(command).not.toHaveProperty("content");
  });

  it("reloads memory on conflict, suppresses double submit, and discards stale project loads", async () => {
    const server = client();
    const older = deferred<Awaited<ReturnType<ProjectClient["memory"]>>>();
    vi.mocked(server.api.memory)
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ projectId: codeId, active: [], history: [] });
    const mutation = deferred<MemoryCommandResult>();
    vi.mocked(server.api.executeMemory).mockImplementationOnce(() => mutation.promise);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", activeProjectId: chatId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let oldLoad!: Promise<void>;
    act(() => {
      oldLoad = result.current.loadMemory(chatId);
    });
    await act(async () => result.current.loadMemory(codeId));
    await act(async () => older.resolve({ projectId: chatId, active: [], history: [] }));
    await oldLoad;
    expect(result.current.memory?.projectId).toBe(codeId);

    vi.mocked(server.api.memory).mockResolvedValue({ projectId: chatId, active: [], history: [] });
    await act(async () => result.current.loadMemory(chatId));
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.createMemory("fact", "Local-first.");
    });
    expect(await result.current.createMemory("fact", "Duplicate.")).toBe(false);
    await act(async () =>
      mutation.reject({ category: "conflict", message: "Changed.", currentVersion: 1 }),
    );
    await first;
    expect(result.current.announcement).toMatch(/reloaded authoritative memory/i);
    expect(server.api.executeMemory).toHaveBeenCalledTimes(1);
  });

  it("suppresses a second transfer while destination memory is still loading", async () => {
    const server = client();
    const source = { projectId: chatId, active: [], history: [] };
    const destination = deferred<Awaited<ReturnType<ProjectClient["memory"]>>>();
    vi.mocked(server.api.memory)
      .mockResolvedValueOnce(source)
      .mockImplementationOnce(() => destination.promise)
      .mockResolvedValue(source);
    vi.mocked(server.api.executeMemory).mockResolvedValue({
      kind: "memory-entry-transferred",
      entry: {} as never,
    });
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", activeProjectId: chatId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.loadMemory(chatId));

    let first!: Promise<boolean>;
    act(() => {
      first = result.current.transferMemory(memoryId, codeId);
    });
    expect(await result.current.transferMemory(memoryId, codeId)).toBe(false);
    expect(server.api.memory).toHaveBeenCalledTimes(2);
    await act(async () => destination.resolve({ projectId: codeId, active: [], history: [] }));
    await first;
    expect(server.api.executeMemory).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicitly opened memory transfer bound to its source Project across pane focus changes", async () => {
    const server = client();
    const destination = deferred<Awaited<ReturnType<ProjectClient["memory"]>>>();
    vi.mocked(server.api.memory)
      .mockResolvedValueOnce({ projectId: chatId, active: [], history: [] })
      .mockImplementationOnce(() => destination.promise)
      .mockResolvedValue({ projectId: chatId, active: [], history: [] });
    vi.mocked(server.api.executeMemory).mockResolvedValue({
      kind: "memory-entry-transferred",
      entry: {} as never,
    });
    const { result, rerender } = renderHook(
      ({ activeProjectId }: { activeProjectId: ProjectId }) =>
        useProjectController({ activeMode: "chat", activeProjectId, client: server.api }),
      { initialProps: { activeProjectId: chatId } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.loadMemory(chatId));

    let transfer!: Promise<boolean>;
    act(() => {
      transfer = result.current.transferMemory(memoryId, codeId);
    });
    rerender({ activeProjectId: codeId });
    await act(async () => destination.resolve({ projectId: codeId, active: [], history: [] }));

    expect(await transfer).toBe(true);
    expect(server.api.executeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "transfer-memory-entry",
        sourceProjectId: chatId,
        destinationProjectId: codeId,
      }),
    );
    expect(result.current.memory?.projectId).toBe(chatId);
    expect(result.current.memoryStatus).toBe("ready");
    expect(result.current.announcement).toBe("Project memory transferred with provenance.");
  });

  it("keeps an already dispatched command honest but suppresses memory updates after disclosure closes", async () => {
    const server = client();
    const mutation = deferred<MemoryCommandResult>();
    vi.mocked(server.api.memory).mockResolvedValue({ projectId: chatId, active: [], history: [] });
    vi.mocked(server.api.executeMemory).mockImplementationOnce(() => mutation.promise);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", activeProjectId: chatId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.loadMemory(chatId));

    let command!: Promise<boolean>;
    act(() => {
      command = result.current.createMemory("fact", "Explicit fact.");
    });
    act(() => result.current.clearMemory());
    await act(async () => mutation.resolve({ kind: "memory-entry-created", entry: {} as never }));
    expect(await command).toBe(true);
    expect(server.api.executeMemory).toHaveBeenCalledOnce();
    expect(result.current.memoryStatus).toBe("idle");
    expect(result.current.memory).toBeUndefined();
  });
  it("loads authoritative Projects, filters the active mode, and resolves the active Project", async () => {
    const server = client();
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "code", activeProjectId: codeId, client: server.api }),
    );

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.projects.map((candidate) => candidate.id)).toEqual([codeId]);
    expect(result.current.activeProject?.id).toBe(codeId);
    expect(result.current.availabilityByProject.get(codeId)?.status).toBe("unavailable");
  });

  it("keeps the current Project list visible while a Machine revision reloads it", async () => {
    const initial = bootstrap();
    const server = client(initial);
    const revision = deferred<ProjectBootstrap>();
    vi.mocked(server.api.bootstrap)
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => revision.promise);
    const { result, rerender } = renderHook(
      ({ changeRevision }) =>
        useProjectController({
          activeMode: "code",
          activeProjectId: codeId,
          changeRevision,
          client: server.api,
        }),
      { initialProps: { changeRevision: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ changeRevision: 1 });
    await waitFor(() => expect(server.api.bootstrap).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("ready");
    expect(result.current.activeProject?.id).toBe(codeId);

    revision.resolve(initial);
    await act(async () => revision.promise);
    expect(result.current.status).toBe("ready");
  });

  it("uses server-backed search and clears stale results", async () => {
    const server = client();
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.search("Research"));
    expect(server.api.search).toHaveBeenCalledWith("Research");
    expect(result.current.searchStatus).toBe("success");
    expect(result.current.searchResults.map((candidate) => candidate.id)).toEqual([chatId]);
    await act(async () => result.current.search("  "));
    expect(result.current.searchStatus).toBe("idle");
    expect(result.current.searchResults).toEqual([]);
  });

  it("distinguishes a pending search from a completed empty search", async () => {
    const server = client();
    const pending = deferred<ReadonlyArray<ProjectSummary>>();
    vi.mocked(server.api.search).mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let search!: Promise<void>;
    act(() => {
      search = result.current.search("missing");
    });
    expect(result.current.searchStatus).toBe("searching");
    expect(result.current.searchResults).toEqual([]);

    await act(async () => pending.resolve([]));
    await search;
    expect(result.current.searchStatus).toBe("success");
    expect(result.current.searchResults).toEqual([]);
  });

  it("clears old results for a new query and ignores an older late success", async () => {
    const server = client();
    const older = deferred<ReadonlyArray<ProjectSummary>>();
    const newer = deferred<ReadonlyArray<ProjectSummary>>();
    vi.mocked(server.api.search)
      .mockResolvedValueOnce([project(chatId, "chat")])
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.search("Initial"));
    expect(result.current.searchResults.map((candidate) => candidate.id)).toEqual([chatId]);
    let olderSearch!: Promise<void>;
    act(() => {
      olderSearch = result.current.search("Research");
    });
    let newerSearch!: Promise<void>;
    act(() => {
      newerSearch = result.current.search("Octant");
    });
    expect(result.current.searchResults).toEqual([]);

    await act(async () => newer.resolve([project(codeId, "code")]));
    await newerSearch;
    expect(result.current.searchResults.map((candidate) => candidate.id)).toEqual([codeId]);
    await act(async () => older.resolve([project(chatId, "chat")]));
    await olderSearch;
    expect(result.current.searchResults.map((candidate) => candidate.id)).toEqual([codeId]);
  });

  it("ignores a stale search rejection and blank search clears error and announcement", async () => {
    const server = client();
    const older = deferred<ReadonlyArray<ProjectSummary>>();
    const newer = deferred<ReadonlyArray<ProjectSummary>>();
    vi.mocked(server.api.search)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
      .mockRejectedValueOnce({ message: "Current search failed." });
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderSearch!: Promise<void>;
    act(() => {
      olderSearch = result.current.search("Research");
    });
    let newerSearch!: Promise<void>;
    act(() => {
      newerSearch = result.current.search("Octant");
    });
    await act(async () => newer.resolve([project(codeId, "code")]));
    await newerSearch;
    await act(async () => older.reject({ message: "Stale search failed." }));
    await olderSearch;
    expect(result.current.searchStatus).toBe("success");
    expect(result.current.searchErrorMessage).toBeUndefined();
    expect(result.current.errorMessage).toBeUndefined();
    expect(result.current.announcement).not.toContain("Stale search failed");

    await act(async () => result.current.search("current"));
    expect(result.current.searchStatus).toBe("error");
    expect(result.current.searchErrorMessage).toBe(
      "Project search is unavailable. Try again or enter a new query.",
    );
    expect(result.current.errorMessage).toBeUndefined();
    expect(result.current.announcement).toBe("");
    await act(async () => result.current.search("  "));
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.searchStatus).toBe("idle");
    expect(result.current.searchErrorMessage).toBeUndefined();
    expect(result.current.announcement).not.toContain("Current search failed.");
  });

  it("reloads authoritative state after a version conflict and announces recovery", async () => {
    const server = client();
    vi.mocked(server.api.executeProject).mockRejectedValueOnce({
      category: "conflict",
      message: "Project changed.",
      currentVersion: 2 as ProjectSummary["version"],
    } satisfies Partial<ProjectClientFailure>);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", activeProjectId: chatId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.rename(chatId, "New name"));

    expect(server.api.bootstrap).toHaveBeenCalledTimes(2);
    expect(result.current.activeProject?.name).toBe("Research");
    expect(result.current.announcement).toMatch(/reloaded authoritative/i);
  });

  it("renames with the authoritative expected version and reloads the committed Project", async () => {
    const server = client();
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "chat", activeProjectId: chatId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.rename(chatId, "Field notes"));

    expect(server.api.executeProject).toHaveBeenCalledWith({
      kind: "rename-project",
      projectId: chatId,
      expectedVersion: 1,
      name: "Field notes",
    });
    expect(result.current.activeProject?.name).toBe("Field notes");
    expect(result.current.announcement).toMatch(/renamed/i);
  });

  /**
   * A habit only counts once it survives the journal. The controller
   * must send the versioned Project command and refuse to send one for a
   * non-Code Project.
   */
  it("records a Code Project's new-thread workspace habit as a versioned command", async () => {
    const server = client();
    vi.mocked(server.api.executeProject).mockResolvedValue({} as never);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "code", activeProjectId: codeId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.setCodeNewThreadWorkspace(codeId, "managed-worktree");
    });
    expect(server.api.executeProject).toHaveBeenCalledWith({
      kind: "change-code-project-new-thread-workspace",
      projectId: codeId,
      expectedVersion: 1,
      newThreadWorkspace: "managed-worktree",
    });

    vi.mocked(server.api.executeProject).mockClear();
    let refused: boolean | undefined;
    await act(async () => {
      refused = await result.current.setCodeNewThreadWorkspace(chatId, "managed-worktree");
    });
    expect(refused).toBe(false);
    expect(server.api.executeProject).not.toHaveBeenCalled();
  });

  it("opts a Code Project into background pull-request refresh as a versioned command", async () => {
    const server = client();
    vi.mocked(server.api.executeProject).mockResolvedValue({} as never);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "code", activeProjectId: codeId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.setCodePullRequestBackgroundRefresh(codeId, "enabled");
    });
    expect(server.api.executeProject).toHaveBeenCalledWith({
      kind: "change-code-project-pull-request-background-refresh",
      projectId: codeId,
      expectedVersion: 1,
      pullRequestBackgroundRefresh: "enabled",
    });

    vi.mocked(server.api.executeProject).mockClear();
    let refused: boolean | undefined;
    await act(async () => {
      refused = await result.current.setCodePullRequestBackgroundRefresh(chatId, "enabled");
    });
    expect(refused).toBe(false);
    let alreadyDisabled: boolean | undefined;
    await act(async () => {
      // Absence of the setting reads as disabled: no command for a no-op.
      alreadyDisabled = await result.current.setCodePullRequestBackgroundRefresh(
        codeId,
        "disabled",
      );
    });
    expect(alreadyDisabled).toBe(true);
    expect(server.api.executeProject).not.toHaveBeenCalled();
  });

  it("creates virtual and receipt-bound Projects without accepting renderer paths", async () => {
    const server = client();
    vi.mocked(server.api.executeProject).mockResolvedValue({} as never);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "code", client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const receiptId = `${"R".repeat(42)}A`;

    await act(async () => result.current.create("chat", "Ideas"));
    await act(async () => result.current.create("work", "Writing", receiptId));
    await act(async () => result.current.create("code", "Octant", receiptId));

    expect(server.api.executeProject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "create-chat-project", name: "Ideas", expectedVersion: 0 }),
    );
    expect(server.api.executeProject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "create-work-project", receiptId }),
    );
    expect(server.api.executeProject).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ kind: "create-code-project", receiptId }),
    );
    expect(JSON.stringify(vi.mocked(server.api.executeProject).mock.calls)).not.toContain(
      "canonicalRoot",
    );
  });

  it("uses current aggregate versions for pin, archive, restore, and relink commands", async () => {
    const server = client();
    vi.mocked(server.api.executeProject).mockResolvedValue({} as never);
    const { result } = renderHook(() =>
      useProjectController({ activeMode: "code", activeProjectId: codeId, client: server.api }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const receiptId = `${"R".repeat(42)}A`;

    await act(async () => result.current.move(codeId, false));
    await act(async () => result.current.setArchived(codeId, true));
    await act(async () => result.current.setArchived(codeId, false));
    await act(async () => result.current.relink(codeId, receiptId));

    expect(server.api.executeProject).toHaveBeenNthCalledWith(1, {
      kind: "move-project",
      projectId: codeId,
      expectedVersion: 1,
      pinned: false,
    });
    expect(server.api.executeProject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "change-project-lifecycle", lifecycle: "archived" }),
    );
    expect(server.api.executeProject).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ kind: "change-project-lifecycle", lifecycle: "active" }),
    );
    expect(server.api.executeProject).toHaveBeenNthCalledWith(4, {
      kind: "relink-project",
      projectId: codeId,
      expectedVersion: 1,
      receiptId,
    });
  });
});

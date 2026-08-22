import type { ProjectClient } from "@octant/client-runtime/project-client";
import {
  decodeMemoryEntryId,
  decodeProjectId,
  type MemoryCommandResult,
  type ProjectId,
  type ProjectMemoryView,
} from "@octant/contracts/projects";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProjectMemory } from "./useProjectMemory";

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

function emptyView(projectId: ProjectId): ProjectMemoryView {
  return { projectId, active: [], history: [] };
}

function client() {
  const api: ProjectClient = {
    bootstrap: vi.fn(),
    search: vi.fn(),
    executeProject: vi.fn(),
    memory: vi.fn(),
    environment: vi.fn(),
    environmentForThread: vi.fn(),
    executeMemory: vi.fn(),
  };
  return api;
}

describe("useProjectMemory", () => {
  it("drops the previous Project's entries before another Overview's load settles", async () => {
    const api = client();
    const older = deferred<ProjectMemoryView>();
    vi.mocked(api.memory)
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(emptyView(codeId));
    const { result } = renderHook(() => useProjectMemory(api));

    let first!: Promise<void>;
    act(() => {
      first = result.current.load(chatId);
    });
    expect(result.current.status).toBe("loading");
    await act(async () => result.current.load(codeId));
    await act(async () => older.resolve({ projectId: chatId, active: [], history: [] }));
    await first;

    expect(result.current.memory?.projectId).toBe(codeId);
    expect(result.current.memory?.active).toEqual([]);
    expect(result.current.status).toBe("ready");
  });

  it("sends versioned mutations for the loaded Project without source content", async () => {
    const api = client();
    vi.mocked(api.memory).mockResolvedValue({
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
    vi.mocked(api.executeMemory).mockResolvedValue({
      kind: "memory-entry-transferred",
      entry: {} as never,
    } as MemoryCommandResult);
    const { result } = renderHook(() => useProjectMemory(api));

    await act(async () => result.current.load(chatId));
    await act(async () => result.current.transfer(memoryId, codeId));

    expect(api.memory).toHaveBeenCalledWith(codeId);
    expect(api.executeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "transfer-memory-entry",
        sourceProjectId: chatId,
        sourceEntryId: memoryId,
        destinationProjectId: codeId,
      }),
    );
    expect(vi.mocked(api.executeMemory).mock.calls[0]?.[0]).not.toHaveProperty("content");
  });

  it("does not keep a closed Overview's in-flight mutation on screen", async () => {
    const api = client();
    const mutation = deferred<MemoryCommandResult>();
    vi.mocked(api.memory).mockResolvedValue(emptyView(chatId));
    vi.mocked(api.executeMemory).mockImplementationOnce(() => mutation.promise);
    const { result } = renderHook(() => useProjectMemory(api));
    await act(async () => result.current.load(chatId));

    let command!: Promise<boolean>;
    act(() => {
      command = result.current.create("fact", "Explicit fact.");
    });
    act(() => result.current.clear());
    await act(async () =>
      mutation.resolve({ kind: "memory-entry-created", entry: {} as never } as MemoryCommandResult),
    );
    expect(await command).toBe(true);
    expect(result.current.status).toBe("idle");
    expect(result.current.memory).toBeUndefined();
  });
});

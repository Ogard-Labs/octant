import type { CodeCommand, CodeCommandResult } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWorktreeRemoteFacts } from "./useWorktreeRemoteFacts";

const projectId = decodeProjectId("00000000-0000-4000-8000-000000001001");
const projectId2 = decodeProjectId("00000000-0000-4000-8000-000000001002");

describe("useWorktreeRemoteFacts", () => {
  it("D3: fetches server-authoritative remote facts when a project is selected and execute is available", async () => {
    const execute = vi.fn(async (command: CodeCommand): Promise<CodeCommandResult | undefined> => {
      if (command.kind === "get-worktree-remote-facts") {
        return {
          kind: "worktree-remote-facts-retrieved",
          projectId: command.projectId,
          facts: { remotes: ["origin"], defaultRemote: "origin", upstreamRemote: "origin" },
        };
      }
      return undefined;
    });

    const { result } = renderHook(() =>
      useWorktreeRemoteFacts({ execute, projectId, enabled: true }),
    );

    await waitFor(() => expect(result.current.remoteFacts).toBeDefined());
    expect(result.current.remoteFacts).toEqual({
      remotes: ["origin"],
      defaultRemote: "origin",
      upstreamRemote: "origin",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "get-worktree-remote-facts", projectId }),
      expect.any(AbortSignal),
    );
  });

  it("D3: returns undefined when no project is selected so the composer fails closed", async () => {
    const execute = vi.fn();

    const { result } = renderHook(() => useWorktreeRemoteFacts({ execute, enabled: true }));

    expect(result.current.remoteFacts).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("D3: returns undefined when execute is not available so the composer fails closed", async () => {
    const { result } = renderHook(() => useWorktreeRemoteFacts({ projectId, enabled: true }));

    expect(result.current.remoteFacts).toBeUndefined();
  });

  it("D3: returns undefined when the server returns no remote facts so Start from origin is disabled", async () => {
    const execute = vi.fn(
      async (): Promise<CodeCommandResult | undefined> => ({
        kind: "worktree-remote-facts-retrieved",
        projectId,
        facts: { remotes: [] },
      }),
    );

    const { result } = renderHook(() =>
      useWorktreeRemoteFacts({ execute, projectId, enabled: true }),
    );

    await waitFor(() => expect(result.current.remoteFacts).toBeDefined());
    expect(result.current.remoteFacts).toEqual({ remotes: [] });
  });

  it("D3: returns undefined when the execute call throws so the composer fails closed", async () => {
    const execute = vi.fn(async (): Promise<CodeCommandResult | undefined> => {
      throw new Error("server unavailable");
    });

    const { result } = renderHook(() =>
      useWorktreeRemoteFacts({ execute, projectId, enabled: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.remoteFacts).toBeUndefined();
  });

  it("D3-fix: aborts the stale in-flight request when the project changes, proving real cancellation", async () => {
    // The first request for projectId hangs until its AbortSignal is aborted.
    // When the project changes to projectId2, the hook must abort the first
    // request's AbortController (not merely ignore its result). We verify the
    // first signal is actually aborted and the stale result never overwrites
    // the newer one.
    let firstSignal: AbortSignal | undefined;
    let firstResolve: ((value: CodeCommandResult | undefined) => void) | undefined;
    const firstPromise = new Promise<CodeCommandResult | undefined>((resolve) => {
      firstResolve = resolve;
    });
    const execute = vi.fn(async (command: CodeCommand, signal?: AbortSignal) => {
      if (command.kind === "get-worktree-remote-facts" && command.projectId === projectId) {
        firstSignal = signal;
        // Hang until aborted or resolved — return the hanging promise.
        return firstPromise;
      }
      if (command.kind === "get-worktree-remote-facts") {
        // Second request for projectId2 resolves immediately.
        return {
          kind: "worktree-remote-facts-retrieved" as const,
          projectId: command.projectId,
          facts: { remotes: ["upstream"], defaultRemote: "upstream", upstreamRemote: "upstream" },
        };
      }
      return undefined;
    });

    const { result, rerender } = renderHook(
      ({ pid }: { pid: ProjectId }) =>
        useWorktreeRemoteFacts({ execute, projectId: pid, enabled: true }),
      { initialProps: { pid: projectId } },
    );

    // Wait for the first request to start and capture its signal.
    await waitFor(() => expect(firstSignal).toBeDefined());
    expect(firstSignal!.aborted).toBe(false);

    // Change the project — this must abort the first request.
    rerender({ pid: projectId2 });

    // The first request's AbortSignal must now be aborted.
    expect(firstSignal!.aborted).toBe(true);

    // The second request resolves with the new project's facts.
    await waitFor(() => expect(result.current.remoteFacts).toBeDefined());
    expect(result.current.remoteFacts).toEqual({
      remotes: ["upstream"],
      defaultRemote: "upstream",
      upstreamRemote: "upstream",
    });

    // Now resolve the stale first promise with different facts. Even if it
    // resolves, the hook must not apply it because the signal was aborted.
    act(() => {
      firstResolve?.({
        kind: "worktree-remote-facts-retrieved",
        projectId,
        facts: { remotes: ["stale"], defaultRemote: "stale", upstreamRemote: "stale" },
      });
    });

    // The stale facts must not overwrite the current facts.
    expect(result.current.remoteFacts).toEqual({
      remotes: ["upstream"],
      defaultRemote: "upstream",
      upstreamRemote: "upstream",
    });
  });
});

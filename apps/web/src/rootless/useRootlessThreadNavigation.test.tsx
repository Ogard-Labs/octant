import type { RootlessThreadClient } from "@octant/client-runtime/rootless-thread-client";
import type { RootlessThreadSummary } from "@octant/contracts/rootless-thread";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  rootlessThreadNavigationId,
  useRootlessThreadNavigation,
} from "./useRootlessThreadNavigation";

const rootless: RootlessThreadSummary = {
  threadId: "10000000-0000-4000-8000-000000000011" as never,
  title: "Unfiled work",
  mode: "code",
  hostId: "local" as never,
  providerInstanceId: "20000000-0000-4000-8000-000000000011" as never,
  modelId: "model-one" as never,
  workspaceKind: "rootless",
  createdAt: "2026-08-06T00:00:00.000Z" as never,
  updatedAt: "2026-08-06T00:00:00.000Z" as never,
};

const projectBacked: RootlessThreadSummary = {
  ...rootless,
  threadId: "10000000-0000-4000-8000-000000000012" as never,
  title: "Project work",
  workspaceKind: "project-backed",
  projectId: "30000000-0000-4000-8000-000000000011" as never,
};

describe("useRootlessThreadNavigation", () => {
  it("keeps attached rootless threads visible in their Project navigation group", async () => {
    const client = {
      listThreads: vi.fn(async () => ({
        recents: [rootless, projectBacked],
        all: [rootless, projectBacked],
        unfiled: [rootless],
      })),
      lookupFirstTurn: vi.fn(),
    } as Pick<RootlessThreadClient, "listThreads" | "lookupFirstTurn">;
    const { result } = renderHook(() => useRootlessThreadNavigation(client));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.groupsForMode("code")).toMatchObject({
      recents: [
        {
          navigationId: rootlessThreadNavigationId(rootless),
          providerInstanceId: "20000000-0000-4000-8000-000000000011",
        },
        {
          navigationId: rootlessThreadNavigationId(projectBacked),
          providerInstanceId: "20000000-0000-4000-8000-000000000011",
          projectId: String(projectBacked.projectId),
        },
      ],
      all: [
        {
          navigationId: rootlessThreadNavigationId(rootless),
          providerInstanceId: "20000000-0000-4000-8000-000000000011",
        },
        {
          navigationId: rootlessThreadNavigationId(projectBacked),
          providerInstanceId: "20000000-0000-4000-8000-000000000011",
          projectId: String(projectBacked.projectId),
        },
      ],
      unfiled: [
        {
          navigationId: rootlessThreadNavigationId(rootless),
          providerInstanceId: "20000000-0000-4000-8000-000000000011",
        },
      ],
    });
    expect(result.current.byNavigationId.get(rootlessThreadNavigationId(projectBacked))).toEqual(
      projectBacked,
    );
  });

  it("refreshes an accepted first turn until its provider reply is terminal", async () => {
    const accepted = {
      ...rootless,
      initialTurn: {
        requestId: "40000000-0000-4000-8000-000000000011",
        threadId: rootless.threadId,
        turnId: "50000000-0000-4000-8000-000000000011",
        status: "accepted" as const,
        prompt: "Reply exactly ROOTLESS_OK",
        capabilities: {
          workspace: "rootless" as const,
          rootBackedTools: {
            availability: "unavailable" as const,
            reason:
              "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools." as const,
          },
        },
        acceptedAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
    } as RootlessThreadSummary;
    const completedTurn = {
      ...accepted.initialTurn!,
      status: "completed" as const,
      response: "ROOTLESS_OK",
    };
    const client = {
      listThreads: vi.fn(async () => ({
        recents: [accepted],
        all: [accepted],
        unfiled: [accepted],
      })),
      lookupFirstTurn: vi.fn(async () => ({ kind: "accepted", turn: completedTurn })),
    } as Pick<RootlessThreadClient, "listThreads" | "lookupFirstTurn">;

    const { result } = renderHook(() => useRootlessThreadNavigation(client));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(client.lookupFirstTurn).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(client.listThreads).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        result.current.byNavigationId.get(rootlessThreadNavigationId(rootless))?.initialTurn,
      ).toMatchObject({ status: "completed", response: "ROOTLESS_OK" }),
    );
  });
});

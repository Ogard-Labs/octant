import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  decodeCodeCheckoutIdentity,
  decodeCodeWorktreeSourcePreview,
  type CodeCommand,
  type CodeCommandResult,
} from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import { useCodeWorktreeSourcePreview } from "./useCodeWorktreeSourcePreview";

const projectId = "00000000-0000-0000-0000-000000000001" as ProjectId;
const bindingRevisionId = "00000000-0000-0000-0000-000000000002";
const repositoryId = `repo_${"a".repeat(64)}`;
const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const fetchedAt = "2026-07-30T08:00:00.000Z";

function preparedResult(): CodeCommandResult {
  return {
    kind: "checkout-prepared",
    bindingRevisionId: bindingRevisionId as never,
    checkout: decodeCodeCheckoutIdentity({
      id: "00000000-0000-0000-0000-000000000003",
      repositoryId,
      kind: "existing-worktree",
      availability: "available",
      head: { kind: "branch", name: "development", oid: "c".repeat(40) },
      observedAt: "2026-07-30T08:00:00.000Z",
    }),
  };
}

function previewOrigin(): CodeCommandResult {
  return {
    kind: "worktree-source-previewed",
    preview: decodeCodeWorktreeSourcePreview({
      kind: "origin",
      remoteName: "origin",
      branch: "development",
      resolvedHead: sha,
      fetchedAt,
    }),
  };
}

function makeExecute(preview: CodeCommandResult) {
  return vi.fn(async (command: CodeCommand) => {
    if (command.kind === "prepare-code-project-checkout") return preparedResult();
    if (command.kind === "preview-code-worktree-source") return preview;
    throw new Error(`unexpected command ${command.kind}`);
  });
}

describe("useCodeWorktreeSourcePreview", () => {
  it("prepares the checkout then previews the exact origin SHA before creation", async () => {
    const execute = makeExecute(previewOrigin());

    const { result } = renderHook(() =>
      useCodeWorktreeSourcePreview({
        execute,
        projectId,
        branch: "development",
        startFromOrigin: true,
        remoteName: "origin",
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.resolution.kind).toBe("origin"));
    expect(result.current.resolution).toEqual({
      kind: "origin",
      remoteName: "origin",
      branch: "development",
      resolvedHead: sha,
      fetchedAt,
    });
    const previewCall = execute.mock.calls.find(
      ([command]) => command.kind === "preview-code-worktree-source",
    );
    expect(previewCall?.[0]).toMatchObject({
      kind: "preview-code-worktree-source",
      projectId,
      bindingRevisionId,
      repositoryId,
      refIntent: "refs/heads/development",
      startFromOrigin: true,
      remoteName: "origin",
    });
  });

  it("stays idle when disabled and never infers a SHA", async () => {
    const execute = makeExecute(previewOrigin());
    const { result } = renderHook(() =>
      useCodeWorktreeSourcePreview({
        execute,
        projectId,
        branch: "development",
        startFromOrigin: true,
        enabled: false,
      }),
    );
    expect(result.current.resolution.kind).toBe("idle");
    expect(execute).not.toHaveBeenCalled();
  });

  it("exposes a typed failure and offers the cached snapshot only after a successful fetch", async () => {
    const failing = {
      kind: "worktree-source-previewed",
      preview: { kind: "failed", reason: "fetch-rejected" },
    } as CodeCommandResult;
    const execute = makeExecute(failing);

    const { result } = renderHook(() =>
      useCodeWorktreeSourcePreview({
        execute,
        projectId,
        branch: "development",
        startFromOrigin: true,
        remoteName: "origin",
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.resolution.kind).toBe("failed"));
    expect(result.current.resolution).toEqual({ kind: "failed", reason: "fetch-rejected" });
  });

  it("leaves fetching and exposes an unavailable failure when the server command rejects", async () => {
    const execute = vi.fn(async (): Promise<CodeCommandResult | undefined> => {
      throw new Error("transport unavailable");
    });

    const { result } = renderHook(() =>
      useCodeWorktreeSourcePreview({
        execute,
        projectId,
        branch: "development",
        startFromOrigin: true,
        remoteName: "origin",
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.resolution.kind).toBe("failed"));
    expect(result.current.resolution).toEqual({ kind: "failed", reason: "unavailable" });
  });

  it("cancels the in-flight preview when the source selection changes", async () => {
    const signals: AbortSignal[] = [];
    const execute = vi.fn(async (command: CodeCommand, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (command.kind === "prepare-code-project-checkout") return preparedResult();
      return previewOrigin();
    });

    const { result, rerender } = renderHook(
      (remoteName: string) =>
        useCodeWorktreeSourcePreview({
          execute,
          projectId,
          branch: "development",
          startFromOrigin: true,
          remoteName,
          enabled: true,
        }),
      { initialProps: "origin" },
    );

    rerender("upstream");
    await waitFor(() => expect(result.current.resolution.kind).toBe("origin"));
    expect(signals.length).toBeGreaterThan(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

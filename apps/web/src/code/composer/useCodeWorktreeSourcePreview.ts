import type { CodeCommand, CodeCommandResult } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import {
  worktreePreviewToResolution,
  type WorktreeSourceResolution,
} from "@octant/domain/code-worktree-source-policy";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseCodeWorktreeSourcePreviewOptions {
  readonly execute: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
  readonly projectId?: ProjectId;
  readonly branch: string;
  readonly startFromOrigin: boolean;
  readonly remoteName?: string;
  readonly enabled: boolean;
}

export interface CodeWorktreeSourcePreviewState {
  readonly resolution: WorktreeSourceResolution;
  readonly refresh: () => void;
}

/**
 * Drives the server-authoritative source preview for the composer. It prepares
 * the bound checkout, then asks the server to resolve the exact object ID for
 * the selected source (fetching the remote first in origin mode). The renderer
 * never infers a SHA: it displays exactly what the server resolved and surfaces
 * typed failures with an explicit retry. Each run aborts the previous in-flight
 * preview so a stale response never overwrites a newer selection.
 */
export function useCodeWorktreeSourcePreview(
  options: UseCodeWorktreeSourcePreviewOptions,
): CodeWorktreeSourcePreviewState {
  const [resolution, setResolution] = useState<WorktreeSourceResolution>({ kind: "idle" });
  const [refreshTick, setRefreshTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!options.enabled || options.projectId === undefined) {
      setResolution({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    const projectId = options.projectId;
    const branch = options.branch;
    const remoteName = options.remoteName;
    setResolution({ kind: "fetching", remoteName: remoteName ?? "origin", branch });

    void (async () => {
      try {
        const prepared = await options.execute(
          { kind: "prepare-code-project-checkout", projectId },
          controller.signal,
        );
        if (controller.signal.aborted || !mounted.current) return;
        if (prepared?.kind !== "checkout-prepared") {
          setResolution({ kind: "failed", reason: "unavailable" });
          return;
        }
        const result = await options.execute(
          {
            kind: "preview-code-worktree-source",
            projectId,
            bindingRevisionId: prepared.bindingRevisionId,
            repositoryId: prepared.checkout.repositoryId,
            refIntent: `refs/heads/${branch}`,
            startFromOrigin: options.startFromOrigin,
            ...(remoteName === undefined ? {} : { remoteName }),
          },
          controller.signal,
        );
        if (controller.signal.aborted || !mounted.current) return;
        if (result?.kind !== "worktree-source-previewed") {
          setResolution({ kind: "failed", reason: "unavailable" });
          return;
        }
        setResolution(worktreePreviewToResolution(result.preview));
      } catch {
        if (controller.signal.aborted || !mounted.current) return;
        setResolution({ kind: "failed", reason: "unavailable" });
      }
    })();

    return () => controller.abort();
  }, [
    options.enabled,
    options.projectId,
    options.branch,
    options.startFromOrigin,
    options.remoteName,
    options.execute,
    refreshTick,
  ]);

  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  return { resolution, refresh };
}

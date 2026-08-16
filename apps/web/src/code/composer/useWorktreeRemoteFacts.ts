import type { CodeCommand, CodeCommandResult } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import type { WorktreeRemoteFacts } from "@octant/domain/code-worktree-source-policy";
import { useEffect, useRef, useState } from "react";

/**
 * D3: Fetches server-authoritative remote facts for a Code Project so the
 * composer can decide whether "Start from origin" is available and which
 * remote to default to. The server observes the Git repository and returns
 * authoritative remotes/upstream/default. When no project is selected or the
 * server is unavailable, the hook returns undefined so the composer fails
 * closed with no remotes.
 *
 * Each run aborts the previous in-flight request so a stale response never
 * overwrites a newer selection, mirroring useCodeWorktreeSourcePreview.
 */
export function useWorktreeRemoteFacts(options: {
  readonly execute?: (
    command: CodeCommand,
    signal?: AbortSignal,
  ) => Promise<CodeCommandResult | undefined>;
  readonly projectId?: ProjectId;
  readonly enabled?: boolean;
}): Readonly<{
  remoteFacts: WorktreeRemoteFacts | undefined;
  loading: boolean;
}> {
  const { execute, projectId, enabled = true } = options;
  const [remoteFacts, setRemoteFacts] = useState<WorktreeRemoteFacts | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (execute === undefined || projectId === undefined || !enabled) {
      setRemoteFacts(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const result = await execute(
          { kind: "get-worktree-remote-facts", projectId },
          controller.signal,
        );
        if (controller.signal.aborted || !mounted.current) return;
        if (result?.kind === "worktree-remote-facts-retrieved") {
          const facts: WorktreeRemoteFacts = {
            remotes: [...result.facts.remotes],
            ...(result.facts.upstreamRemote === undefined
              ? {}
              : { upstreamRemote: result.facts.upstreamRemote }),
            ...(result.facts.defaultRemote === undefined
              ? {}
              : { defaultRemote: result.facts.defaultRemote }),
          };
          setRemoteFacts(facts);
        } else {
          setRemoteFacts(undefined);
        }
      } catch {
        if (controller.signal.aborted || !mounted.current) return;
        setRemoteFacts(undefined);
      } finally {
        if (!controller.signal.aborted && mounted.current) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [execute, projectId, enabled]);

  return { remoteFacts, loading };
}

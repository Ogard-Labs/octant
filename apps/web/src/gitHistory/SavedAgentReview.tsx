import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunResultPacket, AgentRunReviewResponse } from "@octant/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentResultWorkspaceLabel } from "../agents/AgentRunResults";
import { parseUnifiedDiff } from "../code/unifiedDiff";
import { UnifiedDiffList } from "../code/UnifiedDiffList";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";

export interface AgentResultReviewRequest {
  readonly packet: AgentRunResultPacket;
  readonly filePath?: string;
}

/** A saved comparison has no live checkout reader or mutation callbacks. */
export function SavedAgentReview(props: {
  readonly request: AgentResultReviewRequest;
  readonly parentThreadId: string;
  readonly client?: Pick<AgentRunClient, "review">;
  readonly onBack?: () => void;
}) {
  const packet = props.request.packet;
  const [response, setResponse] = useState<AgentRunReviewResponse>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filePath, setFilePath] = useState(props.request.filePath);
  useEffect(() => {
    setFilePath(props.request.filePath);
  }, [props.request]);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
  }, []);
  const review = props.client?.review;
  const canRead =
    review !== undefined &&
    packet.review !== undefined &&
    packet.files.reviewStatus === "available" &&
    packet.workspace.kind === "code-worktree" &&
    String(packet.parentThreadId) === props.parentThreadId;
  useEffect(() => {
    if (!canRead || review === undefined) return;
    let active = true;
    setResponse(undefined);
    setFailed(false);
    void review(packet.runId, packet.generation).then(
      (result) => {
        if (!active) return;
        if (
          String(result.runId) !== String(packet.runId) ||
          String(result.parentThreadId) !== String(packet.parentThreadId) ||
          result.generation !== packet.generation
        ) {
          setFailed(true);
          return;
        }
        setResponse(result);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [canRead, review, packet.runId, packet.parentThreadId, packet.generation, retry]);
  const snapshot = response?.status === "available" ? response.snapshot : undefined;
  const files = useMemo(() => parseUnifiedDiff(snapshot?.diff ?? ""), [snapshot?.diff]);
  const selected =
    filePath === undefined ? undefined : files.find((file) => file.path === filePath);
  const unavailable = !canRead || failed || response?.status === "unavailable";

  return (
    <section aria-label="Saved child review" className="git-history agent-review">
      <div className="git-history__toolbar">
        {props.onBack === undefined ? null : (
          <OctantButton ref={back} onClick={props.onBack} variant="ghost" size="sm">
            Back to subagent
          </OctantButton>
        )}
        <span>Saved comparison · Read only</span>
      </div>
      <div className="git-history__detail">
        <header className="git-history__commit-header">
          <h2>Generation {packet.generation} changes</h2>
          <p>{packet.modelId}</p>
          <details className="git-history__message">
            <summary>Attribution</summary>
            <div role="group" aria-label="Review attribution">
              <p>
                Run: {packet.runId} · Parent: {packet.parentThreadId}
              </p>
              <p>{agentResultWorkspaceLabel(packet)}</p>
              <p>
                Provider ID: {packet.providerInstanceId} · Model: {packet.modelId}
              </p>
              {snapshot === undefined ? null : (
                <>
                  <p>
                    Captured:{" "}
                    <time dateTime={snapshot.capturedAt}>
                      {new Date(snapshot.capturedAt).toLocaleString()}
                    </time>
                  </p>
                  <p>
                    Base tree: <code>{snapshot.baseTree}</code>
                  </p>
                  <p>
                    Result tree: <code>{snapshot.resultTree}</code>
                  </p>
                </>
              )}
            </div>
          </details>
        </header>
        {unavailable ? (
          <p className="git-history__notice" role="status">
            Saved review unavailable.
            {failed ? (
              <OctantButton
                variant="ghost"
                size="sm"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry saved review
              </OctantButton>
            ) : null}
          </p>
        ) : snapshot === undefined ? (
          <ShellState state="loading" title="Loading saved review" />
        ) : (
          <>
            {snapshot.truncated ? (
              <p className="git-history__notice" role="note">
                This captured comparison is partial. Some paths or diff content are not retained.
              </p>
            ) : null}
            {filePath === undefined ? null : (
              <div className="git-history__toolbar">
                <OctantButton variant="ghost" size="sm" onClick={() => setFilePath(undefined)}>
                  All captured changes
                </OctantButton>
              </div>
            )}
            {filePath !== undefined && selected === undefined ? (
              <p className="git-history__notice">
                {snapshot.changedPaths.includes(filePath)
                  ? `${filePath} has no retained diff in this comparison.`
                  : `${filePath} is not in this captured comparison.`}{" "}
                Open all captured changes to inspect the retained files.
              </p>
            ) : (
              <UnifiedDiffList files={selected === undefined ? files : [selected]} />
            )}
            {filePath === undefined ? (
              <>
                {files.length === 0 && snapshot.changedPaths.length === 0 ? (
                  <p className="git-history__notice">No file changes in the retained comparison.</p>
                ) : null}
                {snapshot.changedPaths
                  .filter((path) => !files.some((file) => file.path === path))
                  .map((path) => (
                    <p key={path} className="git-history__notice">
                      {path} has no retained diff in this comparison.
                    </p>
                  ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

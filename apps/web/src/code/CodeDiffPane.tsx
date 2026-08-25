import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeApprovalId,
  CodeCheckoutId,
  CodeGitOperationId,
  CodeRelativePath,
  CodeThreadId,
} from "@octant/contracts/code";
import type {
  CodeEvidenceReference,
  CodeOperationId,
  CodeOperationResult,
} from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { MonacoDiffAdapter } from "./MonacoDiffAdapter";
import type { MonacoDiffRuntime } from "./MonacoEditorAdapter";
import { parseUnifiedDiff, type ParsedDiffFile } from "./unifiedDiff";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;
type RunReviewed = Extract<CodeOperationResult, { readonly kind: "run-reviewed" }>;

export type CodeDiffProjection =
  | {
      readonly state: "available";
      readonly checkoutId: CodeCheckoutId;
      readonly threadId: CodeThreadId;
      readonly observation: GitObservation;
    }
  | {
      readonly state: "run";
      readonly checkoutId: CodeCheckoutId;
      readonly threadId: CodeThreadId;
      readonly run: RunReviewed;
    }
  | { readonly state: "loading" }
  | { readonly state: "stale"; readonly message: string }
  | { readonly state: "unavailable"; readonly message: string };

export interface CodeDiffPaneProps {
  readonly client: Pick<CodeClient, "operationContent" | "executeOperation">;
  readonly createGitOperationId?: () => CodeGitOperationId;
  readonly createOperationId?: () => CodeOperationId;
  readonly diff: CodeDiffProjection;
  /**
   * The thread's posture. Discarding is offered only when the thread may
   * mutate the checkout at all, and only through the same approval the host
   * would demand for any other destructive Git effect.
   */
  readonly executionPolicy?: ProviderExecutionPolicy;
  readonly loadRuntime?: () => Promise<MonacoDiffRuntime>;
  /** Opens a changed file as an editor tab; absent when no editor is bound. */
  readonly onOpenFile?: (path: string) => void;
  readonly requestApproval?: (
    command: Parameters<CodeClient["executeOperation"]>[0],
  ) => Promise<CodeApprovalId | undefined>;
  /**
   * The checkout moved while this snapshot was on screen. Review keeps the
   * files the user is looking at and asks them to refresh, rather than wiping
   * the comparison the moment a watch notice arrives.
   */
  readonly staleNotice?: { readonly message: string; readonly onRefresh: () => void };
}

type ContentState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string };

type DiffSnapshot = {
  readonly operationId: CodeOperationId;
  readonly changedPaths: ReadonlyArray<string>;
  readonly evidence: CodeEvidenceReference;
  readonly status: GitObservation["status"];
  readonly stateToken?: GitObservation["stateToken"];
  readonly title: string;
};

const CHANGE_LABELS: Readonly<Record<ParsedDiffFile["change"], string>> = {
  created: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
};

export function CodeDiffPane(props: CodeDiffPaneProps) {
  if (props.diff.state === "available" || props.diff.state === "run") {
    const summary = snapshot(props.diff);
    if (summary.changedPaths.length === 0) {
      return (
        <ShellState
          message="This checkout has no local changes to review."
          state="neutral"
          title="Checkout is clean"
        />
      );
    }
    return <AvailableDiff {...props} diff={props.diff} snapshot={summary} />;
  }
  if (props.diff.state === "loading") return <p role="status">Loading Git diff…</p>;
  return <p role="alert">{props.diff.message}</p>;
}

function AvailableDiff(
  props: CodeDiffPaneProps & {
    readonly diff: Extract<CodeDiffProjection, { readonly state: "available" | "run" }>;
    readonly snapshot: DiffSnapshot;
  },
) {
  const [content, setContent] = useState<ContentState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string>();
  const [sideBySide, setSideBySide] = useState(true);
  const [confirmingDiscard, setConfirmingDiscard] = useState<string>();
  const [discarding, setDiscarding] = useState(false);
  const [discardMessage, setDiscardMessage] = useState<string>();
  const generation = useRef(0);
  const evidence = props.snapshot.evidence;
  const operationId = props.snapshot.operationId;
  const threadId = props.diff.threadId;
  const policy = props.executionPolicy;
  const createOperationId = props.createOperationId;
  const createGitOperationId = props.createGitOperationId;
  const stateToken = props.snapshot.stateToken;
  // Only a tracked change can be restored from HEAD, and only a thread that may
  // mutate this checkout — with a way to raise the approval its posture demands
  // — is offered the control at all. A run review has no checkout state token,
  // so discard stays off: that snapshot is a branch comparison, not a working
  // tree the host can restore from HEAD.
  const tracked = new Map(
    props.snapshot.status
      .filter((entry) => entry.index !== "?" && entry.worktree !== "?")
      .map((entry) => [String(entry.path), entry.path] as const),
  );
  const mayDiscard =
    policy !== undefined &&
    policy !== "plan" &&
    createOperationId !== undefined &&
    createGitOperationId !== undefined &&
    stateToken !== undefined &&
    (!decidesCodeEffectsByApproval(policy) || props.requestApproval !== undefined);

  async function discard(path: CodeRelativePath) {
    if (createOperationId === undefined || createGitOperationId === undefined) return;
    if (stateToken === undefined) return;
    setConfirmingDiscard(undefined);
    setDiscardMessage(undefined);
    const command = {
      kind: "discard-git-changes",
      operationId: createOperationId(),
      gitOperationId: createGitOperationId(),
      paths: [path],
      expectedStateToken: stateToken,
      threadId,
      checkoutId: props.diff.checkoutId,
    } as const;
    setDiscarding(true);
    try {
      if (
        policy !== undefined &&
        decidesCodeEffectsByApproval(policy) &&
        (await props.requestApproval?.(command)) === undefined
      ) {
        setDiscardMessage(`${path} was not discarded. The change is untouched.`);
        return;
      }
      const result = await props.client.executeOperation(command);
      if (result.kind === "operation-failed") setDiscardMessage(result.failure.message);
      else if (result.kind === "git-mutation-state" && result.state === "completed")
        setDiscardMessage(`Discarded uncommitted changes to ${path}.`);
      else if (result.kind === "git-mutation-state")
        setDiscardMessage(
          `${path} was ${result.state}. Refresh checkout state before trying again.`,
        );
      else setDiscardMessage("Discard requested. Waiting for authoritative checkout refresh.");
    } catch {
      setDiscardMessage("Discard failed. Refresh checkout state and retry.");
    } finally {
      setDiscarding(false);
    }
  }

  useEffect(() => {
    const request = ++generation.current;
    let active = true;
    setContent({ kind: "loading" });
    void props.client
      .operationContent(threadId, operationId, evidence.contentId)
      .then((bytes) => {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("Diff evidence is not valid UTF-8.");
        }
        if (active && request === generation.current) setContent({ kind: "ready", text });
      })
      .catch((error: unknown) => {
        if (!active || request !== generation.current) return;
        setContent({
          kind: "unavailable",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Git diff evidence is unavailable.",
        });
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [evidence.contentId, operationId, props.client, threadId]);

  const files = useMemo(
    () => (content.kind === "ready" ? parseUnifiedDiff(content.text) : []),
    [content],
  );
  const selected = files.find((file) => file.id === selectedId) ?? files[0];
  const trackedPath = selected === undefined ? undefined : tracked.get(selected.path);

  return (
    <section aria-label="Review" className="code-diff-pane">
      <header className="code-diff-pane__toolbar">
        <div>
          <span>Review</span>
          <h1>{props.snapshot.title}</h1>
        </div>
        <p>{props.snapshot.changedPaths.length.toLocaleString()} changed paths</p>
        <OctantToggleGroup<"side-by-side" | "inline">
          aria-label="Diff layout"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected !== undefined) setSideBySide(selected === "side-by-side");
          }}
          value={[sideBySide ? "side-by-side" : "inline"]}
        >
          <OctantToggleGroupItem value="side-by-side">Side by side</OctantToggleGroupItem>
          <OctantToggleGroupItem value="inline">Inline</OctantToggleGroupItem>
        </OctantToggleGroup>
      </header>

      {props.staleNotice === undefined ? null : (
        <div className="code-diff-pane__warning" role="alert">
          <strong>{props.staleNotice.message}</strong>
          <OctantButton
            className="btn btn-secondary btn-sm"
            onClick={props.staleNotice.onRefresh}
            type="button"
          >
            Refresh
          </OctantButton>
        </div>
      )}

      {evidence.truncated === true ? (
        <div className="code-diff-pane__warning" role="alert">
          <strong>This diff is truncated and is not complete.</strong>
          <p>{evidence.byteLength.toLocaleString()} bytes retained</p>
        </div>
      ) : null}

      {content.kind === "loading" ? <p role="status">Loading diff evidence…</p> : null}
      {content.kind === "unavailable" ? <p role="alert">{content.message}</p> : null}
      {content.kind === "ready" && files.length === 0 ? (
        <p role="status">This checkout has no textual changes.</p>
      ) : null}

      {selected === undefined ? null : (
        <div className="code-diff-pane__body">
          <nav aria-label="Changed files" className="code-diff-pane__files">
            <ul>
              {files.map((file) => (
                <li key={file.id}>
                  <OctantButton
                    aria-current={file.id === selected.id}
                    className="code-diff-pane__file"
                    onClick={() => setSelectedId(file.id)}
                    type="button"
                  >
                    <span className="code-diff-pane__file-path">{file.path}</span>
                    <span className="code-diff-pane__file-change">
                      {CHANGE_LABELS[file.change]}
                    </span>
                    {file.binary ? null : (
                      <span className="code-diff-pane__file-counts">
                        <span className="code-diff-pane__file-additions">
                          +{file.additions.toLocaleString()}
                        </span>
                        <span className="code-diff-pane__file-deletions">
                          −{file.deletions.toLocaleString()}
                        </span>
                      </span>
                    )}
                  </OctantButton>
                </li>
              ))}
            </ul>
          </nav>

          <div className="code-diff-pane__detail">
            <div className="code-diff-pane__detail-header">
              <h2>{selected.path}</h2>
              {selected.previousPath === undefined ? null : (
                <p className="code-diff-pane__renamed-from">Renamed from {selected.previousPath}</p>
              )}
              {props.onOpenFile === undefined || selected.change === "deleted" ? null : (
                <OctantButton
                  className="btn btn-secondary btn-sm"
                  onClick={() => props.onOpenFile?.(selected.path)}
                  type="button"
                >
                  Open in editor
                </OctantButton>
              )}
              {mayDiscard && trackedPath !== undefined ? (
                <OctantButton
                  className="btn btn-danger btn-sm"
                  disabled={discarding}
                  onClick={() => setConfirmingDiscard(selected.path)}
                  type="button"
                >
                  Discard changes
                </OctantButton>
              ) : null}
            </div>
            {confirmingDiscard === selected.path && trackedPath !== undefined ? (
              <div
                className="code-diff-pane__confirm"
                role="alertdialog"
                aria-label="Discard changes"
              >
                <p>
                  Discard the uncommitted changes to {selected.path}? Nothing has committed them, so
                  they cannot be recovered.
                </p>
                <div className="code-diff-pane__confirm-actions">
                  <OctantButton
                    className="btn btn-danger btn-sm"
                    disabled={discarding}
                    onClick={() => void discard(trackedPath)}
                    type="button"
                  >
                    Discard permanently
                  </OctantButton>
                  <OctantButton
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirmingDiscard(undefined)}
                    type="button"
                  >
                    Keep changes
                  </OctantButton>
                </div>
              </div>
            ) : null}
            {discardMessage === undefined ? null : (
              <p className="code-diff-pane__discard-message" role="status">
                {discardMessage}
              </p>
            )}
            {selected.binary ? (
              <p role="status">
                This file changed without a textual diff, so there is nothing to compare.
              </p>
            ) : (
              <MonacoDiffAdapter
                ariaLabel={`Diff for ${selected.path}`}
                language="plaintext"
                {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
                modelUriBase={modelUriBase(props.diff.checkoutId, evidence.contentId, selected.id)}
                modified={selected.modified}
                original={selected.original}
                renderSideBySide={sideBySide}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function snapshot(
  diff: Extract<CodeDiffProjection, { readonly state: "available" | "run" }>,
): DiffSnapshot {
  if (diff.state === "run") {
    return {
      operationId: diff.run.operationId,
      changedPaths: diff.run.outcome.changedPaths,
      evidence: diff.run.outcome.diff,
      status: [],
      title: `Changes vs ${diff.run.outcome.baseRef}`,
    };
  }
  return {
    operationId: diff.observation.operationId,
    changedPaths: diff.observation.changedPaths,
    evidence: diff.observation.diff,
    status: diff.observation.status,
    stateToken: diff.observation.stateToken,
    title: "Local changes",
  };
}

function modelUriBase(checkoutId: CodeCheckoutId, contentId: string, fileId: string): string {
  return `octant-code://${checkoutId}/diff/${contentId}/${encodeURIComponent(fileId)}`;
}

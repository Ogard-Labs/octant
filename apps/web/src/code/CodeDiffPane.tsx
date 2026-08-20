import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeApprovalId,
  CodeCheckoutId,
  CodeGitOperationId,
  CodeRelativePath,
  CodeThreadId,
} from "@octant/contracts/code";
import type { CodeOperationId, CodeOperationResult } from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { MonacoDiffAdapter } from "./MonacoDiffAdapter";
import type { MonacoDiffRuntime } from "./MonacoEditorAdapter";
import { parseUnifiedDiff, type ParsedDiffFile } from "./unifiedDiff";

type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;

export type CodeDiffProjection =
  | {
      readonly state: "available";
      readonly checkoutId: CodeCheckoutId;
      readonly threadId: CodeThreadId;
      readonly observation: GitObservation;
    }
  | { readonly state: "loading" }
  | { readonly state: "stale" | "unavailable"; readonly message: string };

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
}

type ContentState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string };

const CHANGE_LABELS: Readonly<Record<ParsedDiffFile["change"], string>> = {
  created: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
};

export function CodeDiffPane(props: CodeDiffPaneProps) {
  if (props.diff.state === "loading") return <p role="status">Loading Git diff…</p>;
  if (props.diff.state !== "available") {
    return <p role="alert">{props.diff.message}</p>;
  }
  return <AvailableDiff {...props} diff={props.diff} />;
}

function AvailableDiff(
  props: CodeDiffPaneProps & {
    readonly diff: Extract<CodeDiffProjection, { readonly state: "available" }>;
  },
) {
  const [content, setContent] = useState<ContentState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string>();
  const [sideBySide, setSideBySide] = useState(true);
  const [confirmingDiscard, setConfirmingDiscard] = useState<string>();
  const [discarding, setDiscarding] = useState(false);
  const [discardMessage, setDiscardMessage] = useState<string>();
  const generation = useRef(0);
  const evidence = props.diff.observation.diff;
  const operationId = props.diff.observation.operationId;
  const threadId = props.diff.threadId;
  const policy = props.executionPolicy;
  // Only a tracked change can be restored from HEAD, and only a thread that may
  // mutate this checkout — with a way to raise the approval its posture demands
  // — is offered the control at all.
  const tracked = new Map(
    props.diff.observation.status
      .filter((entry) => entry.index !== "?" && entry.worktree !== "?")
      .map((entry) => [String(entry.path), entry.path] as const),
  );
  const mayDiscard =
    policy !== undefined &&
    policy !== "plan" &&
    props.createOperationId !== undefined &&
    props.createGitOperationId !== undefined &&
    (!decidesCodeEffectsByApproval(policy) || props.requestApproval !== undefined);

  async function discard(path: CodeRelativePath) {
    setConfirmingDiscard(undefined);
    setDiscardMessage(undefined);
    const command = {
      kind: "discard-git-changes",
      operationId: props.createOperationId!(),
      gitOperationId: props.createGitOperationId!(),
      paths: [path],
      expectedStateToken: props.diff.observation.stateToken,
      threadId,
      checkoutId: props.diff.checkoutId,
    } as const;
    setDiscarding(true);
    try {
      if (
        decidesCodeEffectsByApproval(policy!) &&
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

  return (
    <section aria-label="Code diff" className="code-diff-pane">
      <header className="code-diff-pane__toolbar">
        <div>
          <span>Git diff</span>
          <h1>Checkout changes</h1>
        </div>
        <p>{props.diff.observation.changedPaths.length.toLocaleString()} changed paths</p>
        <div className="segmented" role="group" aria-label="Diff layout">
          <button
            aria-pressed={sideBySide}
            className="segment"
            onClick={() => setSideBySide(true)}
            type="button"
          >
            Side by side
          </button>
          <button
            aria-pressed={!sideBySide}
            className="segment"
            onClick={() => setSideBySide(false)}
            type="button"
          >
            Inline
          </button>
        </div>
      </header>

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
                  <button
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
                  </button>
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
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => props.onOpenFile?.(selected.path)}
                  type="button"
                >
                  Open in editor
                </button>
              )}
              {mayDiscard && tracked.get(selected.path) !== undefined ? (
                <button
                  className="btn btn-danger btn-sm"
                  disabled={discarding}
                  onClick={() => setConfirmingDiscard(selected.path)}
                  type="button"
                >
                  Discard changes
                </button>
              ) : null}
            </div>
            {confirmingDiscard === selected.path ? (
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
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={discarding}
                    onClick={() => void discard(tracked.get(selected.path)!)}
                    type="button"
                  >
                    Discard permanently
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setConfirmingDiscard(undefined)}
                    type="button"
                  >
                    Keep changes
                  </button>
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

function modelUriBase(checkoutId: CodeCheckoutId, contentId: string, fileId: string): string {
  return `octant-code://${checkoutId}/diff/${contentId}/${encodeURIComponent(fileId)}`;
}

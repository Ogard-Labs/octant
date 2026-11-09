import { WorkspaceViewStateContext } from "../shell/workspaceViewState";
import { CodeProviderFileReview } from "./CodeProviderFileReview";
import type { CodeReviewLineSelection } from "./CodeLocalReview";
import type { CodeReviewFileRequest } from "./codeReviewNavigation";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeApprovalId,
  CodeCheckoutId,
  CodeDiffLayout,
  CodeGitOperationId,
  CodeRelativePath,
  CodeThreadId,
} from "@octant/contracts/code";
import type {
  CodeEvidenceReference,
  CodeOperationId,
  CodeOperationResult,
  CodeTurnReviewCapture,
} from "@octant/contracts/code-operations";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidesCodeEffectsByApproval } from "@octant/domain";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { MonacoDiffAdapter } from "./MonacoDiffAdapter";
import type { MonacoDiffRuntime } from "./MonacoEditorAdapter";
import { parseUnifiedDiff, diffModelRowSources, type ParsedDiffFile } from "./unifiedDiff";
import { UnifiedDiffList } from "./UnifiedDiffList";
import { CodeSelectedHunks } from "./CodeSelectedHunks";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { OctantAlert } from "../ui/base/OctantAlert";
import { readCodeDiffLayout, writeCodeDiffLayout } from "./codeDiffLayoutPreference";

type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;
type RunReviewed = Extract<CodeOperationResult, { readonly kind: "run-reviewed" }>;

export type CodeDiffProjection =
  | {
      readonly state: "turn";
      readonly checkoutId: CodeCheckoutId;
      readonly threadId: CodeThreadId;
      readonly operationId: CodeOperationId;
      readonly capture: CodeTurnReviewCapture;
      readonly text: string;
    }
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
  readonly onSelectReviewLine?: (selection: CodeReviewLineSelection) => void;
  readonly requestedCodeReviewFile?: CodeReviewFileRequest;
  readonly client: Pick<
    CodeClient,
    "operationContent" | "executeOperation" | "readProviderFileReview"
  >;
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
  /**
   * Settings default used only while this window has no stored layout for the
   * thread. Toggling writes the thread's own choice and leaves the default.
   */
  readonly defaultLayout?: CodeDiffLayout;
  /**
   * Whether the shown diff was read with whitespace ignored, and how to change
   * that. The owner rereads the diff from Git; the toggle is absent without it.
   */
  readonly ignoreWhitespace?: {
    readonly value: boolean;
    readonly onChange: (value: boolean) => void;
  };
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
  readonly captureCursor?: number;
};

const CHANGE_LABELS: Readonly<Record<ParsedDiffFile["change"], string>> = {
  created: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
};

export function CodeDiffPane(props: CodeDiffPaneProps) {
  if (
    props.diff.state === "available" ||
    props.diff.state === "run" ||
    props.diff.state === "turn"
  ) {
    const summary = snapshot(props.diff);
    if (summary.changedPaths.length === 0) {
      return (
        <ShellState
          message={
            props.diff.state === "turn"
              ? "This captured version has no readable changed paths. Later checkout edits may be uncaptured."
              : "This checkout has no local changes to review."
          }
          state="neutral"
          title={props.diff.state === "turn" ? "No paths in this capture" : "Checkout is clean"}
        />
      );
    }
    return (
      <AvailableDiff
        key={String(props.diff.threadId)}
        {...props}
        diff={props.diff}
        snapshot={summary}
      />
    );
  }
  if (props.diff.state === "loading") return <ShellState state="loading" title="Loading diff" />;
  return <OctantAlert tone="warning">{props.diff.message}</OctantAlert>;
}

function AvailableDiff(
  props: CodeDiffPaneProps & {
    readonly diff: Extract<CodeDiffProjection, { readonly state: "available" | "run" | "turn" }>;
    readonly snapshot: DiffSnapshot;
  },
) {
  const viewStore = useContext(WorkspaceViewStateContext);
  const viewKey = `review:${props.diff.threadId}:${props.diff.checkoutId}:${props.snapshot.evidence.digest}`;
  const savedReview = useMemo(() => viewStore?.read(viewKey), [viewStore, viewKey]);
  const reviewStack = useRef<HTMLDivElement>(null);
  const [loadedContent, setContent] = useState<ContentState>({ kind: "loading" });
  const content: ContentState =
    props.diff.state === "turn" ? { kind: "ready", text: props.diff.text } : loadedContent;
  const [selectedPath, setSelectedPath] = useState<string | undefined>(() =>
    savedReview?.kind === "review" ? savedReview.path : undefined,
  );
  const [providerReadsAvailable, setProviderReadsAvailable] = useState(false);
  const [providerFile, setProviderFile] = useState<{
    readonly path: string;
    readonly view: string;
  }>();
  const providerRead = props.client.readProviderFileReview;
  const checkpointOpener = useRef<HTMLElement>(null);
  useEffect(() => {
    setProviderReadsAvailable(false);
    if (props.diff.state !== "available" || providerRead === undefined) return;
    const controller = new AbortController();
    let active = true;
    void providerRead(
      { kind: "availability", threadId: props.diff.threadId, checkoutId: props.diff.checkoutId },
      controller.signal,
    )
      .then((answer) => {
        if (active && !controller.signal.aborted)
          setProviderReadsAvailable(answer.status === "available");
      })
      .catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [providerRead, props.diff.state, props.diff.threadId, props.diff.checkoutId, viewKey]);
  function readProviderFile(path: string) {
    checkpointOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProviderFile({ path, view: viewKey });
  }
  function choosePath(path: string) {
    setProviderFile(undefined);
    setSelectedPath(path);
    viewStore?.write(viewKey, {
      kind: "review",
      path,
      scrollTop: reviewStack.current?.scrollTop ?? 0,
    });
  }
  useLayoutEffect(() => {
    if (content.kind === "ready" && savedReview?.kind === "review" && reviewStack.current !== null)
      reviewStack.current.scrollTop = savedReview.scrollTop;
  }, [viewKey, content.kind]);
  const navigatedRequest = useRef<CodeReviewFileRequest | undefined>(undefined);
  // The stacked unified list is how a change is read; side by side is how one
  // file is studied, so it keeps the file list and the editor.
  const [layout, setLayout] = useState<CodeDiffLayout>(
    () => readCodeDiffLayout(props.diff.threadId) ?? props.defaultLayout ?? "unified",
  );
  // Storage can refuse a write after the person already picked a layout.
  // Later default sync must not overwrite that in-memory choice.
  const choseLayout = useRef(readCodeDiffLayout(props.diff.threadId) !== undefined);
  const sideBySide = layout === "side-by-side";
  const [confirmingDiscard, setConfirmingDiscard] = useState<string>();
  const [discarding, setDiscarding] = useState(false);
  const [discardMessage, setDiscardMessage] = useState<string>();
  const generation = useRef(0);
  const evidence = props.snapshot.evidence;
  const operationId = props.snapshot.operationId;
  const threadId = props.diff.threadId;
  useEffect(() => {
    if (choseLayout.current || readCodeDiffLayout(threadId) !== undefined) return;
    setLayout(props.defaultLayout ?? "unified");
  }, [props.defaultLayout, threadId]);
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
    if (props.diff.state === "turn") return;
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
  }, [evidence.contentId, operationId, props.client, threadId, props.diff.state]);

  const files = useMemo(
    () => (content.kind === "ready" ? parseUnifiedDiff(content.text) : []),
    [content.kind, content.kind === "ready" ? content.text : undefined],
  );
  const displayFiles = useMemo(
    () =>
      props.diff.state === "turn" && props.ignoreWhitespace?.value === true
        ? hideEdgeWhitespaceChanges(files)
        : files,
    [files, props.diff.state, props.ignoreWhitespace?.value],
  );
  useEffect(() => {
    const requested = props.requestedCodeReviewFile;
    if (requested === undefined) return;
    const file = files.find((item) => item.path === requested.path);
    if (file !== undefined && navigatedRequest.current !== requested) {
      choosePath(file.path);
      navigatedRequest.current = requested;
    }
  }, [files, props.requestedCodeReviewFile]);

  const selectionMissing =
    props.diff.state === "turn" &&
    selectedPath !== undefined &&
    !files.some((file) => file.path === selectedPath);
  const selected =
    files.find((file) => file.path === selectedPath) ?? (selectionMissing ? undefined : files[0]);
  const trackedPath = selected === undefined ? undefined : tracked.get(selected.path);

  return (
    <section aria-label="Review" className="code-diff-pane">
      <header className="code-diff-pane__toolbar">
        <div>
          <h1>{props.snapshot.title}</h1>
        </div>
        <p>
          {props.snapshot.changedPaths.length.toLocaleString("en")}{" "}
          {props.snapshot.changedPaths.length === 1 ? "changed path" : "changed paths"}
        </p>
        <OctantToggleGroup<CodeDiffLayout>
          aria-label="Diff layout"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected === undefined) return;
            choseLayout.current = true;
            setLayout(selected);
            writeCodeDiffLayout(threadId, selected);
          }}
          value={[layout]}
        >
          <OctantToggleGroupItem value="unified">Unified</OctantToggleGroupItem>
          <OctantToggleGroupItem value="side-by-side">Side by side</OctantToggleGroupItem>
        </OctantToggleGroup>
        {props.ignoreWhitespace === undefined ? null : (
          <label className="check">
            <OctantCheckbox
              checked={props.ignoreWhitespace.value}
              onChange={(event) => props.ignoreWhitespace?.onChange(event.target.checked)}
            />
            <span>
              {props.diff.state === "turn" ? "Ignore edge whitespace" : "Ignore whitespace"}
            </span>
          </label>
        )}
      </header>

      {props.diff.state === "available" &&
      props.createOperationId !== undefined &&
      props.createGitOperationId !== undefined &&
      props.executionPolicy !== undefined ? (
        <CodeSelectedHunks
          client={props.client}
          threadId={props.diff.threadId}
          checkoutId={props.diff.checkoutId}
          executionPolicy={props.executionPolicy}
          createOperationId={props.createOperationId}
          createGitOperationId={props.createGitOperationId}
          {...(props.requestApproval === undefined
            ? {}
            : { requestApproval: props.requestApproval })}
        />
      ) : null}

      {props.staleNotice === undefined ? null : (
        <OctantAlert className="code-diff-pane__warning" tone="warning">
          <strong>{props.staleNotice.message}</strong>
          <OctantButton
            size="sm"
            variant="outline"
            onClick={props.staleNotice.onRefresh}
            type="button"
          >
            Refresh
          </OctantButton>
        </OctantAlert>
      )}

      {evidence.truncated === true ? (
        <OctantAlert className="code-diff-pane__warning" tone="warning">
          <strong>This diff is truncated and is not complete.</strong>
          <p>{evidence.byteLength.toLocaleString("en")} bytes retained</p>
        </OctantAlert>
      ) : null}

      {content.kind === "loading" ? <ShellState state="loading" title="Loading diff" /> : null}
      {content.kind === "unavailable" ? (
        <OctantAlert tone="warning">{content.message}</OctantAlert>
      ) : null}
      {content.kind === "ready" &&
      props.requestedCodeReviewFile !== undefined &&
      !files.some((file) => file.path === props.requestedCodeReviewFile?.path) ? (
        <OctantAlert tone="warning">
          The receipt’s file is not in this current comparison. Its original per-turn diff was not
          retained here; no line has been retargeted.
        </OctantAlert>
      ) : null}
      {content.kind === "ready" && files.length === 0 ? (
        <p role="status">This checkout has no textual changes.</p>
      ) : null}

      {selectionMissing ? (
        <OctantAlert tone="warning">
          The previously selected file is absent from this captured version. Existing notes keep
          their original anchors; choose another file.
        </OctantAlert>
      ) : null}
      {props.diff.state === "available" &&
      providerReadsAvailable &&
      providerRead !== undefined &&
      providerFile?.view === viewKey &&
      files.some((file) => file.path === providerFile.path) ? (
        <CodeProviderFileReview
          key={`${viewKey}:${providerFile.path}`}
          read={providerRead}
          threadId={props.diff.threadId}
          checkoutId={props.diff.checkoutId}
          path={providerFile.path}
          onClose={() => {
            setProviderFile(undefined);
            checkpointOpener.current?.focus();
          }}
          {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
        />
      ) : null}
      {selected === undefined ? (
        files.length === 0 ? null : (
          <nav aria-label="Choose a captured file">
            <ul>
              {files.map((file) => (
                <li key={file.path}>
                  <OctantButton type="button" variant="bare" onClick={() => choosePath(file.path)}>
                    {file.path}
                  </OctantButton>
                </li>
              ))}
            </ul>
          </nav>
        )
      ) : !sideBySide ? (
        <div
          className="code-diff-pane__stack"
          ref={reviewStack}
          onScroll={(event) =>
            viewStore?.write(viewKey, {
              kind: "review",
              ...(selectedPath === undefined ? {} : { path: selectedPath }),
              scrollTop: event.currentTarget.scrollTop,
            })
          }
        >
          <UnifiedDiffList
            files={displayFiles}
            {...(props.diff.state === "available" && providerReadsAvailable
              ? { onReadProviderFile: readProviderFile }
              : {})}
            {...(props.requestedCodeReviewFile === undefined
              ? {}
              : { requestedFile: props.requestedCodeReviewFile })}
            {...(props.onSelectReviewLine === undefined
              ? {}
              : {
                  onSelectLine: (line: {
                    path: string;
                    side: "original" | "modified";
                    line: number;
                  }) =>
                    props.onSelectReviewLine?.({
                      ...line,
                      reviewOperationId: operationId,
                      ...(props.snapshot.captureCursor === undefined
                        ? {}
                        : { captureCursor: props.snapshot.captureCursor }),
                    }),
                })}
            {...(props.onOpenFile === undefined ? {} : { onOpenFile: props.onOpenFile })}
          />
        </div>
      ) : (
        <div className="code-diff-pane__body">
          <nav aria-label="Changed files" className="code-diff-pane__files">
            <ul>
              {files.map((file) => (
                <li key={file.id}>
                  <OctantButton
                    aria-current={file.id === selected.id}
                    className="code-diff-pane__file"
                    onClick={() => choosePath(file.path)}
                    type="button"
                    variant="bare"
                  >
                    <span className="code-diff-pane__file-path">{file.path}</span>
                    <span className="code-diff-pane__file-change">
                      {CHANGE_LABELS[file.change]}
                    </span>
                    {file.binary ? null : (
                      <span className="code-diff-pane__file-counts">
                        <span className="code-diff-pane__file-additions">
                          +{file.additions.toLocaleString("en")}
                        </span>
                        <span className="code-diff-pane__file-deletions">
                          −{file.deletions.toLocaleString("en")}
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
              {props.diff.state === "available" && providerReadsAvailable ? (
                <OctantButton
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => readProviderFile(selected.path)}
                >
                  Provider checkpoint
                </OctantButton>
              ) : null}
              {selected.previousPath === undefined ? null : (
                <p className="code-diff-pane__renamed-from">Renamed from {selected.previousPath}</p>
              )}
              {props.onOpenFile === undefined || selected.change === "deleted" ? null : (
                <OctantButton
                  size="sm"
                  variant="outline"
                  onClick={() => props.onOpenFile?.(selected.path)}
                  type="button"
                >
                  Open in editor
                </OctantButton>
              )}
              {mayDiscard && trackedPath !== undefined ? (
                <OctantButton
                  size="sm"
                  variant="destructive"
                  disabled={discarding}
                  onClick={() => setConfirmingDiscard(selected.path)}
                  type="button"
                >
                  Discard changes
                </OctantButton>
              ) : null}
            </div>
            {confirmingDiscard === selected.path && trackedPath !== undefined ? (
              <OctantConfirmDialog
                title="Discard changes?"
                confirmLabel="Discard changes"
                cancelLabel="Keep changes"
                destructive
                pending={discarding}
                onCancel={() => setConfirmingDiscard(undefined)}
                onConfirm={() => void discard(trackedPath)}
              >
                Discard uncommitted changes to {selected.path}? This cannot be undone.
              </OctantConfirmDialog>
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
                modelUriBase={modelUriBase(
                  props.diff.checkoutId,
                  props.diff.state === "turn" ? String(operationId) : evidence.contentId,
                  props.diff.state === "turn" ? selected.path : selected.id,
                )}
                modified={selected.modified}
                original={selected.original}
                renderSideBySide={sideBySide}
                {...(props.diff.state === "turn"
                  ? { ignoreTrimWhitespace: props.ignoreWhitespace?.value === true }
                  : {})}
                {...(props.onSelectReviewLine === undefined
                  ? {}
                  : {
                      onSelectLine: (line: { side: "original" | "modified"; line: number }) => {
                        const source = diffModelRowSources(selected, line.side)[line.line - 1];
                        if (source !== undefined)
                          props.onSelectReviewLine?.({
                            reviewOperationId: operationId,
                            ...(props.snapshot.captureCursor === undefined
                              ? {}
                              : { captureCursor: props.snapshot.captureCursor }),
                            path: selected.path,
                            side: line.side,
                            line: source.line,
                          });
                      },
                    })}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function snapshot(
  diff: Extract<CodeDiffProjection, { readonly state: "available" | "run" | "turn" }>,
): DiffSnapshot {
  if (diff.state === "turn")
    return {
      operationId: diff.operationId,
      changedPaths: diff.capture.changedFiles.files.map((file) => file.path),
      evidence: diff.capture.diff,
      status: [],
      title: `${diff.capture.final ? "Final" : "Turn"} capture ${diff.capture.version}`,
      captureCursor: diff.capture.cursor,
    };
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

/** Only a view transform. Canonical sides, source numbers and evidence identity stay untouched. */
function hideEdgeWhitespaceChanges(
  files: ReadonlyArray<ParsedDiffFile>,
): ReadonlyArray<ParsedDiffFile> {
  return files.map((file) => ({
    ...file,
    hunks: file.hunks.map((hunk) => {
      const lines: Array<ParsedDiffFile["hunks"][number]["lines"][number]> = [];
      let at = 0;
      while (at < hunk.lines.length) {
        const first = hunk.lines[at];
        if (first === undefined) break;
        if (first.kind === "context") {
          lines.push(first);
          at++;
          continue;
        }
        const start = at;
        while (at < hunk.lines.length && hunk.lines[at]?.kind !== "context") at++;
        const run = hunk.lines.slice(start, at);
        const removed = run.filter((line) => line.kind === "removed");
        const added = run.filter((line) => line.kind === "added");
        if (
          removed.length > 0 &&
          removed.length === added.length &&
          removed.every((line, index) => line.text.trim() === added[index]?.text.trim())
        ) {
          removed.forEach((line, index) => {
            const next = added[index];
            lines.push({
              kind: "context",
              text: next?.text ?? line.text,
              ...(line.oldNumber === undefined ? {} : { oldNumber: line.oldNumber }),
              ...(next?.newNumber === undefined ? {} : { newNumber: next.newNumber }),
            });
          });
        } else lines.push(...run);
      }
      return { ...hunk, lines };
    }),
  }));
}

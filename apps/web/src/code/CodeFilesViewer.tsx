import type { CodeFileChangeNotice, CodeRelativePath, CodeThreadView } from "@octant/contracts";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantIconButton } from "../ui/base/OctantButton";
import { OctantTabs, OctantTabsList, OctantTabsTab } from "../ui/base/OctantTabs";
import { PanelRight, PanelRightOpen, X } from "../ui/icons";
import { pathBasename } from "../lib/fileName";
import type { CodeFileChange } from "./CodeFileExplorer";
import { CodeFileExplorerPanel, type CodeFileExplorerPanelProps } from "./CodeFileExplorerPanel";
import { noticeTouches } from "./useCodeFileChangeWatch";
import { useCodeEditorFile } from "./useCodeEditorFile";
import type { CodeController } from "./useCodeController";

const MonacoEditorPane = lazy(() =>
  import("./MonacoEditorPane").then((module) => ({ default: module.MonacoEditorPane })),
);

/** Below this width the tree and the editor take turns instead of sharing the pane. */
const NARROW_PANE_PX = 420;

interface OpenFile {
  readonly path: CodeRelativePath;
  /** A preview tab is replaced by the next single click; keeping it makes it stay. */
  readonly preview: boolean;
}

export interface CodeFilesViewerProps {
  readonly controller: Pick<
    CodeController,
    "client" | "conversation" | "editorDrafts" | "pendingDraft" | "setPendingDraft"
  >;
  readonly view: CodeThreadView | undefined;
  readonly hostBridge?: OctantHostBridge | undefined;
  /** The Files tool's own props for the tree: checkout, extra folders, transport. */
  readonly explorer: Omit<
    CodeFileExplorerPanelProps,
    "onOpenFile" | "onKeepFile" | "selectedPath" | "changes" | "onFilesChanged"
  >;
  /** Opens the file as a workspace tab: an explicit act from the file menu. */
  readonly onOpenInMainArea: (path: CodeRelativePath) => void;
}

/**
 * The Files tool in a Code thread: files open here, beside the thread, never in
 * its place. A strip of open files stands over the editor, the tree is a column
 * at its right, and a single click previews a file in the one italic tab that
 * the next click replaces. A double click or an edit keeps the tab.
 */
export function CodeFilesViewer(props: CodeFilesViewerProps) {
  const [files, setFiles] = useState<ReadonlyArray<OpenFile>>([]);
  const [active, setActive] = useState<CodeRelativePath>();
  const [treeOpen, setTreeOpen] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const refreshActive = useRef<(() => void) | undefined>(undefined);
  const [changes, observeChanges] = useCheckoutChanges(props.controller.client, props.view);

  const open = useCallback((path: CodeRelativePath, keep: boolean, fromTree = false) => {
    setFiles((current) => {
      const existing = current.find((file) => file.path === path);
      if (existing !== undefined) {
        return keep && existing.preview
          ? current.map((file) => (file === existing ? { path, preview: false } : file))
          : current;
      }
      if (keep) return [...current, { path, preview: false }];
      const previewAt = current.findIndex((file) => file.preview);
      return previewAt < 0
        ? [...current, { path, preview: true }]
        : current.map((file, index) => (index === previewAt ? { path, preview: true } : file));
    });
    setActive(path);
    // In a pane too narrow for both, the tree gives way to the file just chosen.
    if (!fromTree) return;
    const width = root.current?.getBoundingClientRect().width ?? 0;
    if (width > 0 && width < NARROW_PANE_PX) setTreeOpen(false);
  }, []);

  const close = (path: CodeRelativePath) => {
    const index = files.findIndex((file) => file.path === path);
    const remaining = files.filter((file) => file.path !== path);
    setFiles(remaining);
    if (active === path) setActive(remaining[Math.min(index, remaining.length - 1)]?.path);
  };

  const keep = useCallback((path: CodeRelativePath) => open(path, true), [open]);
  const changesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(changesTimer.current), []);
  const dirtyKeeps = useCallback(
    (path: CodeRelativePath, dirty: boolean) => {
      if (dirty) keep(path);
    },
    [keep],
  );

  const onFilesChanged = useCallback(
    (notice: CodeFileChangeNotice) => {
      if (active !== undefined && noticeTouches(notice, String(active))) refreshActive.current?.();
      // An agent writing many files sends many notices; the marks settle once.
      clearTimeout(changesTimer.current);
      changesTimer.current = setTimeout(observeChanges, 1000);
    },
    [active, observeChanges],
  );

  return (
    <div className="code-files-viewer" data-tree={treeOpen ? "open" : "closed"} ref={root}>
      <div className="code-files-viewer__main">
        <div className="code-files-viewer__strip">
          {files.length === 0 ? (
            <span className="code-files-viewer__strip-fill" />
          ) : (
            <OctantTabs
              className="code-files-viewer__tabs"
              onValueChange={(value) => {
                if (typeof value === "string") setActive(value as CodeRelativePath);
              }}
              value={active ?? ""}
            >
              <OctantTabsList aria-label="Open files" className="code-files-viewer__tab-list">
                {files.map((file) => {
                  const name = pathBasename(file.path);
                  return (
                    <div
                      className="content-tab code-files-viewer__tab"
                      data-preview={file.preview ? "true" : undefined}
                      key={file.path}
                      role="presentation"
                    >
                      <OctantTabsTab
                        className="content-tab__select border-0 bg-transparent text-inherit hover:bg-transparent focus-visible:bg-transparent aria-expanded:bg-transparent data-active:bg-transparent data-active:text-inherit"
                        onDoubleClick={() => keep(file.path)}
                        title={file.path}
                        value={file.path}
                      >
                        <span>{name}</span>
                        {file.preview ? <span className="sr-only">, preview</span> : null}
                      </OctantTabsTab>
                      <OctantIconButton
                        className="content-tab__close text-muted-foreground"
                        label={`Close ${name}`}
                        onClick={() => close(file.path)}
                      >
                        <X aria-hidden="true" size={12} />
                      </OctantIconButton>
                    </div>
                  );
                })}
              </OctantTabsList>
            </OctantTabs>
          )}
          <OctantIconButton
            aria-pressed={treeOpen}
            className="code-files-viewer__tree-toggle"
            label={treeOpen ? "Hide file tree" : "Show file tree"}
            onClick={() => setTreeOpen((value) => !value)}
          >
            {treeOpen ? (
              <PanelRightOpen aria-hidden="true" size={16} />
            ) : (
              <PanelRight aria-hidden="true" size={16} />
            )}
          </OctantIconButton>
        </div>
        <div className="code-files-viewer__body">
          {active === undefined || props.view === undefined ? (
            <p className="code-files-viewer__empty">Choose a file to open it here.</p>
          ) : (
            <ActiveFile
              controller={props.controller}
              hostBridge={props.hostBridge}
              key={active}
              onDirty={(dirty) => dirtyKeeps(active, dirty)}
              onOpen={(path) => open(path, false)}
              onOpenInMainArea={() => props.onOpenInMainArea(active)}
              path={active}
              refreshRef={refreshActive}
              view={props.view}
            />
          )}
        </div>
      </div>
      <aside aria-label="Files" className="code-files-viewer__tree">
        <CodeFileExplorerPanel
          {...props.explorer}
          changes={changes}
          onFilesChanged={onFilesChanged}
          onKeepFile={(entry) => open(entry.path, true, true)}
          onOpenFile={(entry) => open(entry.path, false, true)}
          {...(active === undefined ? {} : { selectedPath: active })}
        />
      </aside>
    </div>
  );
}

function ActiveFile(props: {
  readonly controller: CodeFilesViewerProps["controller"];
  readonly hostBridge: OctantHostBridge | undefined;
  readonly onDirty: (dirty: boolean) => void;
  readonly onOpen: (path: CodeRelativePath) => void;
  readonly onOpenInMainArea: () => void;
  readonly path: CodeRelativePath;
  readonly refreshRef: { current: (() => void) | undefined };
  readonly view: CodeThreadView;
}): ReactNode {
  const { controller, view } = props;
  const editorFile = useCodeEditorFile({
    client: controller.client,
    enabled: true,
    relativePath: props.path,
    threadId: view.thread.id,
    checkoutId: view.checkout.id,
    executionPolicy: view.thread.executionPolicy,
  });
  const refresh = editorFile.refresh;
  useEffect(() => {
    props.refreshRef.current = refresh;
    return () => {
      props.refreshRef.current = undefined;
    };
  }, [props.refreshRef, refresh]);
  const file = editorFile.file;
  const response = controller.conversation.findLast(
    (message) =>
      message.role === "assistant" &&
      message.status === "completed" &&
      (message.sourceThreadId === undefined || message.sourceThreadId === view.thread.id) &&
      (message.checkoutId === undefined || message.checkoutId === view.checkout.id),
  );
  const checkoutLabel =
    view.checkout.head.kind === "branch"
      ? view.checkout.head.name
      : view.checkout.head.kind === "detached"
        ? "Detached checkout"
        : "Project folder";
  const openExternal = props.hostBridge?.openCodeExternalEditor;
  const placeholder = (
    <p className="code-files-viewer__empty" role="status">
      Opening {pathBasename(props.path)}…
    </p>
  );
  if (file === undefined) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <MonacoEditorPane
        checkoutLabel={checkoutLabel}
        client={controller.client}
        debugProjectId={view.thread.projectId}
        draftStore={controller.editorDrafts}
        file={file}
        onAddSelectionToChat={(prompt) =>
          controller.setPendingDraft(
            controller.pendingDraft === "" ? prompt : `${controller.pendingDraft}\n\n${prompt}`,
          )
        }
        onDirtyChange={props.onDirty}
        onOpenFile={(path) => props.onOpen(path as CodeRelativePath)}
        onOpenInMainArea={props.onOpenInMainArea}
        onRequestRefresh={refresh}
        {...(response === undefined ? {} : { agentResponse: response.text })}
        {...(openExternal === undefined || view.checkout.kind === "remote-root"
          ? {}
          : {
              onOpenExternalEditor: () =>
                openExternal({
                  threadId: file.threadId,
                  checkoutId: file.checkoutId,
                  fileId: file.fileId,
                  line: 1,
                  column: 1,
                }),
            })}
      />
    </Suspense>
  );
}

/**
 * The checkout's changed files, read from the host's Git observation, for the
 * dot at the end of a changed row. It is a hint: a host that cannot answer
 * leaves the tree unmarked rather than failing it.
 */
function useCheckoutChanges(
  client: CodeFilesViewerProps["controller"]["client"],
  view: CodeThreadView | undefined,
): readonly [ReadonlyMap<string, CodeFileChange>, () => void] {
  const [changes, setChanges] = useState<ReadonlyMap<string, CodeFileChange>>(new Map());
  const threadId = view?.thread.id;
  const checkoutId = view?.checkout.id;
  const observe = useCallback(async () => {
    if (threadId === undefined || checkoutId === undefined) return undefined;
    try {
      const result = await client.executeOperation({
        kind: "observe-git",
        operationId: crypto.randomUUID() as never,
        gitOperationId: crypto.randomUUID() as never,
        maxDiffBytes: 1,
        threadId,
        checkoutId,
      });
      if (result.kind !== "git-observed") return undefined;
      const next = new Map<string, CodeFileChange>();
      for (const entry of result.status) {
        const codes = `${entry.index}${entry.worktree}`;
        if (codes.includes("D")) continue;
        next.set(
          String(entry.path),
          codes.includes("?") || codes.includes("A") ? "added" : "modified",
        );
      }
      return next;
    } catch {
      return undefined;
    }
  }, [client, threadId, checkoutId]);
  useEffect(() => {
    let live = true;
    void observe().then((next) => {
      if (live && next !== undefined) setChanges(next);
    });
    return () => {
      live = false;
    };
  }, [observe]);
  const refresh = useCallback(() => {
    void observe().then((next) => {
      if (next !== undefined) setChanges(next);
    });
  }, [observe]);
  return [changes, refresh];
}

import type { CodeFileChangeNotice, CodeRelativePath, CodeThreadView } from "@octant/contracts";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDockBarControls, useDockBarLead, useDockBarPlacement } from "../shell/dockBarControls";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantIconButton } from "../ui/base/OctantButton";
import { PanelTab, PanelTabStrip } from "../shell/PanelTabs";
import { File, ListTree } from "../ui/icons";
import { pathBasename } from "../lib/fileName";
import type { CodeFileChange } from "./CodeFileExplorer";
import { CodeFileExplorerPanel, type CodeFileExplorerPanelProps } from "./CodeFileExplorerPanel";
import { registerFilesCloseGuard } from "./filesCloseGuard";
import { UnsavedFileDialog, type UnsavedFileChoice } from "./UnsavedFileDialog";
import { noticeTouches } from "./useCodeFileChangeWatch";
import { useCodeEditorFile } from "./useCodeEditorFile";
import type { CodeController } from "./useCodeController";

const MonacoEditorPane = lazy(() =>
  import("./MonacoEditorPane").then((module) => ({ default: module.MonacoEditorPane })),
);

/** Below this width the tree and the editor take turns instead of sharing the pane. */
const NARROW_PANE_PX = 480;

interface OpenFile {
  readonly path: CodeRelativePath;
  /** A preview tab is replaced by the next single click; keeping it makes it stay. */
  readonly preview: boolean;
}

/** The live editor's own Save and Discard, handed up for a tab that closes dirty. */
interface EditorActions {
  readonly save: () => Promise<boolean>;
  readonly discard: () => void;
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
  // The checkout's listing failed: with no file open there is no tree to
  // browse and no file to choose, so the whole pane is that one state.
  const [listingFailed, setListingFailed] = useState(false);
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

  const filesRef = useRef(files);
  filesRef.current = files;
  const activeRef = useRef(active);
  activeRef.current = active;
  const dirtyPaths = useRef(new Set<string>());
  const [dirtyMarks, setDirtyMarks] = useState<ReadonlySet<string>>(new Set());
  const actions = useRef<EditorActions | undefined>(undefined);
  const [asking, setAsking] = useState<{
    readonly name: string;
    readonly answer: (choice: UnsavedFileChoice) => void;
  }>();
  const registerActions = useCallback((next: EditorActions | undefined) => {
    actions.current = next;
  }, []);
  const setDirty = useCallback((path: CodeRelativePath, dirty: boolean) => {
    if (dirtyPaths.current.has(String(path)) === dirty) return;
    if (dirty) dirtyPaths.current.add(String(path));
    else dirtyPaths.current.delete(String(path));
    setDirtyMarks(new Set(dirtyPaths.current));
  }, []);

  const removeTab = useCallback((path: CodeRelativePath) => {
    const current = filesRef.current;
    const index = current.findIndex((file) => file.path === path);
    const remaining = current.filter((file) => file.path !== path);
    dirtyPaths.current.delete(String(path));
    setDirtyMarks(new Set(dirtyPaths.current));
    setFiles(remaining);
    if (activeRef.current === path)
      setActive(remaining[Math.min(index, remaining.length - 1)]?.path);
  }, []);

  /**
   * Whether a tab may close. A file with unsaved edits is brought forward (its
   * editor owns Save), and the person chooses: Save closes on success and keeps
   * the tab, with the editor's error, when saving fails; Don't save drops the
   * edits; Cancel keeps everything.
   */
  const mayClose = useCallback(async (path: CodeRelativePath): Promise<boolean> => {
    if (!dirtyPaths.current.has(String(path))) return true;
    if (activeRef.current !== path) {
      setActive(path);
      for (let waited = 0; waited < 5000 && actions.current === undefined; waited += 25)
        await new Promise((resolve) => setTimeout(resolve, 25));
      // A reopened editor starts clean and then restores its draft, so the
      // file counts as clean only if it has not said "dirty" again by then.
      for (let waited = 0; waited < 1000 && !dirtyPaths.current.has(String(path)); waited += 25)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (!dirtyPaths.current.has(String(path))) return true;
    }
    const choice = await new Promise<UnsavedFileChoice>((answer) =>
      setAsking({ name: pathBasename(path), answer }),
    );
    setAsking(undefined);
    if (choice === "cancel") return false;
    if (choice === "save") return (await actions.current?.save()) === true;
    actions.current?.discard();
    return true;
  }, []);

  const close = useCallback(
    (path: CodeRelativePath) => {
      void mayClose(path).then((ok) => {
        if (ok) removeTab(path);
      });
    },
    [mayClose, removeTab],
  );

  useEffect(
    () =>
      registerFilesCloseGuard(async () => {
        for (const file of [...filesRef.current]) {
          if (!(await mayClose(file.path))) return false;
        }
        return true;
      }),
    [mayClose],
  );

  const keep = useCallback((path: CodeRelativePath) => open(path, true), [open]);
  const changesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(changesTimer.current), []);
  const dirtyKeeps = useCallback(
    (path: CodeRelativePath, dirty: boolean) => {
      setDirty(path, dirty);
      if (dirty) keep(path);
    },
    [keep, setDirty],
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

  // In a pane the open files are the bar's tabs, as the Browser's pages are,
  // and Refresh and the tree toggle are the bar's actions. Where nothing hosts
  // a bar (the bottom panel has no tab slot) the viewer draws its own row.
  const barLead = useDockBarLead();
  const placement = useDockBarPlacement();
  const toggleTree = useCallback(() => setTreeOpen((value) => !value), []);
  const unavailable = listingFailed && files.length === 0;
  useDockBarControls(
    placement === undefined || unavailable
      ? []
      : [
          {
            kind: "button",
            id: "files-tree",
            label: treeOpen ? "Hide file tree" : "Show file tree",
            icon: ListTree,
            pressed: treeOpen,
            onSelect: toggleTree,
          },
        ],
  );
  const tabs =
    files.length === 0 ? null : (
      <PanelTabStrip className="code-files-viewer__tabs" label="Open files" selectedId={active}>
        {files.map((file) => (
          <PanelTab
            dirty={dirtyMarks.has(String(file.path))}
            id={String(file.path)}
            key={file.path}
            label={pathBasename(file.path)}
            onClose={() => close(file.path)}
            onKeep={() => keep(file.path)}
            onSelect={() => setActive(file.path)}
            preview={file.preview}
            roving={file.path === (active ?? files[0]?.path)}
            selected={file.path === active}
            title={file.path}
          />
        ))}
      </PanelTabStrip>
    );

  return (
    <div
      className="code-files-viewer"
      data-unavailable={unavailable ? "true" : undefined}
      ref={root}
    >
      {barLead !== null ? (
        tabs === null ? null : (
          createPortal(tabs, barLead)
        )
      ) : (
        <div className="code-files-viewer__strip">
          {tabs ?? <span className="code-files-viewer__strip-fill" />}
          {placement !== undefined ? null : (
            <OctantIconButton
              aria-pressed={treeOpen}
              className="code-files-viewer__tree-toggle"
              label={treeOpen ? "Hide file tree" : "Show file tree"}
              onClick={toggleTree}
            >
              <ListTree aria-hidden="true" size={16} weight={treeOpen ? "fill" : "regular"} />
            </OctantIconButton>
          )}
        </div>
      )}
      <div className="code-files-viewer__frame" data-tree={treeOpen ? "open" : "closed"}>
        <div className="code-files-viewer__main">
          <div className="code-files-viewer__body">
            {active === undefined || props.view === undefined ? (
              <p className="code-files-viewer__empty">
                <File aria-hidden="true" size={16} />
                Choose a file to open it here.
              </p>
            ) : (
              <ActiveFile
                controller={props.controller}
                hostBridge={props.hostBridge}
                key={active}
                onDirty={(dirty) => dirtyKeeps(active, dirty)}
                onOpen={(path) => open(path, false)}
                onRegisterActions={registerActions}
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
            onUnavailableChange={setListingFailed}
            onKeepFile={(entry) => open(entry.path, true, true)}
            onOpenFile={(entry) => open(entry.path, false, true)}
            {...(active === undefined ? {} : { selectedPath: active })}
          />
        </aside>
      </div>
      {asking === undefined ? null : (
        <UnsavedFileDialog name={asking.name} onChoose={asking.answer} />
      )}
    </div>
  );
}

function ActiveFile(props: {
  readonly controller: CodeFilesViewerProps["controller"];
  readonly hostBridge: OctantHostBridge | undefined;
  readonly onDirty: (dirty: boolean) => void;
  readonly onOpen: (path: CodeRelativePath) => void;
  readonly onRegisterActions: (actions: EditorActions | undefined) => void;
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
        onRegisterActions={props.onRegisterActions}
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
              onOpenInDefaultApp: () =>
                openExternal({
                  threadId: file.threadId,
                  checkoutId: file.checkoutId,
                  fileId: file.fileId,
                  line: 1,
                  column: 1,
                  defaultApplication: true,
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

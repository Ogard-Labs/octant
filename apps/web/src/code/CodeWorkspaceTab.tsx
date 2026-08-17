import type { CodeClient, CodeFileOpenResult } from "@octant/client-runtime/code-client";
import type { WorkspaceTab } from "@octant/contracts/shell";
import type { CodeRelativePath, CodeThread } from "@octant/contracts/code";
import type { CodeRepositoryTestDefinition } from "@octant/contracts/code-test-definitions";
import { useCallback, useEffect, useState } from "react";
import { deferredCodeAdapterFor } from "./codeLeafAdapters";
import { CodeWorkspace } from "./CodeWorkspace";
import type { CodeEditorFileProjection } from "./MonacoEditorPane";
import type { CodeController } from "./useCodeController";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { CodeOverviewSurfaceKind } from "./CodeOverview";
import { nativeCodeWorkspaceApprovals } from "./codeWorkspaceApprovals";
import { noticeTouches, useCodeFileChangeWatch } from "./useCodeFileChangeWatch";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { HostId } from "@octant/contracts/host";

type CodeWorkspaceTab = Extract<WorkspaceTab, { readonly mode: "code" }>;

export default function CodeWorkspaceTab(props: {
  readonly controller: CodeController;
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly tab: CodeWorkspaceTab;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenBrowser?: () => void;
  /** Opens one changed repository file as a Code file tab, from the diff. */
  readonly onOpenFile?: (relativePath: string) => void;
  readonly onOpenSurface?: (
    kind: CodeOverviewSurfaceKind,
    options?: { readonly terminalId?: import("@octant/contracts/code").CodeTerminalId },
  ) => void;
  readonly providerGroups?: ReadonlyArray<import("@octant/domain").PickerGroup>;
  readonly canvasClient?: CanvasClient;
  readonly hostId?: HostId;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  /**
   * Opens a Code thread this workspace started, such as a fork of the one in
   * view. Absent on a surface with no tab of its own.
   */
  readonly onOpenCodeThread?: (
    threadId: import("@octant/contracts/code").CodeThreadId,
    title: string,
    projectId: import("@octant/contracts/projects").ProjectId,
  ) => void;
  /** Reaches the host's `#thread` mention surface from the Code composer. */
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}) {
  const deferredAdapter = deferredCodeAdapterFor(props.tab.kind);
  const preloadDeferredAdapter = () => {
    if (deferredAdapter !== undefined) void deferredAdapter.load().catch(() => undefined);
  };
  const approvals = nativeCodeWorkspaceApprovals(props.hostBridge, props.controller.activeView);
  const view = props.controller.activeView;
  const definitions = useCodeTestDefinitions({
    client: props.controller.client,
    enabled: props.tab.kind === "code-test" && view?.thread.id === props.tab.threadId,
    ...(view === undefined ? {} : { threadId: view.thread.id, checkoutId: view.checkout.id }),
  });
  const editorFile = useCodeEditorFile({
    client: props.controller.client,
    enabled: props.tab.kind === "code-file" && view?.thread.id === props.tab.threadId,
    ...(props.tab.kind === "code-file" ? { relativePath: props.tab.relativePath } : {}),
    ...(view === undefined
      ? {}
      : {
          threadId: view.thread.id,
          checkoutId: view.checkout.id,
          executionPolicy: view.thread.executionPolicy,
        }),
  });
  // An open file follows the checkout on its own: the explorer's watch belongs
  // to the explorer's tab, and the two are rarely on screen together.
  useCodeFileChangeWatch({
    enabled:
      props.tab.kind === "code-file" && view !== undefined && view.thread.id === props.tab.threadId,
    ...(view === undefined ? {} : { threadId: view.thread.id, checkoutId: view.checkout.id }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    onChanged: (notice) => {
      if (props.tab.kind !== "code-file") return;
      if (!noticeTouches(notice, String(props.tab.relativePath))) return;
      // Reopening restates the file's identity and revision. The editor keeps a
      // dirty buffer and reports the external change as a conflict rather than
      // overwriting what the user typed.
      editorFile.refresh();
    },
  });
  const projections = {
    ...(editorFile.file === undefined ? {} : { file: editorFile.file }),
    ...(definitions === undefined ? {} : { tests: { definitions } }),
  };
  return (
    <div
      data-code-tab-kind={props.tab.kind}
      {...(deferredAdapter === undefined
        ? {}
        : {
            "data-deferred-code-adapter": deferredAdapter.id,
            onFocus: preloadDeferredAdapter,
            onPointerEnter: preloadDeferredAdapter,
          })}
    >
      <CodeWorkspace
        {...(props.agentRunClient === undefined ? {} : { agentRunClient: props.agentRunClient })}
        {...(props.agentRunSettingsClient === undefined
          ? {}
          : { agentRunSettingsClient: props.agentRunSettingsClient })}
        {...(props.appleToolchainClient === undefined
          ? {}
          : { appleToolchainClient: props.appleToolchainClient })}
        {...(approvals === undefined ? {} : { approvals })}
        client={props.controller.client}
        controller={props.controller}
        {...(props.onOpenBrowser === undefined ? {} : { onOpenBrowser: props.onOpenBrowser })}
        {...(props.onOpenFile === undefined ? {} : { onOpenFile: props.onOpenFile })}
        {...(props.onOpenSurface === undefined ? {} : { onOpenSurface: props.onOpenSurface })}
        {...(props.providerGroups === undefined ? {} : { providerGroups: props.providerGroups })}
        {...(props.canvasClient === undefined ? {} : { canvasClient: props.canvasClient })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
        {...(props.onOpenCanvas === undefined ? {} : { onOpenCanvas: props.onOpenCanvas })}
        {...(props.onOpenCodeThread === undefined
          ? {}
          : { onOpenCodeThread: props.onOpenCodeThread })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        onRequestFileRefresh={editorFile.refresh}
        {...(editorFile.file === undefined && definitions === undefined ? {} : { projections })}
        tab={props.tab}
      />
    </div>
  );
}

/**
 * Load the host's repository test definitions for the thread's checkout.
 *
 * The definitions are authoritative and the renderer never invents one, so
 * until the host has answered there is no projection to hand the pane — the
 * workspace says the tests are unavailable rather than showing an empty picker
 * that looks like a repository without tests. Loading is scoped to the Tests
 * tab because discovery reads the checkout, and no other surface needs it.
 */
function useCodeTestDefinitions(options: {
  readonly client: CodeClient;
  readonly enabled: boolean;
  readonly threadId?: NonNullable<CodeController["activeView"]>["thread"]["id"];
  readonly checkoutId?: NonNullable<CodeController["activeView"]>["checkout"]["id"];
}): ReadonlyArray<CodeRepositoryTestDefinition> | undefined {
  const [definitions, setDefinitions] = useState<ReadonlyArray<CodeRepositoryTestDefinition>>();
  const { client, enabled, threadId, checkoutId } = options;

  useEffect(() => {
    const listTests = client.listTests?.bind(client);
    if (!enabled || listTests === undefined || threadId === undefined || checkoutId === undefined) {
      setDefinitions(undefined);
      return;
    }
    let active = true;
    void listTests(threadId, checkoutId)
      .then((listing) => {
        if (active) setDefinitions(listing.definitions);
      })
      .catch(() => {
        if (active) setDefinitions(undefined);
      });
    return () => void (active = false);
  }, [checkoutId, client, enabled, threadId]);

  return definitions;
}

/**
 * Open the tab's file through the host and project the strict open envelope
 * for the editor pane.
 *
 * The answer is authoritative and the renderer never invents content: until
 * the host has answered — or when it refuses — there is no projection and the
 * workspace says the file is unavailable rather than showing an empty editor
 * that looks like an empty file. Loading is scoped to code-file tabs because
 * opening reads the checkout, and no other surface needs it.
 *
 * `refresh` re-runs that same authorized open, which is the only way to reach
 * fresh bytes and fresh metadata: the host releases a file's previous staging
 * when it re-opens it, so re-reading the old reference would serve exactly the
 * revision the editor is trying to leave behind. Each run blanks the projection
 * first and cancels the answer of the run it replaced, so a refresh that
 * overtakes an in-flight open — or fails outright — leaves the workspace saying
 * the file is unavailable instead of showing the superseded content.
 */
function useCodeEditorFile(options: {
  readonly client: CodeClient;
  readonly enabled: boolean;
  readonly relativePath?: CodeRelativePath;
  readonly threadId?: NonNullable<CodeController["activeView"]>["thread"]["id"];
  readonly checkoutId?: NonNullable<CodeController["activeView"]>["checkout"]["id"];
  readonly executionPolicy?: CodeThread["executionPolicy"];
}): {
  readonly file: CodeEditorFileProjection | undefined;
  readonly refresh: () => void;
} {
  const [file, setFile] = useState<CodeEditorFileProjection>();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const { client, enabled, relativePath, threadId, checkoutId, executionPolicy } = options;
  const refresh = useCallback(() => setRefreshGeneration((generation) => generation + 1), []);

  useEffect(() => {
    if (
      !enabled ||
      relativePath === undefined ||
      threadId === undefined ||
      checkoutId === undefined ||
      executionPolicy === undefined
    ) {
      setFile(undefined);
      return;
    }
    let active = true;
    setFile(undefined);
    void client
      .openFile(threadId, checkoutId, relativePath)
      .then((result) => {
        if (active) {
          setFile(
            editorFileProjection(
              { checkoutId, executionPolicy, path: relativePath, threadId },
              result,
            ),
          );
        }
      })
      .catch(() => {
        if (active) setFile(undefined);
      });
    return () => void (active = false);
  }, [checkoutId, client, enabled, executionPolicy, refreshGeneration, relativePath, threadId]);

  return { file, refresh };
}

function editorFileProjection(
  scope: {
    readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
    readonly executionPolicy: CodeThread["executionPolicy"];
    readonly path: CodeRelativePath;
    readonly threadId: NonNullable<CodeController["activeView"]>["thread"]["id"];
  },
  result: CodeFileOpenResult,
): CodeEditorFileProjection {
  const fields = { ...scope, fileId: result.fileId, language: editorLanguageFor(scope.path) };
  switch (result.status) {
    case "editable":
      return { ...fields, state: "available", content: result.content, metadata: result.metadata };
    case "read-only":
      return { ...fields, state: "read-only", metadata: result.metadata, reason: result.reason };
    case "interrupted":
      return { ...fields, state: "unavailable", reason: "interrupted" };
    case "failed":
      return { ...fields, state: "unavailable", reason: result.failure.code };
  }
}

const EDITOR_LANGUAGES: Readonly<Record<string, string>> = {
  c: "c",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function editorLanguageFor(path: string): string {
  const separator = path.lastIndexOf(".");
  if (separator <= 0 || separator === path.length - 1) return "plaintext";
  return EDITOR_LANGUAGES[path.slice(separator + 1).toLowerCase()] ?? "plaintext";
}

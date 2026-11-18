import type { ProjectMemoryProposalClient } from "../projects/ProjectMemoryProposalPrompt";
import type { CodeReviewFileRequest } from "./codeReviewNavigation";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { AutoReview } from "./autoReview";
import type { WorkspaceTab } from "@octant/contracts/shell";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import type { CodeRepositoryTestDefinition } from "@octant/contracts/code-test-definitions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deferredCodeAdapterFor } from "./codeLeafAdapters";
import { useCodeEditorFile } from "./useCodeEditorFile";
import { CodeWorkspace, type CodeWorkspaceProps } from "./CodeWorkspace";
import type { CodeEditorFileProjection } from "./MonacoEditorPane";
import type { CodeController } from "./useCodeController";
import type { CodeThreadControllers } from "./codeThreadControllers";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { CodeOverviewSurfaceKind } from "./CodeOverview";
import { nativeCodeWorkspaceApprovals } from "./codeWorkspaceApprovals";
import { noticeTouches, useCodeFileChangeWatch } from "./useCodeFileChangeWatch";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { AutomationClient } from "@octant/client-runtime";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView } from "@octant/contracts";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import type { HostId } from "@octant/contracts/host";

type CodeWorkspaceTab = Extract<WorkspaceTab, { readonly mode: "code" }>;

export default function CodeWorkspaceTab(props: {
  readonly controller: CodeController;
  readonly revealOperationId?: CodeWorkspaceProps["revealOperationId"];
  readonly onTurnRevealed?: () => void;
  readonly holdAccessNotice?: CodeThreadControllers["holdAccessNotice"];
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly extensionClient?: ExtensionClient;
  readonly automationClient?: AutomationClient;
  readonly memoryProposalClient?: ProjectMemoryProposalClient;
  readonly tab: CodeWorkspaceTab;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenBrowser?: () => void;
  readonly onPinTerminal?: CodeWorkspaceProps["onPinTerminal"];
  /** Opens one changed repository file as a Code file tab, from the diff. */
  readonly onOpenFile?: (relativePath: string) => void;
  readonly onOpenReview?: (request?: CodeReviewFileRequest) => void;
  readonly onOpenSurface?: (
    kind: CodeOverviewSurfaceKind,
    options?: { readonly terminalId?: import("@octant/contracts/code").CodeTerminalId },
  ) => void;
  readonly providerGroups?: ReadonlyArray<import("@octant/domain").PickerGroup>;
  readonly harnessAutoReviewSupported?: boolean;
  readonly strictDefault?: CodeWorkspaceProps["strictDefault"];
  readonly projectExtraFolders?: CodeWorkspaceProps["projectExtraFolders"];
  /** Who answers the thread's prompts at Auto, or why nobody can. */
  readonly autoReview?: AutoReview;
  readonly canvasClient?: CanvasClient;
  readonly imageGenerationClient?: ImageGenerationClient;
  readonly imageGenerationProfiles?: ReadonlyArray<ImageGenerationProfileView>;
  readonly browserAutomationClient?: BrowserAutomationClient;
  readonly onOpenSettings?: () => void;
  readonly onOpenImageSettings?: () => void;
  readonly hostId?: HostId;
  readonly onOpenCanvas?: (card: CanvasThreadReferenceCard) => void;
  readonly onCanvasReferencesObserved?: CodeWorkspaceProps["onCanvasReferencesObserved"];
  readonly onNewThreadInProject?: CodeWorkspaceProps["onNewThreadInProject"];
  readonly coordinatorProposals?: CodeWorkspaceProps["coordinatorProposals"];
  readonly coordinatorWorkerAsks?: CodeWorkspaceProps["coordinatorWorkerAsks"];
  readonly coordinatorWorkers?: CodeWorkspaceProps["coordinatorWorkers"];
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
  const view = props.controller.activeView;
  const approvals = useMemo(
    () => nativeCodeWorkspaceApprovals(props.hostBridge, view),
    [props.hostBridge, view?.thread.id, view?.thread.projectId],
  );
  const definitions = useCodeTestDefinitions({
    client: props.controller.client,
    enabled: props.tab.kind === "code-test" && view?.thread.id === props.tab.threadId,
    ...(view === undefined ? {} : { threadId: view.thread.id, checkoutId: view.checkout.id }),
  });
  const testResult = useCodeTestResult({
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
    ...(definitions === undefined
      ? {}
      : {
          tests: {
            definitions,
            ...(testResult === undefined ? {} : { result: testResult }),
          },
        }),
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
        {...(props.revealOperationId === undefined
          ? {}
          : { revealOperationId: props.revealOperationId })}
        {...(props.onTurnRevealed === undefined ? {} : { onTurnRevealed: props.onTurnRevealed })}
        {...(props.appleToolchainClient === undefined
          ? {}
          : { appleToolchainClient: props.appleToolchainClient })}
        {...(props.extensionClient === undefined ? {} : { extensionClient: props.extensionClient })}
        {...(props.memoryProposalClient === undefined
          ? {}
          : { memoryProposalClient: props.memoryProposalClient })}
        {...(props.automationClient === undefined
          ? {}
          : { automationClient: props.automationClient })}
        {...(approvals === undefined ? {} : { approvals })}
        {...(props.coordinatorProposals === undefined
          ? {}
          : { coordinatorProposals: props.coordinatorProposals })}
        {...(props.coordinatorWorkerAsks === undefined
          ? {}
          : { coordinatorWorkerAsks: props.coordinatorWorkerAsks })}
        {...(props.coordinatorWorkers === undefined
          ? {}
          : { coordinatorWorkers: props.coordinatorWorkers })}
        client={props.controller.client}
        controller={props.controller}
        {...(props.holdAccessNotice === undefined
          ? {}
          : { holdAccessNotice: props.holdAccessNotice })}
        {...(props.onOpenBrowser === undefined ? {} : { onOpenBrowser: props.onOpenBrowser })}
        {...(props.onPinTerminal === undefined ? {} : { onPinTerminal: props.onPinTerminal })}
        {...(props.onOpenFile === undefined ? {} : { onOpenFile: props.onOpenFile })}
        {...(props.onOpenReview === undefined ? {} : { onOpenReview: props.onOpenReview })}
        {...(props.onOpenSurface === undefined ? {} : { onOpenSurface: props.onOpenSurface })}
        {...(props.providerGroups === undefined ? {} : { providerGroups: props.providerGroups })}
        {...(props.harnessAutoReviewSupported === undefined
          ? {}
          : { harnessAutoReviewSupported: props.harnessAutoReviewSupported })}
        {...(props.strictDefault === undefined ? {} : { strictDefault: props.strictDefault })}
        {...(props.autoReview === undefined ? {} : { autoReview: props.autoReview })}
        {...(props.projectExtraFolders === undefined
          ? {}
          : { projectExtraFolders: props.projectExtraFolders })}
        {...(props.canvasClient === undefined ? {} : { canvasClient: props.canvasClient })}
        {...(props.imageGenerationClient === undefined
          ? {}
          : { imageGenerationClient: props.imageGenerationClient })}
        {...(props.imageGenerationProfiles === undefined
          ? {}
          : { imageGenerationProfiles: props.imageGenerationProfiles })}
        {...(props.browserAutomationClient === undefined
          ? {}
          : { browserAutomationClient: props.browserAutomationClient })}
        {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })}
        {...(props.onOpenImageSettings === undefined
          ? {}
          : { onOpenImageSettings: props.onOpenImageSettings })}
        {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
        {...(props.onOpenCanvas === undefined ? {} : { onOpenCanvas: props.onOpenCanvas })}
        {...(props.onCanvasReferencesObserved === undefined
          ? {}
          : { onCanvasReferencesObserved: props.onCanvasReferencesObserved })}
        {...(props.onOpenCodeThread === undefined
          ? {}
          : { onOpenCodeThread: props.onOpenCodeThread })}
        {...(props.onNewThreadInProject === undefined
          ? {}
          : { onNewThreadInProject: props.onNewThreadInProject })}
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

type RepositoryTestResult = Extract<
  CodeOperationResult,
  { readonly kind: "repository-test-state" }
>;

/**
 * The newest repository test result the host holds for the tab's checkout.
 *
 * A run's result is journaled by the host, so reopening the Tests tab shows the
 * run that already happened instead of "Not run". The renderer never remembers
 * one itself: no answer means no result to show. Loading is scoped to the Tests
 * tab because the status belongs to that surface alone.
 */
function useCodeTestResult(options: {
  readonly client: CodeClient;
  readonly enabled: boolean;
  readonly threadId?: NonNullable<CodeController["activeView"]>["thread"]["id"];
  readonly checkoutId?: NonNullable<CodeController["activeView"]>["checkout"]["id"];
}): RepositoryTestResult | undefined {
  const [cached, setCached] = useState<{
    readonly threadId: NonNullable<CodeController["activeView"]>["thread"]["id"];
    readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
    readonly result?: RepositoryTestResult;
  }>();
  const { client, enabled, threadId, checkoutId } = options;

  useEffect(() => {
    const readTestStatus = client.readTestStatus?.bind(client);
    if (
      !enabled ||
      readTestStatus === undefined ||
      threadId === undefined ||
      checkoutId === undefined
    ) {
      setCached(undefined);
      return;
    }
    let active = true;
    void readTestStatus(threadId, checkoutId)
      .then((status) => {
        if (active)
          setCached({
            threadId,
            checkoutId,
            ...(status.result === undefined ? {} : { result: status.result }),
          });
      })
      .catch(() => {
        if (active) setCached({ threadId, checkoutId });
      });
    return () => void (active = false);
  }, [checkoutId, client, enabled, threadId]);

  // A result is only this checkout's result. When the scope moves, the previous
  // answer is withheld for the render before the new fetch lands rather than
  // shown under the new checkout's name.
  if (
    !enabled ||
    cached === undefined ||
    cached.threadId !== threadId ||
    cached.checkoutId !== checkoutId
  ) {
    return undefined;
  }
  return cached.result;
}

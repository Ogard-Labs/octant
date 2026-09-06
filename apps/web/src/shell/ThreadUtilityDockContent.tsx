import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import type { NativeHarnessFollowUpCreation } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import type { ShipClient } from "@octant/client-runtime/ship-client";
import type { WorkFileListingClient } from "@octant/client-runtime/work-file-listing-client";
import type { CodeCheckoutId, CodeRelativePath } from "@octant/contracts/code";
import type { ChatThreadId } from "@octant/contracts/chat";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import {
  decodeBrowserContextId,
  decodeBrowserThreadId,
  decodeCodeThreadId,
  decodeMentionableThreadId,
  decodeWorkThreadId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type SideChatSidecar,
  type WorkspaceTab,
} from "@octant/contracts";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { lazy, Suspense } from "react";
import { AgentRunHierarchy } from "../agents/AgentRunHierarchy";
import { NativeHarnessSessionCard } from "../harness/NativeHarnessSessionCard";
import { BrowserWorkspace } from "../browser/BrowserWorkspace";
import { SideChatWorkspaceTab } from "../chat/SideChatWorkspaceTab";
import type { ChatReadCursorStore } from "../chat/useChatController";
import type { CodeController } from "../code/useCodeController";
import { ThreadPlanProvider } from "../plan/ThreadPlanContext";
import { ThreadPlanPanel } from "../plan/ThreadPlanPanel";
import { ShipPanel } from "../ship/ShipPanel";
import type { PickerGroup } from "@octant/domain";
import type { ProviderController } from "../providers/useProviderController";
import { WorkFilesPanel, type WorkFileOpenRequest } from "../work/WorkFilesPanel";
import { DockCanvasTool } from "./DockCanvasTool";
import { DockDocumentTool } from "./DockDocumentTool";
import type { OctantHostBridge } from "./hostBridge";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";
import { ShellState } from "./ShellState";

const CodeWorkspaceTab = lazy(() => import("../code/CodeWorkspaceTab"));
const CodeFileExplorerPanel = lazy(() =>
  import("../code/CodeFileExplorerPanel").then((module) => ({
    default: module.CodeFileExplorerPanel,
  })),
);
const DockReviewTool = lazy(() =>
  import("./DockReviewTool").then((module) => ({
    default: module.DockReviewTool,
  })),
);

const dockTabIds = {
  browser: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000001"),
  "side-chat": decodeWorkspaceTabId("90000000-0000-4000-8000-000000000002"),
  terminal: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000004"),
  tests: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000005"),
  "ios-simulator": decodeWorkspaceTabId("90000000-0000-4000-8000-000000000006"),
} as const;

export interface ThreadUtilityDockSubject {
  readonly checkoutId?: CodeCheckoutId;
  readonly mode: OctantMode;
  readonly projectId?: ProjectId;
  readonly threadId: string;
}

export interface ThreadUtilityDockContentProps {
  readonly agentRunClient?: AgentRunClient;
  readonly agentRunSettingsClient?: AgentRunSettingsClient;
  readonly nativeHarnessClient?: NativeHarnessClient;
  /** A confirmed follow-up's thread exists; open it with the prompt ready to send. */
  readonly onFollowUpCreated?: (input: {
    readonly created: NativeHarnessFollowUpCreation;
    readonly prompt: string;
  }) => void;
  readonly appleProjectPath?: string;
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly browserAutomationClient?: BrowserAutomationClient;
  readonly browserContextId?: string;
  readonly canvasClient?: CanvasClient;
  readonly chatClient: ChatClient;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly codeController?: CodeController;
  readonly codeProviderGroups?: ReadonlyArray<PickerGroup>;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenFile: (relativePath: CodeRelativePath) => void;
  readonly onBrowserContextCreated?: (contextId: string) => void;
  readonly onSidecarOpened: (sidecar: SideChatSidecar) => void;
  readonly planClient?: PlanClient;
  readonly providerController?: ProviderController;
  readonly serverUrl?: string;
  readonly shipClient?: ShipClient;
  readonly workFileListingClient?: WorkFileListingClient;
  /** Opens one listed Work file in the preview surface. */
  readonly onOpenWorkFile?: (request: WorkFileOpenRequest) => void;
  readonly sidecarThreadId?: ChatThreadId;
  readonly subject: ThreadUtilityDockSubject;
  readonly surface: RightUtilityDockSurfaceId;
  readonly utilityTabId?: string;
  readonly windowCapability?: string;
  /** Checkout-relative path of the document the thread most recently wrote. */
  readonly writtenDocumentPath?: string;
  /** The Canvas the thread most recently wrote or handed off. */
  readonly writtenCanvasId?: string;
}

export function ThreadUtilityDockContent(props: ThreadUtilityDockContentProps) {
  if (props.surface === "agents") {
    if (props.agentRunClient === undefined) {
      return unavailable("Agents", "This thread has no AgentRun service available.");
    }
    return (
      <>
        {props.nativeHarnessClient === undefined ? null : (
          <NativeHarnessSessionCard
            client={props.nativeHarnessClient}
            onFollowUpActivated={({ preview, created }) =>
              props.onFollowUpCreated?.({ created, prompt: preview.suggestion.prompt })
            }
            threadId={props.subject.threadId}
          />
        )}
        <AgentRunHierarchy
          allowCreation
          client={props.agentRunClient}
          parentThreadId={decodeAgentRunParentThreadId(props.subject.threadId)}
          {...(props.agentRunSettingsClient === undefined
            ? {}
            : { settingsClient: props.agentRunSettingsClient })}
        />
      </>
    );
  }

  if (props.surface === "side-chat") {
    const tab: Extract<WorkspaceTab, { readonly kind: "side-chat" }> = {
      kind: "side-chat",
      id: dockTabIds["side-chat"],
      mode: props.subject.mode,
      title: "Side Chat",
      sourceThreadId: decodeMentionableThreadId(props.subject.threadId),
      ...(props.sidecarThreadId === undefined ? {} : { sidecarThreadId: props.sidecarThreadId }),
    };
    return (
      <SideChatWorkspaceTab
        chatClient={props.chatClient}
        chatReadCursorStore={props.chatReadCursorStore}
        onSidecarOpened={props.onSidecarOpened}
        {...(props.providerController === undefined
          ? {}
          : { providerController: props.providerController })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        tab={tab}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    );
  }

  if (props.surface === "browser") {
    if (props.subject.mode === "chat" || props.browserAutomationClient === undefined) {
      return unavailable("Browser", "This thread has no Browser utility available.");
    }
    const tab: Extract<WorkspaceTab, { readonly kind: "browser" }> = {
      kind: "browser",
      id: workspaceDockTabId(props.utilityTabId, "browser"),
      mode: props.subject.mode,
      title: "Browser",
      threadId: decodeBrowserThreadId(props.subject.threadId),
      ...(props.browserContextId === undefined
        ? {}
        : { contextId: decodeBrowserContextId(props.browserContextId) }),
    };
    return (
      <BrowserWorkspace
        client={props.browserAutomationClient}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        {...(props.onBrowserContextCreated === undefined
          ? {}
          : { onContextCreated: props.onBrowserContextCreated })}
        startFresh={props.utilityTabId !== undefined && props.utilityTabId !== "browser"}
        tab={tab}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    );
  }

  if (props.surface === "files") {
    if (props.subject.mode === "work") {
      return (
        <WorkFilesPanel
          {...(props.workFileListingClient === undefined
            ? {}
            : { client: props.workFileListingClient })}
          {...(props.subject.projectId === undefined ? {} : { projectId: props.subject.projectId })}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          threadId={decodeWorkThreadId(props.subject.threadId)}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
        />
      );
    }
    if (props.subject.mode !== "code") {
      return unavailable(
        "Files",
        "Files are not available for a Chat thread, which binds no folder.",
      );
    }
    return (
      <Suspense
        fallback={<ShellState message="Loading files." state="loading" title="Loading Files" />}
      >
        <CodeFileExplorerPanel
          {...(props.subject.checkoutId === undefined
            ? {}
            : { checkoutId: props.subject.checkoutId })}
          onOpenFile={(entry) => props.onOpenFile(entry.path)}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          threadId={decodeCodeThreadId(props.subject.threadId)}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
        />
      </Suspense>
    );
  }

  if (props.surface === "document") {
    if (props.subject.mode !== "code" || props.codeController === undefined) {
      return unavailable("Document", "Documents are not yet available for this thread type.");
    }
    if (props.writtenDocumentPath === undefined) {
      return unavailable("Document", "This thread has not written a document yet.");
    }
    return (
      <DockDocumentTool
        {...(props.subject.checkoutId === undefined
          ? {}
          : { checkoutId: props.subject.checkoutId })}
        client={props.codeController.client}
        path={props.writtenDocumentPath}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        threadId={decodeCodeThreadId(props.subject.threadId)}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    );
  }

  if (props.surface === "plan") {
    return (
      <ThreadPlanProvider
        {...(props.planClient === undefined ? {} : { client: props.planClient })}
        threadId={props.subject.threadId}
      >
        <ThreadPlanPanel artifactOnly />
      </ThreadPlanProvider>
    );
  }

  if (props.surface === "delivery") {
    if (props.shipClient === undefined) {
      return unavailable("Delivery", "This thread has no Delivery target available.");
    }
    return <ShipPanel client={props.shipClient} threadId={props.subject.threadId} />;
  }

  if (props.surface === "canvas") {
    return (
      <DockCanvasTool
        {...(props.canvasClient === undefined ? {} : { client: props.canvasClient })}
        mode={props.subject.mode}
        {...(props.subject.projectId === undefined ? {} : { projectId: props.subject.projectId })}
        {...(props.writtenCanvasId === undefined
          ? {}
          : { preferredCanvasId: props.writtenCanvasId })}
        threadId={props.subject.threadId}
      />
    );
  }

  if (props.surface === "review") {
    if (props.subject.mode !== "code") {
      return unavailable("Review", "Review is not yet available for this thread type.");
    }
    return (
      <Suspense
        fallback={<ShellState message="Loading review." state="loading" title="Loading Review" />}
      >
        <DockReviewTool
          {...(props.codeController === undefined ? {} : { controller: props.codeController })}
          threadId={decodeCodeThreadId(props.subject.threadId)}
          {...(props.subject.checkoutId === undefined
            ? {}
            : { checkoutId: props.subject.checkoutId })}
          {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
          onOpenFile={props.onOpenFile}
          {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
          {...(props.windowCapability === undefined
            ? {}
            : { windowCapability: props.windowCapability })}
        />
      </Suspense>
    );
  }

  if (
    props.surface !== "terminal" &&
    props.surface !== "tests" &&
    props.surface !== "ios-simulator"
  ) {
    return null;
  }
  const controller = props.codeController;
  const threadId = decodeCodeThreadId(props.subject.threadId);
  if (
    props.subject.mode !== "code" ||
    controller?.activeView === undefined ||
    String(controller.activeView.thread.id) !== String(threadId)
  ) {
    return unavailable(
      surfaceLabel(props.surface),
      "This Code thread is still loading its utility state.",
    );
  }
  if (
    props.surface === "ios-simulator" &&
    (props.appleToolchainClient === undefined || props.appleProjectPath === undefined)
  ) {
    return unavailable(
      "iOS Simulator",
      "This thread has no discovered Xcode project or Apple toolchain connection.",
    );
  }
  const tab = codeUtilityTab(props.surface, threadId, props.appleProjectPath, props.utilityTabId);
  return (
    <Suspense
      fallback={
        <ShellState
          message={`Loading ${surfaceLabel(props.surface).toLocaleLowerCase()}.`}
          state="loading"
          title={`Loading ${surfaceLabel(props.surface)}`}
        />
      }
    >
      <CodeWorkspaceTab
        {...(props.appleToolchainClient === undefined
          ? {}
          : { appleToolchainClient: props.appleToolchainClient })}
        controller={controller}
        {...(props.codeProviderGroups === undefined
          ? {}
          : { providerGroups: props.codeProviderGroups })}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        tab={tab}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    </Suspense>
  );
}

function codeUtilityTab(
  surface: "terminal" | "tests" | "ios-simulator",
  threadId: ReturnType<typeof decodeCodeThreadId>,
  appleProjectPath?: string,
  utilityTabId?: string,
): Extract<WorkspaceTab, { readonly mode: "code" }> {
  const title = surfaceLabel(surface);
  if (surface === "terminal") {
    return {
      kind: "code-terminal",
      id: workspaceDockTabId(utilityTabId, "terminal"),
      mode: "code",
      threadId,
      title,
    };
  }
  if (surface === "ios-simulator") {
    if (appleProjectPath === undefined) throw new Error("Expected an Apple project path.");
    const tab = decodeWorkspaceTab({
      kind: "apple-workbench",
      id: dockTabIds["ios-simulator"],
      mode: "code",
      threadId,
      title,
      projectPath: appleProjectPath,
    });
    if (tab.kind !== "apple-workbench") throw new Error("Expected an Apple workbench tab.");
    return tab;
  }
  return { kind: "code-test", id: dockTabIds.tests, mode: "code", threadId, title };
}

function workspaceDockTabId(
  utilityTabId: string | undefined,
  surface: "browser" | "terminal",
): ReturnType<typeof decodeWorkspaceTabId> {
  if (utilityTabId !== undefined && utilityTabId !== surface) {
    return decodeWorkspaceTabId(utilityTabId);
  }
  return dockTabIds[surface];
}

function surfaceLabel(surface: "terminal" | "tests" | "ios-simulator"): string {
  if (surface === "terminal") return "Terminal";
  if (surface === "ios-simulator") return "iOS Simulator";
  return "Tests";
}

function unavailable(title: string, message: string) {
  return <ShellState message={message} state="neutral" title={`${title} is unavailable`} />;
}

import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeCheckoutId, CodeRelativePath } from "@octant/contracts/code";
import type { ChatThreadId } from "@octant/contracts/chat";
import type { OctantMode } from "@octant/contracts/modes";
import {
  decodeBrowserThreadId,
  decodeCodeThreadId,
  decodeMentionableThreadId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type SideChatSidecar,
  type WorkspaceTab,
} from "@octant/contracts";
import { lazy, Suspense } from "react";
import { BrowserWorkspace } from "../browser/BrowserWorkspace";
import { SideChatWorkspaceTab } from "../chat/SideChatWorkspaceTab";
import type { ChatReadCursorStore } from "../chat/useChatController";
import { CodeFileExplorerPanel } from "../code/CodeFileExplorerPanel";
import type { CodeController } from "../code/useCodeController";
import type { PickerGroup } from "@octant/domain";
import type { ProviderController } from "../providers/useProviderController";
import type { OctantHostBridge } from "./hostBridge";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";
import { ShellState } from "./ShellState";

const CodeWorkspaceTab = lazy(() => import("../code/CodeWorkspaceTab"));

const dockTabIds = {
  browser: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000001"),
  "side-chat": decodeWorkspaceTabId("90000000-0000-4000-8000-000000000002"),
  changes: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000003"),
  terminal: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000004"),
  tests: decodeWorkspaceTabId("90000000-0000-4000-8000-000000000005"),
  "ios-simulator": decodeWorkspaceTabId("90000000-0000-4000-8000-000000000006"),
} as const;

export interface ThreadUtilityDockSubject {
  readonly checkoutId?: CodeCheckoutId;
  readonly mode: OctantMode;
  readonly threadId: string;
}

export interface ThreadUtilityDockContentProps {
  readonly appleProjectPath?: string;
  readonly appleToolchainClient?: AppleToolchainClient;
  readonly browserAutomationClient?: BrowserAutomationClient;
  readonly chatClient: ChatClient;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly codeController?: CodeController;
  readonly codeProviderGroups?: ReadonlyArray<PickerGroup>;
  readonly hostBridge?: OctantHostBridge;
  readonly onOpenFile: (relativePath: CodeRelativePath) => void;
  readonly onSidecarOpened: (sidecar: SideChatSidecar) => void;
  readonly providerController?: ProviderController;
  readonly serverUrl?: string;
  readonly sidecarThreadId?: ChatThreadId;
  readonly subject: ThreadUtilityDockSubject;
  readonly surface: RightUtilityDockSurfaceId;
  readonly windowCapability?: string;
}

export function ThreadUtilityDockContent(props: ThreadUtilityDockContentProps) {
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
      id: dockTabIds.browser,
      mode: props.subject.mode,
      title: "Browser",
      threadId: decodeBrowserThreadId(props.subject.threadId),
    };
    return (
      <BrowserWorkspace
        client={props.browserAutomationClient}
        {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
        {...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl })}
        tab={tab}
        {...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability })}
      />
    );
  }

  if (props.surface === "files") {
    if (props.subject.mode !== "code") {
      return unavailable("Files", "Files are not yet available for this thread type.");
    }
    return (
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
    );
  }

  if (
    props.surface !== "changes" &&
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
  const tab = codeUtilityTab(props.surface, threadId, props.appleProjectPath);
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
  surface: "changes" | "terminal" | "tests" | "ios-simulator",
  threadId: ReturnType<typeof decodeCodeThreadId>,
  appleProjectPath?: string,
): Extract<WorkspaceTab, { readonly mode: "code" }> {
  const title = surfaceLabel(surface);
  if (surface === "changes") {
    return { kind: "code-diff", id: dockTabIds.changes, mode: "code", threadId, title };
  }
  if (surface === "terminal") {
    return { kind: "code-terminal", id: dockTabIds.terminal, mode: "code", threadId, title };
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

function surfaceLabel(surface: "changes" | "terminal" | "tests" | "ios-simulator"): string {
  if (surface === "changes") return "Changes";
  if (surface === "terminal") return "Terminal";
  if (surface === "ios-simulator") return "iOS Simulator";
  return "Tests";
}

function unavailable(title: string, message: string) {
  return <ShellState message={message} state="neutral" title={`${title} is unavailable`} />;
}

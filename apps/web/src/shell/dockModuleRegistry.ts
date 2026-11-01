import { createElement, lazy, type ComponentType } from "react";
import type { ThreadUtilityDockContentProps } from "./dockModuleContext";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/** Modules receive only their declared inputs; they cannot discover another tool's clients in props. */
function inputs<K extends keyof ThreadUtilityDockContentProps>(
  context: ThreadUtilityDockContentProps,
  keys: ReadonlyArray<K>,
): Pick<ThreadUtilityDockContentProps, K> {
  return Object.fromEntries(
    keys.filter((key) => context[key] !== undefined).map((key) => [key, context[key]]),
  ) as Pick<ThreadUtilityDockContentProps, K>;
}

const AgentsModule = lazy(() => import("../dockModules/AgentsModule"));
const SideChatModule = lazy(() => import("../dockModules/SideChatModule"));
const BrowserModule = lazy(() => import("../dockModules/BrowserModule"));
const FilesModule = lazy(() => import("../dockModules/FilesModule"));
const DocumentModule = lazy(() => import("../dockModules/DocumentModule"));
const PlanModule = lazy(() => import("../dockModules/PlanModule"));
const DeliveryModule = lazy(() => import("../dockModules/DeliveryModule"));
const CanvasModule = lazy(() => import("../dockModules/CanvasModule"));
const ReviewModule = lazy(() => import("../dockModules/ReviewModule"));
const ProjectPullRequestsModule = lazy(() => import("../dockModules/ProjectPullRequestsModule"));
const TerminalModule = lazy(() => import("../dockModules/TerminalModule"));
const TestsModule = lazy(() => import("../dockModules/TestsModule"));
const SimulatorModule = lazy(() => import("../dockModules/SimulatorModule"));
const AndroidEmulatorModule = lazy(() => import("../dockModules/AndroidEmulatorModule"));
const DesktopModule = lazy(() => import("../dockModules/DesktopModule"));
const RunDebugModule = lazy(() => import("../dockModules/RunDebugModule"));
const EnvironmentModule = lazy(() => import("../dockModules/EnvironmentModule"));

/**
 * What each tool reads, declared once. A module gets exactly these props, and
 * the shell hands the thread's own controller or view to the dock only while a
 * tool that declares it is on screen (`dockToolReads`), so a tool that shows
 * nothing of a streaming turn sits still through it.
 */
export const dockModuleInputs = {
  agents: [
    "agentRunClient",
    "agentRunSettingsClient",
    "nativeHarnessClient",
    "onAgentViewRequestHandled",
    "requestedAgentView",
    "onReviewAgentChanges",
    "subject",
  ],
  "side-chat": [
    "chatClient",
    "chatReadCursorStore",
    "onSidecarOpened",
    "providerController",
    "serverUrl",
    "sidecarThreadId",
    "subject",
    "windowCapability",
  ],
  browser: [
    "browserAutomationClient",
    "browserContextId",
    "hostBridge",
    "onBrowserContextCreated",
    "serverUrl",
    "subject",
    "utilityTabId",
    "windowCapability",
  ],
  files: [
    "onOpenFile",
    "projectExtraFolders",
    "serverUrl",
    "subject",
    "windowCapability",
    "workFileListingClient",
  ],
  document: ["codeClient", "serverUrl", "subject", "windowCapability", "writtenDocumentPath"],
  plan: ["planClient", "subject"],
  delivery: ["shipClient", "subject"],
  canvas: [
    "canvasClient",
    "canvasRevision",
    "serverUrl",
    "subject",
    "windowCapability",
    "writtenCanvasId",
  ],
  review: [
    "agentRunClient",
    "requestedAgentReview",
    "onAgentReviewBack",
    "codeClient",
    "codeDiffLayout",
    "codeThreadView",
    "hostBridge",
    "onOpenFile",
    "serverUrl",
    "subject",
    "windowCapability",
  ],
  "pull-requests": [
    "codeClient",
    "onSelectProjectPullRequest",
    "selectedProjectPullRequestKey",
    "subject",
  ],
  terminal: [
    "appleProjectPath",
    "appleToolchainClient",
    "codeController",
    "codeProviderGroups",
    "hostBridge",
    "projectExtraFolders",
    "providerController",
    "serverUrl",
    "subject",
    "utilityTabId",
    "windowCapability",
  ],
  tests: [
    "appleProjectPath",
    "appleToolchainClient",
    "codeController",
    "codeProviderGroups",
    "hostBridge",
    "providerController",
    "serverUrl",
    "subject",
    "utilityTabId",
    "windowCapability",
  ],
  "ios-simulator": [
    "appleProjectPath",
    "appleToolchainClient",
    "codeController",
    "codeProviderGroups",
    "hostBridge",
    "providerController",
    "serverUrl",
    "subject",
    "utilityTabId",
    "windowCapability",
  ],
  "android-emulator": [
    "androidToolchainClient",
    "codeThreadView",
    "hostBridge",
    "subject",
    "windowCapability",
  ],
  desktop: ["serverUrl", "subject", "windowCapability"],
  debug: ["onOpenFile", "serverUrl", "subject", "windowCapability"],
  environment: [],
} as const satisfies Readonly<
  Record<RightUtilityDockSurfaceId, ReadonlyArray<keyof ThreadUtilityDockContentProps>>
>;

/** Whether the tool for `surface` declares `input` among what it reads. */
export function dockToolReads(
  surface: RightUtilityDockSurfaceId,
  input: keyof ThreadUtilityDockContentProps,
): boolean {
  return dockModuleInputs[surface].some((declared) => declared === input);
}

/** Closed module allowlist. Runtime availability remains owned by the host. */
export const dockModules: Readonly<
  Record<RightUtilityDockSurfaceId, ComponentType<ThreadUtilityDockContentProps>>
> = {
  agents: (props) => createElement(AgentsModule, inputs(props, dockModuleInputs.agents)),
  "side-chat": (props) =>
    createElement(SideChatModule, inputs(props, dockModuleInputs["side-chat"])),
  browser: (props) => createElement(BrowserModule, inputs(props, dockModuleInputs.browser)),
  files: (props) => createElement(FilesModule, inputs(props, dockModuleInputs.files)),
  document: (props) => createElement(DocumentModule, inputs(props, dockModuleInputs.document)),
  plan: (props) => createElement(PlanModule, inputs(props, dockModuleInputs.plan)),
  delivery: (props) => createElement(DeliveryModule, inputs(props, dockModuleInputs.delivery)),
  canvas: (props) => createElement(CanvasModule, inputs(props, dockModuleInputs.canvas)),
  review: (props) => createElement(ReviewModule, inputs(props, dockModuleInputs.review)),
  "pull-requests": (props) =>
    createElement(ProjectPullRequestsModule, inputs(props, dockModuleInputs["pull-requests"])),
  terminal: (props) => createElement(TerminalModule, inputs(props, dockModuleInputs.terminal)),
  tests: (props) => createElement(TestsModule, inputs(props, dockModuleInputs.tests)),
  "ios-simulator": (props) =>
    createElement(SimulatorModule, inputs(props, dockModuleInputs["ios-simulator"])),
  "android-emulator": (props) =>
    createElement(AndroidEmulatorModule, inputs(props, dockModuleInputs["android-emulator"])),
  desktop: (props) => createElement(DesktopModule, inputs(props, dockModuleInputs.desktop)),
  debug: (props) => createElement(RunDebugModule, inputs(props, dockModuleInputs.debug)),
  environment: () => createElement(EnvironmentModule, {}),
};

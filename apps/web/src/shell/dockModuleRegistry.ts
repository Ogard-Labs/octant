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
const TerminalModule = lazy(() => import("../dockModules/TerminalModule"));
const TestsModule = lazy(() => import("../dockModules/TestsModule"));
const SimulatorModule = lazy(() => import("../dockModules/SimulatorModule"));
const EnvironmentModule = lazy(() => import("../dockModules/EnvironmentModule"));

/** Closed module allowlist. Runtime availability remains owned by the host. */
export const dockModules: Readonly<
  Record<RightUtilityDockSurfaceId, ComponentType<ThreadUtilityDockContentProps>>
> = {
  agents: (props) =>
    createElement(
      AgentsModule,
      inputs(props, [
        "agentRunClient",
        "agentRunSettingsClient",
        "nativeHarnessClient",
        "onFollowUpCreated",
        "subject",
      ]),
    ),
  "side-chat": (props) =>
    createElement(
      SideChatModule,
      inputs(props, [
        "chatClient",
        "chatReadCursorStore",
        "onSidecarOpened",
        "providerController",
        "serverUrl",
        "sidecarThreadId",
        "subject",
        "windowCapability",
      ]),
    ),
  browser: (props) =>
    createElement(
      BrowserModule,
      inputs(props, [
        "browserAutomationClient",
        "browserContextId",
        "hostBridge",
        "onBrowserContextCreated",
        "serverUrl",
        "subject",
        "utilityTabId",
        "windowCapability",
      ]),
    ),
  files: (props) =>
    createElement(
      FilesModule,
      inputs(props, [
        "onOpenFile",
        "serverUrl",
        "subject",
        "windowCapability",
        "workFileListingClient",
      ]),
    ),
  document: (props) =>
    createElement(
      DocumentModule,
      inputs(props, [
        "codeController",
        "serverUrl",
        "subject",
        "windowCapability",
        "writtenDocumentPath",
      ]),
    ),
  plan: (props) => createElement(PlanModule, inputs(props, ["planClient", "subject"])),
  delivery: (props) => createElement(DeliveryModule, inputs(props, ["shipClient", "subject"])),
  canvas: (props) =>
    createElement(CanvasModule, inputs(props, ["canvasClient", "subject", "writtenCanvasId"])),
  review: (props) =>
    createElement(
      ReviewModule,
      inputs(props, [
        "codeController",
        "hostBridge",
        "onOpenFile",
        "serverUrl",
        "subject",
        "windowCapability",
      ]),
    ),
  terminal: (props) =>
    createElement(
      TerminalModule,
      inputs(props, [
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
      ]),
    ),
  tests: (props) =>
    createElement(
      TestsModule,
      inputs(props, [
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
      ]),
    ),
  "ios-simulator": (props) =>
    createElement(
      SimulatorModule,
      inputs(props, [
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
      ]),
    ),
  environment: () => createElement(EnvironmentModule, {}),
};

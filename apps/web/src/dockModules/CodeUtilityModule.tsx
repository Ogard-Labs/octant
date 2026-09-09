import { Suspense } from "react";
import { decodeCodeThreadId, decodeWorkspaceTab, type WorkspaceTab } from "@octant/contracts";
import CodeWorkspaceTab from "../code/CodeWorkspaceTab";
import { ShellState } from "../shell/ShellState";
import { unavailable, loading } from "./moduleState";
import { dockTabIds, workspaceDockTabId } from "./workspaceDockTab";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
export type CodeUtilityProps = Pick<
  ThreadUtilityDockContentProps,
  | "appleProjectPath"
  | "appleToolchainClient"
  | "codeController"
  | "codeProviderGroups"
  | "hostBridge"
  | "providerController"
  | "serverUrl"
  | "subject"
  | "utilityTabId"
  | "windowCapability"
>;
export function CodeUtilityModule(
  props: CodeUtilityProps & { readonly surface: "terminal" | "tests" | "ios-simulator" },
) {
  const label = surfaceLabel(props.surface);
  if (props.subject.mode !== "code")
    return unavailable(label, `${label} opens from a Code thread.`);
  const controller = props.codeController;
  const threadId = decodeCodeThreadId(props.subject.threadId);
  if (
    controller?.activeView === undefined ||
    String(controller.activeView.thread.id) !== String(threadId)
  ) {
    return loading(label);
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
  const providerInstanceId = controller.activeView.thread.providerInstanceId;
  const harnessAutoReviewSupported =
    props.providerController === undefined
      ? undefined
      : props.providerController.observedByInstance.get(providerInstanceId)?.capabilities
            .harnessAutoReview === "supported"
        ? true
        : undefined;
  return (
    <Suspense
      fallback={<ShellState state="loading" title={`Loading ${surfaceLabel(props.surface)}`} />}
    >
      <CodeWorkspaceTab
        {...(props.appleToolchainClient === undefined
          ? {}
          : { appleToolchainClient: props.appleToolchainClient })}
        controller={controller}
        {...(props.codeProviderGroups === undefined
          ? {}
          : { providerGroups: props.codeProviderGroups })}
        {...(harnessAutoReviewSupported === undefined ? {} : { harnessAutoReviewSupported })}
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

function surfaceLabel(surface: "terminal" | "tests" | "ios-simulator"): string {
  if (surface === "terminal") return "Terminal";
  if (surface === "ios-simulator") return "iOS Simulator";
  return "Tests";
}

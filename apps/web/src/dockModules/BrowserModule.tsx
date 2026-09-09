import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { unavailable } from "./moduleState";
import { BrowserWorkspace } from "../browser/BrowserWorkspace";
import {
  decodeBrowserThreadId,
  decodeBrowserContextId,
  type WorkspaceTab,
} from "@octant/contracts";
import { workspaceDockTabId } from "./workspaceDockTab";

type Props = Pick<
  ThreadUtilityDockContentProps,
  | "browserAutomationClient"
  | "browserContextId"
  | "hostBridge"
  | "onBrowserContextCreated"
  | "serverUrl"
  | "subject"
  | "utilityTabId"
  | "windowCapability"
>;

export default function BrowserModule(props: Props) {
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

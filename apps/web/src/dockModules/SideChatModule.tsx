import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { SideChatWorkspaceTab } from "../chat/SideChatWorkspaceTab";
import { decodeMentionableThreadId, type WorkspaceTab } from "@octant/contracts";
import { dockTabIds } from "./workspaceDockTab";

type Props = Pick<
  ThreadUtilityDockContentProps,
  | "chatClient"
  | "chatReadCursorStore"
  | "onSidecarOpened"
  | "providerController"
  | "serverUrl"
  | "sidecarThreadId"
  | "subject"
  | "windowCapability"
>;

export default function SideChatModule(props: Props) {
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

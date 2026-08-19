import { createThreadMentionClient, type ThreadMentionClient } from "@octant/client-runtime";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { ChatThreadId } from "@octant/contracts/chat";
import type { SideChatSidecar } from "@octant/contracts";
import type { WorkspaceTab } from "@octant/contracts/shell";
import { buildModelPickerGroups } from "@octant/domain";
import { useMemo } from "react";
import type { ProviderController } from "../providers/useProviderController";
import { OctantButton } from "../ui/base/OctantButton";
import { ChatWorkspace } from "./ChatWorkspace";
import { SideChatPanel } from "./SideChatPanel";
import { useChatController, type ChatReadCursorStore } from "./useChatController";

/**
 * The provider facts a sidecar's Chat surface reads. Narrowed on purpose: the
 * Side Chat tab presents provider and model honestly but has no business with
 * the rest of the provider controller's mutations.
 */
export type SideChatProviderView = Pick<
  ProviderController,
  "defaults" | "instances" | "observedByInstance" | "snapshot"
>;

export interface SideChatWorkspaceTabProps {
  readonly tab: Extract<WorkspaceTab, { kind: "side-chat" }>;
  readonly chatClient: ChatClient;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly providerController?: SideChatProviderView;
  /** Injected mention client; otherwise built from the loopback server URL. */
  readonly threadMentionClient?: ThreadMentionClient;
  /** Called with the host's sidecar so the shell can persist the tab identity. */
  readonly onSidecarOpened?: (sidecar: SideChatSidecar) => void;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

/**
 * The Side Chat workspace tab.
 *
 * The tab carries the source thread it asks about; the host owns which sidecar
 * that resolves to. This component only turns the tab's persisted identity into
 * the panel's contract and renders the sidecar as the ordinary Chat surface —
 * it never decides that a sidecar exists, and it never hands the sidecar any
 * authority over the source thread.
 */
export function SideChatWorkspaceTab(props: SideChatWorkspaceTabProps) {
  const { serverUrl, threadMentionClient, windowCapability } = props;
  const mentionClient = useMemo(() => {
    if (threadMentionClient !== undefined) return threadMentionClient;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createThreadMentionClient({
        baseUrl: serverUrl,
        fetch: globalThis.fetch,
        windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [serverUrl, threadMentionClient, windowCapability]);
  const tab = props.tab;
  const onSidecarOpened = props.onSidecarOpened;
  return (
    <SideChatPanel
      {...(mentionClient === undefined ? {} : { client: mentionClient })}
      {...(onSidecarOpened === undefined || tab.sidecarThreadId !== undefined
        ? {}
        : { onSidecarOpened })}
      sourceThreadId={tab.sourceThreadId}
      renderSidecar={(sidecarThreadId) =>
        // A restored tab names the sidecar it was showing. When the host answers
        // with a different one, the recorded sidecar is gone and this lane's
        // conversation with it; say so rather than presenting a fresh, empty
        // thread as the restored one.
        tab.sidecarThreadId !== undefined &&
        String(tab.sidecarThreadId) !== String(sidecarThreadId) ? (
          <p className="side-chat__empty" role="alert">
            This tab&rsquo;s Side Chat conversation no longer exists. Close the tab and open Side
            Chat again from the thread.
          </p>
        ) : (
          <SideChatSidecarSurface
            key={String(sidecarThreadId)}
            chatClient={props.chatClient}
            chatReadCursorStore={props.chatReadCursorStore}
            {...(mentionClient === undefined ? {} : { threadMentionClient: mentionClient })}
            {...(props.providerController === undefined
              ? {}
              : { providerController: props.providerController })}
            sidecarThreadId={sidecarThreadId}
          />
        )
      }
    />
  );
}

/**
 * The sidecar rendered as ordinary Chat.
 *
 * It reads the sidecar thread directly rather than picking it out of a Chat
 * listing, which is what keeps the host's hidden-sidecar rule intact: the
 * sidecar stays out of Recents, Unfiled, and Project nesting while still being
 * openable here. Deliberately no extension client, canvas client, or Side Chat
 * callback: a Side Chat turn is an ordinary Chat turn and must not be able to
 * approve a tool, act on the source thread, or spawn a second sidecar.
 */
function SideChatSidecarSurface(props: {
  readonly chatClient: ChatClient;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly providerController?: SideChatProviderView;
  readonly sidecarThreadId: ChatThreadId;
  readonly threadMentionClient?: ThreadMentionClient;
}) {
  const controller = useChatController({
    activeThreadId: props.sidecarThreadId,
    client: props.chatClient,
    readCursorStore: props.chatReadCursorStore,
  });
  const providerController = props.providerController;
  const providerGroups = useMemo(
    () =>
      providerController === undefined
        ? []
        : buildModelPickerGroups({
            instances: providerController.instances,
            observedByInstance: providerController.observedByInstance,
            providerOrder: providerController.defaults?.providerOrder ?? [],
            mode: "chat",
          }),
    [providerController],
  );
  if (controller.status === "disconnected" && controller.activeView === undefined) {
    return (
      <div className="side-chat__empty">
        <p role="alert">
          {controller.errorMessage ?? "This Side Chat conversation could not be opened."}
        </p>
        <OctantButton onClick={controller.retry} size="sm" type="button" variant="secondary">
          Try again
        </OctantButton>
      </div>
    );
  }
  return (
    <ChatWorkspace
      controller={controller}
      providerGroups={providerGroups}
      {...(providerController?.snapshot === undefined
        ? {}
        : { providerSnapshot: providerController.snapshot })}
      {...(props.threadMentionClient === undefined
        ? {}
        : { threadMentionClient: props.threadMentionClient })}
    />
  );
}

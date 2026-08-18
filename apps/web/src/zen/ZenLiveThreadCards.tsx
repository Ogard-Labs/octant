import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import { decodeChatThreadId, type ChatThreadId } from "@octant/contracts/chat";
import { decodeWorkThreadId, type WorkThreadId } from "@octant/contracts/work-threads";
import type { ZenSourceContext, ZenThreadCatalogEntry } from "@octant/contracts/zen";
import { buildModelPickerGroups } from "@octant/domain";
import type { ZenThreadCardActivity } from "@octant/domain";
import { useMemo, type ReactNode } from "react";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import { useChatController, type ChatReadCursorStore } from "../chat/useChatController";
import type { ProviderController } from "../providers/useProviderController";
import { OctantButton } from "../ui/base/OctantButton";
import { WorkThreadWorkspace } from "../work/WorkThreadWorkspace";
import type { ZenLiveThreadCard } from "./ZenThreadElement";

/**
 * The provider facts a card reads. Narrowed on purpose: a card presents the
 * provider and model of its own thread honestly and has no business with the
 * rest of the provider controller's mutations.
 */
export type ZenCardProviderView = Pick<
  ProviderController,
  "defaults" | "instances" | "observedByInstance" | "snapshot"
>;

/**
 * The thread surfaces this window can lend to a card.
 *
 * A missing client is not an error: it means this window cannot host that mode
 * live, and the card stays its metadata reading rather than presenting an empty
 * conversation as the thread.
 */
export interface ZenLiveThreadClients {
  readonly chatClient?: ChatClient;
  readonly chatReadCursorStore?: ChatReadCursorStore;
  readonly providerController?: ZenCardProviderView;
  readonly workThreadClient?: WorkThreadClient;
  readonly workTurnClient?: WorkTurnClient;
  readonly workRequestClient?: WorkRequestClient;
  readonly workMutationClient?: WorkMutationClient;
}

export interface ZenLiveThreadCardInput {
  readonly sourceContext: ZenSourceContext;
  readonly entry: ZenThreadCatalogEntry;
  readonly activity: ZenThreadCardActivity;
  readonly clients: ZenLiveThreadClients;
}

/**
 * Decide what one attached card shows.
 *
 * The card's source context is the only thing consulted: it names the mode and
 * the exact thread, and the surface built from it holds its own controller and
 * its own stream. Two cards in the same space share nothing but the clients
 * they each opened a connection with, so neither can read, steer, or approve
 * for the other, and the focus zone itself grants no authority at all.
 */
export function resolveZenLiveThreadCard(
  input: ZenLiveThreadCardInput,
): ZenLiveThreadCard | undefined {
  const surface = buildCardSurface(input.sourceContext, input.entry, input.clients);
  if (surface === undefined) return undefined;
  if (input.activity.activity === "frozen") {
    return { status: "paused", reason: input.activity.reason };
  }
  return { status: "streaming", surface };
}

function buildCardSurface(
  sourceContext: ZenSourceContext,
  entry: ZenThreadCatalogEntry,
  clients: ZenLiveThreadClients,
): ReactNode | undefined {
  if (sourceContext.threadKind === "chat") {
    const { chatClient, chatReadCursorStore } = clients;
    if (chatClient === undefined || chatReadCursorStore === undefined) return undefined;
    return (
      <ZenChatCardSurface
        chatClient={chatClient}
        chatReadCursorStore={chatReadCursorStore}
        {...(clients.providerController === undefined
          ? {}
          : { providerController: clients.providerController })}
        threadId={decodeChatThreadId(String(sourceContext.threadId))}
      />
    );
  }
  if (sourceContext.threadKind === "work") {
    const { workThreadClient } = clients;
    if (workThreadClient === undefined) return undefined;
    return (
      <ZenWorkCardSurface
        {...(clients.providerController === undefined
          ? {}
          : { providerController: clients.providerController })}
        threadClient={workThreadClient}
        threadId={decodeWorkThreadId(String(sourceContext.threadId))}
        title={entry.title}
        {...(clients.workTurnClient === undefined ? {} : { turnClient: clients.workTurnClient })}
        {...(clients.workRequestClient === undefined
          ? {}
          : { requestClient: clients.workRequestClient })}
        {...(clients.workMutationClient === undefined
          ? {}
          : { mutationClient: clients.workMutationClient })}
      />
    );
  }
  // Code cards keep their metadata reading. A Code thread's surface is still
  // bound to one controller for the whole window, so a second Code surface
  // would show the workspace's active thread instead of this card's.
  return undefined;
}

/**
 * One Chat thread, live inside its card.
 *
 * The controller is built from this card's thread id, so the card streams its
 * own conversation regardless of what the workspace behind Zen has open.
 */
function ZenChatCardSurface(props: {
  readonly chatClient: ChatClient;
  readonly chatReadCursorStore: ChatReadCursorStore;
  readonly providerController?: ZenCardProviderView;
  readonly threadId: ChatThreadId;
}) {
  const controller = useChatController({
    activeThreadId: props.threadId,
    client: props.chatClient,
    readCursorStore: props.chatReadCursorStore,
  });
  const providerController = props.providerController;
  const providerGroups = useMemo(
    () =>
      providerController === undefined
        ? []
        : buildModelPickerGroups({
            instances: providerController.instances ?? [],
            observedByInstance: providerController.observedByInstance ?? new Map(),
            providerOrder: providerController.defaults?.providerOrder ?? [],
            mode: "chat",
          }),
    [providerController],
  );
  if (controller.status === "disconnected" && controller.activeView === undefined) {
    return (
      <div className="zen-thread-element__unreachable">
        <p role="alert">
          {controller.errorMessage ?? "This thread could not be reached from the focus zone."}
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
      narrow
      providerGroups={providerGroups}
      {...(providerController?.snapshot === undefined
        ? {}
        : { providerSnapshot: providerController.snapshot })}
    />
  );
}

/** One Work thread, live inside its card, bound to that thread's own root. */
function ZenWorkCardSurface(props: {
  readonly mutationClient?: WorkMutationClient;
  readonly providerController?: ZenCardProviderView;
  readonly requestClient?: WorkRequestClient;
  readonly threadClient: WorkThreadClient;
  readonly threadId: WorkThreadId;
  readonly title: string;
  readonly turnClient?: WorkTurnClient;
}) {
  const providerController = props.providerController;
  const providerGroups = useMemo(
    () =>
      providerController === undefined
        ? []
        : buildModelPickerGroups({
            instances: providerController.instances ?? [],
            observedByInstance: providerController.observedByInstance ?? new Map(),
            providerOrder: providerController.defaults?.providerOrder ?? [],
            mode: "work",
          }),
    [providerController],
  );
  return (
    <WorkThreadWorkspace
      {...(props.mutationClient === undefined ? {} : { mutationClient: props.mutationClient })}
      providerGroups={providerGroups}
      {...(props.requestClient === undefined ? {} : { requestClient: props.requestClient })}
      threadClient={props.threadClient}
      threadId={props.threadId}
      title={props.title}
      {...(props.turnClient === undefined ? {} : { turnClient: props.turnClient })}
    />
  );
}

import { readContinuationLink } from "../continuity/continuationLink";
import { decodeChatThreadId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import { ConversationInputClientContext } from "../continuity/ConversationInputs";
import type { ChatThread, ChatThreadId } from "@octant/contracts/chat";
import type { CodeThread, CodeThreadId } from "@octant/contracts/code";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { decodeWorkspaceTabId } from "@octant/contracts/shell";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { WorkThread } from "@octant/contracts/work-threads";
import { buildModelPickerGroups, type PickerGroup } from "@octant/domain";
import { useEffect, useMemo, useState } from "react";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import { CanvasWorkspaceTab } from "../canvas/CanvasWorkspaceTab";
import { useChatController } from "../chat/useChatController";
import { CodeThreadWorkspace } from "../code/CodeThreadWorkspace";
import { useCodeController } from "../code/useCodeController";
import { RemoteAccessDefaults } from "./RemoteAccessDefaults";
import { RemoteCoordinatorProposals } from "./RemoteCoordinatorProposals";
import { RemoteCodeThreadStart, RemoteWorkThreadStart } from "./RemoteThreadStart";
import { useProviderController } from "../providers/useProviderController";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { WorkThreadWorkspace } from "../work/WorkThreadWorkspace";
import { useWorkThreadNavigation } from "../work/useWorkThreadNavigation";
import { SurfaceEmpty } from "../surface/SurfaceHeader";
import type { RemoteProductClients } from "./remoteProductClients";
import { OctantAlert } from "../ui/base/OctantAlert";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ReplyDetailClient } from "@octant/client-runtime/reply-detail-client";
import type { ReplyDetailLevel, ReplyDetailReading } from "@octant/contracts/shell";
import {
  ReplyDetailContext,
  ReplyDetailSourceContext,
  type ReplyDetailSource,
  type ReplyDetailThread,
} from "../transcript/replyDetail";

export interface RemoteWorkspaceProps {
  readonly clients: RemoteProductClients;
  readonly mode: OctantMode;
  /** False while the session is stale: reads stay visible, sends are refused. */
  readonly connected: boolean;
  /**
   * What the host said of this session. Set for a browser the host's own
   * person paired, which is then offered what the host takes from it alone;
   * absent, the session is shown as restricted.
   */
  readonly actsAsHostPerson?: boolean;
  /** Shows each thread its waiting tool prompts; absent, none is shown. */
  readonly extensionClient?: ExtensionClient;
}

/**
 * The paired browser's product surface. Each mode mounts the same thread
 * workspace the desktop uses, driven by clients that travel over the remote
 * session; only the thread list around it is this file's own, because the
 * desktop's sidebar is bound to a window the browser does not have.
 */
export function RemoteWorkspace(props: RemoteWorkspaceProps) {
  const replyDetail = useRemoteReplyDetail(
    props.clients.replyDetail,
    props.mode,
    props.actsAsHostPerson === true,
  );
  return (
    <ConversationInputClientContext.Provider value={props.clients.conversationInputs}>
      <ReplyDetailSourceContext.Provider value={replyDetail}>
        <ReplyDetailContext.Provider value={replyDetail.reading.defaultLevel}>
          <RemoteModeSurface {...props} />
        </ReplyDetailContext.Provider>
      </ReplyDetailSourceContext.Provider>
    </ConversationInputClientContext.Provider>
  );
}

const QUIET_READING: ReplyDetailReading = { defaultLevel: "low", threads: [] };

/**
 * The host's Reply detail, read over the session: when the workspace opens, on
 * a change of mode, and when the window comes back into focus, so a level set
 * on the computer reaches this browser without a reload. It carries a setter
 * only for a session that acts as the host's person, whose change the host
 * takes on its shell settings route; any other session is offered no menu.
 */
function useRemoteReplyDetail(
  client: ReplyDetailClient,
  mode: OctantMode,
  actsAsHostPerson: boolean,
): ReplyDetailSource {
  const [reading, setReading] = useState<ReplyDetailReading>(QUIET_READING);
  useEffect(() => {
    const controller = new AbortController();
    const read = () =>
      void client.read(controller.signal).then((answer) => {
        if (answer !== undefined && !controller.signal.aborted) setReading(answer);
      });
    read();
    window.addEventListener("focus", read);
    return () => {
      controller.abort();
      window.removeEventListener("focus", read);
    };
  }, [client, mode]);
  return useMemo(
    () => ({
      reading,
      ...(actsAsHostPerson
        ? {
            setThreadLevel: (thread: ReplyDetailThread, level: ReplyDetailLevel | undefined) =>
              void client.setThreadLevel(thread, level).then(async (saved) => {
                // A refusal or a change underneath leaves the host's own
                // answer as what is drawn.
                const answer = saved ?? (await client.read());
                if (answer !== undefined) setReading(answer);
              }),
          }
        : {}),
    }),
    [actsAsHostPerson, client, reading],
  );
}

function RemoteModeSurface(props: RemoteWorkspaceProps) {
  const providerController = useProviderController({ client: props.clients.provider });
  const providerGroups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: providerController.instances,
        observedByInstance: providerController.observedByInstance,
        providerOrder: providerController.defaults.providerOrder,
        hiddenModels: providerController.defaults.hiddenModels,
        mode: props.mode,
      }),
    [
      providerController.instances,
      providerController.observedByInstance,
      providerController.defaults.providerOrder,
      providerController.defaults.hiddenModels,
      props.mode,
    ],
  );
  const [canvas, setCanvas] = useState<{
    readonly card: CanvasThreadReferenceCard;
    readonly client: RemoteProductClients["canvas"];
    readonly tabId: ReturnType<typeof decodeWorkspaceTabId>;
  }>();
  const onNavigate = () => setCanvas(undefined);
  const onOpenCanvas = (card: CanvasThreadReferenceCard) =>
    setCanvas({
      card,
      client: props.clients.canvas,
      tabId: decodeWorkspaceTabId(crypto.randomUUID()),
    });
  useEffect(() => setCanvas(undefined), [props.mode, props.clients.canvas]);
  let surface;
  switch (props.mode) {
    case "chat":
      surface = (
        <RemoteChatSurface
          clients={props.clients}
          connected={props.connected}
          actsAsHostPerson={props.actsAsHostPerson === true}
          extensionClient={props.extensionClient}
          onNavigate={onNavigate}
          onOpenCanvas={onOpenCanvas}
          providerGroups={providerGroups}
          {...(providerController.snapshot === undefined
            ? {}
            : { providerSnapshot: providerController.snapshot })}
        />
      );
      break;
    case "work":
      surface = (
        <RemoteWorkSurface
          clients={props.clients}
          connected={props.connected}
          actsAsHostPerson={props.actsAsHostPerson === true}
          extensionClient={props.extensionClient}
          onNavigate={onNavigate}
          onOpenCanvas={onOpenCanvas}
          providerGroups={providerGroups}
        />
      );
      break;
    case "code":
      surface = (
        <RemoteCodeSurface
          clients={props.clients}
          connected={props.connected}
          actsAsHostPerson={props.actsAsHostPerson === true}
          extensionClient={props.extensionClient}
          onNavigate={onNavigate}
          onOpenCanvas={onOpenCanvas}
          providerGroups={providerGroups}
        />
      );
      break;
  }
  return (
    <>
      {surface}
      {props.actsAsHostPerson === true && props.mode !== "chat" ? (
        <RemoteAccessDefaults
          codeClient={props.clients.code}
          connected={props.connected}
          key={props.mode}
          mode={props.mode}
          projectClient={props.clients.project}
          workThreadClient={props.clients.workThread}
        />
      ) : null}
      <OctantDialogPresence>
        {canvas === undefined ||
        canvas.client !== props.clients.canvas ||
        canvas.card.scope.mode !== props.mode ? null : (
          <OctantDialog label={canvas.card.title} onClose={() => setCanvas(undefined)} open>
            <CanvasWorkspaceTab
              key={String(canvas.card.canvasId)}
              client={canvas.client}
              tab={{
                kind: "canvas",
                id: canvas.tabId,
                mode: canvas.card.scope.mode,
                title: canvas.card.title,
                canvasId: canvas.card.canvasId,
                projectId: canvas.card.scope.workspace.projectId,
              }}
            />
          </OctantDialog>
        )}
      </OctantDialogPresence>
    </>
  );
}

interface RemoteSurfaceProps {
  readonly clients: RemoteProductClients;
  /** A browser the host's own person paired starts threads as a window does. */
  readonly actsAsHostPerson: boolean;
  readonly extensionClient: ExtensionClient | undefined;
  readonly connected: boolean;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
  readonly onNavigate: () => void;
  readonly onOpenCanvas: (card: CanvasThreadReferenceCard) => void;
}

function RemoteChatSurface(
  props: RemoteSurfaceProps & { readonly providerSnapshot?: ProviderRegistrySnapshot },
) {
  const [activeThreadId, setActiveThreadId] = useState<ChatThreadId | undefined>(() => {
    const link = readContinuationLink(globalThis.location?.href ?? "");
    return link?.mode === "chat" ? decodeChatThreadId(link.threadId) : undefined;
  });
  const [chatProjectId, setChatProjectId] = useState<ProjectId>();
  const [createError, setCreateError] = useState<string>();
  const controller = useChatController({
    client: props.clients.chat,
    ...(activeThreadId === undefined ? {} : { activeThreadId }),
    navigationRefreshMs: 5_000,
  });
  useEffect(() => {
    let cancelled = false;
    void props.clients.project
      .bootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        const project = bootstrap.active.find(
          (candidate) => candidate.type === "chat" && candidate.lifecycle === "active",
        );
        setChatProjectId(project?.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.clients.project]);
  const threads = (controller.bootstrap?.threads ?? []).filter(
    (thread) => thread.lifecycle === "active",
  );

  const createThread = async () => {
    setCreateError(undefined);
    const created = await controller.execute({
      kind: "create-chat-thread",
      title: "New thread",
      ...(chatProjectId === undefined ? {} : { projectId: chatProjectId }),
    });
    if (created?.kind !== "thread-created") {
      setCreateError(controller.errorMessage ?? "The host did not create a thread.");
      return;
    }
    setActiveThreadId(created.thread.id);
  };

  return (
    <RemoteThreadPane
      mode="chat"
      threads={threads}
      activeThreadId={activeThreadId}
      onSelect={(thread) => {
        props.onNavigate();
        setActiveThreadId(thread.id);
      }}
      status={controller.status === "disconnected" ? "disconnected" : "ready"}
      errorMessage={createError ?? controller.errorMessage}
      action={
        <OctantButton
          disabled={!props.connected}
          onClick={() => void createThread()}
          size="sm"
          type="button"
          variant="secondary"
        >
          New thread
        </OctantButton>
      }
    >
      {activeThreadId === undefined ? null : (
        <ChatWorkspace
          canvasClient={props.clients.canvas}
          controller={controller}
          {...(props.extensionClient === undefined
            ? {}
            : { extensionClient: props.extensionClient })}
          narrow
          onOpenCanvas={props.onOpenCanvas}
          providerGroups={props.providerGroups}
          {...(props.providerSnapshot === undefined
            ? {}
            : { providerSnapshot: props.providerSnapshot })}
        />
      )}
    </RemoteThreadPane>
  );
}

function RemoteWorkSurface(props: RemoteSurfaceProps) {
  const [activeThreadId, setActiveThreadId] = useState<WorkThread["id"] | undefined>(() => {
    const link = readContinuationLink(globalThis.location?.href ?? "");
    return link?.mode === "work" ? decodeWorkThreadId(link.threadId) : undefined;
  });
  const workNavigation = useWorkThreadNavigation(props.clients.workThread, {
    navigationRefreshMs: 5_000,
  });
  const threads = (workNavigation.bootstrap?.threads ?? []).filter(
    (thread) => thread.lifecycle === "active",
  );
  const activeThread = threads.find((thread) => String(thread.id) === String(activeThreadId));
  const status =
    workNavigation.status === "unavailable"
      ? "disconnected"
      : workNavigation.status === "loading"
        ? "loading"
        : "ready";

  return (
    <RemoteThreadPane
      mode="work"
      threads={threads}
      activeThreadId={activeThreadId}
      onSelect={(thread) => {
        props.onNavigate();
        setActiveThreadId(thread.id);
      }}
      status={status}
      errorMessage={workNavigation.errorMessage}
      emptyMessage={
        props.actsAsHostPerson
          ? "No Work threads on this host yet. Start one here or from the host."
          : "No Work threads on this host yet. Start one from the host; it will appear here."
      }
      start={
        props.actsAsHostPerson ? (
          <RemoteWorkThreadStart
            connected={props.connected}
            onCreated={(thread) => {
              // The list is read again because it only updates threads it holds.
              void workNavigation.refresh();
              props.onNavigate();
              setActiveThreadId(thread.id);
            }}
            projectClient={props.clients.project}
            providerGroups={props.providerGroups}
            workThreadClient={props.clients.workThread}
          />
        ) : undefined
      }
    >
      {activeThread === undefined ? null : (
        <WorkThreadWorkspace
          key={String(activeThread.id)}
          title={activeThread.title}
          threadId={activeThread.id}
          initialThread={activeThread}
          canvasClient={props.clients.canvas}
          onOpenCanvas={props.onOpenCanvas}
          onOpenCanvasInSidebar={props.onOpenCanvas}
          canvasOpenLabel="Open Canvas"
          threadClient={props.clients.workThread}
          turnClient={props.clients.workTurn}
          mutationClient={props.clients.workMutation}
          requestClient={props.clients.workRequest}
          providerGroups={props.providerGroups}
          {...(props.extensionClient === undefined
            ? {}
            : { extensionClient: props.extensionClient })}
          onThreadUpdated={workNavigation.applyThread}
        />
      )}
    </RemoteThreadPane>
  );
}

function RemoteCodeSurface(props: RemoteSurfaceProps) {
  const [activeThreadId, setActiveThreadId] = useState<CodeThreadId | undefined>(() => {
    const link = readContinuationLink(globalThis.location?.href ?? "");
    return link?.mode === "code" ? decodeCodeThreadId(link.threadId) : undefined;
  });
  const controller = useCodeController({
    client: props.clients.code,
    ...(activeThreadId === undefined ? {} : { activeThreadId }),
    navigationRefreshMs: 5_000,
  });
  const threads = (controller.bootstrap?.threads ?? []).filter(
    (thread) => thread.lifecycle === "active",
  );
  const activeThread = threads.find((thread) => String(thread.id) === String(activeThreadId));
  return (
    <RemoteThreadPane
      mode="code"
      threads={threads}
      activeThreadId={activeThreadId}
      onSelect={(thread) => {
        props.onNavigate();
        setActiveThreadId(thread.id);
      }}
      status={controller.status === "disconnected" ? "disconnected" : "ready"}
      errorMessage={controller.errorMessage}
      emptyMessage={
        props.actsAsHostPerson
          ? "No Code threads on this host yet. Start one here or from the host."
          : "No Code threads on this host yet. Start one from the host; it will appear here."
      }
      start={
        props.actsAsHostPerson ? (
          <RemoteCodeThreadStart
            codeClient={props.clients.code}
            connected={props.connected}
            controller={controller}
            onCreated={(thread) => {
              props.onNavigate();
              setActiveThreadId(thread.id);
            }}
            projectClient={props.clients.project}
            providerGroups={props.providerGroups}
          />
        ) : undefined
      }
    >
      {activeThreadId === undefined ? null : (
        <>
          {activeThread === undefined ? null : (
            <RemoteCoordinatorProposals client={props.clients.code} thread={activeThread} />
          )}
          <CodeThreadWorkspace
            canvasClient={props.clients.canvas}
            onOpenCanvas={props.onOpenCanvas}
            onOpenCanvasInSidebar={props.onOpenCanvas}
            canvasOpenLabel="Open Canvas"
            controller={controller}
            {...(props.extensionClient === undefined
              ? {}
              : { extensionClient: props.extensionClient })}
            pairedDevice
            threadId={activeThreadId}
            providerGroups={props.providerGroups}
          />
        </>
      )}
    </RemoteThreadPane>
  );
}

type RemoteThread = ChatThread | WorkThread | CodeThread;

interface RemoteThreadPaneProps<T extends RemoteThread> {
  readonly mode: OctantMode;
  readonly threads: ReadonlyArray<T>;
  readonly activeThreadId: T["id"] | undefined;
  readonly onSelect: (thread: T) => void;
  readonly status: "loading" | "ready" | "disconnected";
  readonly errorMessage?: string | undefined;
  readonly emptyMessage?: string;
  readonly action?: React.ReactNode;
  /** What starts a thread in a Project, shown under the heading. */
  readonly start?: React.ReactNode;
  readonly children: React.ReactNode;
}

const modeLabels: Record<OctantMode, string> = { chat: "Chat", work: "Work", code: "Code" };

function RemoteThreadPane<T extends RemoteThread>(props: RemoteThreadPaneProps<T>) {
  const label = modeLabels[props.mode];
  return (
    <section aria-label={`${label} threads`} className="remote-workspace">
      <nav aria-label={`${label} thread list`} className="remote-workspace__threads">
        <div className="remote-workspace__threads-header">
          <h2 className="remote-shell__section-title">{label}</h2>
          {props.action}
        </div>
        {props.start}
        {props.status === "disconnected" ? (
          /* ui-boundary-exception: empty-state */
          <div role="alert">
            <SurfaceEmpty
              detail={props.errorMessage ?? `${label} could not be read from the host.`}
              title={`${label} could not be read`}
            />
          </div>
        ) : props.status === "loading" ? (
          <SurfaceEmpty title={`Reading ${label} threads…`} />
        ) : props.threads.length === 0 ? (
          <SurfaceEmpty
            {...(props.emptyMessage === undefined ? {} : { detail: props.emptyMessage })}
            title={`No ${label} threads yet`}
          />
        ) : (
          <ul className="remote-workspace__thread-list">
            {props.threads.map((thread) => (
              <li key={String(thread.id)}>
                <OctantButton
                  aria-current={
                    String(thread.id) === String(props.activeThreadId) ? "true" : undefined
                  }
                  className="remote-workspace__thread"
                  onClick={() => props.onSelect(thread)}
                  type="button"
                  variant={
                    String(thread.id) === String(props.activeThreadId) ? "secondary" : "ghost"
                  }
                >
                  {thread.title}
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
        {props.status === "disconnected" || props.errorMessage === undefined ? null : (
          <OctantAlert className="remote-shell__hint" tone="warning">
            {props.errorMessage}
          </OctantAlert>
        )}
      </nav>
      <div className="remote-workspace__thread-view">
        {props.children ?? null}
        {props.children === null || props.children === undefined ? (
          <ShellState
            message={`Choose a ${label} thread to read it here and send a turn to the host.`}
            state="neutral"
            title={`${label} on the paired host`}
          />
        ) : null}
      </div>
    </section>
  );
}

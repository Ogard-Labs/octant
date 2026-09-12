import type { ChatThread, ChatThreadId } from "@octant/contracts/chat";
import type { CodeThread, CodeThreadId } from "@octant/contracts/code";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type { WorkThread } from "@octant/contracts/work-threads";
import { buildModelPickerGroups, type PickerGroup } from "@octant/domain";
import { useEffect, useMemo, useState } from "react";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import { useChatController } from "../chat/useChatController";
import { CodeThreadWorkspace } from "../code/CodeThreadWorkspace";
import { useCodeController } from "../code/useCodeController";
import { useProviderController } from "../providers/useProviderController";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import { WorkThreadWorkspace } from "../work/WorkThreadWorkspace";
import { useWorkThreadNavigation } from "../work/useWorkThreadNavigation";
import type { RemoteProductClients } from "./remoteProductClients";

export interface RemoteWorkspaceProps {
  readonly clients: RemoteProductClients;
  readonly mode: OctantMode;
  /** False while the session is stale: reads stay visible, sends are refused. */
  readonly connected: boolean;
}

/**
 * The paired browser's product surface. Each mode mounts the same thread
 * workspace the desktop uses, driven by clients that travel over the remote
 * session; only the thread list around it is this file's own, because the
 * desktop's sidebar is bound to a window the browser does not have.
 */
export function RemoteWorkspace(props: RemoteWorkspaceProps) {
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
  switch (props.mode) {
    case "chat":
      return (
        <RemoteChatSurface
          clients={props.clients}
          connected={props.connected}
          providerGroups={providerGroups}
          {...(providerController.snapshot === undefined
            ? {}
            : { providerSnapshot: providerController.snapshot })}
        />
      );
    case "work":
      return (
        <RemoteWorkSurface
          clients={props.clients}
          connected={props.connected}
          providerGroups={providerGroups}
        />
      );
    case "code":
      return (
        <RemoteCodeSurface
          clients={props.clients}
          connected={props.connected}
          providerGroups={providerGroups}
        />
      );
  }
}

interface RemoteSurfaceProps {
  readonly clients: RemoteProductClients;
  readonly connected: boolean;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
}

function RemoteChatSurface(
  props: RemoteSurfaceProps & { readonly providerSnapshot?: ProviderRegistrySnapshot },
) {
  const [activeThreadId, setActiveThreadId] = useState<ChatThreadId>();
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
      onSelect={(thread) => setActiveThreadId(thread.id)}
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
          controller={controller}
          narrow
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
  const [activeThreadId, setActiveThreadId] = useState<WorkThread["id"]>();
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
      onSelect={(thread) => setActiveThreadId(thread.id)}
      status={status}
      errorMessage={workNavigation.errorMessage}
      emptyMessage="No Work threads on this host yet. Start one from the host; it will appear here."
    >
      {activeThread === undefined ? null : (
        <WorkThreadWorkspace
          key={String(activeThread.id)}
          title={activeThread.title}
          threadId={activeThread.id}
          initialThread={activeThread}
          threadClient={props.clients.workThread}
          turnClient={props.clients.workTurn}
          mutationClient={props.clients.workMutation}
          requestClient={props.clients.workRequest}
          providerGroups={props.providerGroups}
          onThreadUpdated={workNavigation.applyThread}
        />
      )}
    </RemoteThreadPane>
  );
}

function RemoteCodeSurface(props: RemoteSurfaceProps) {
  const [activeThreadId, setActiveThreadId] = useState<CodeThreadId>();
  const controller = useCodeController({
    client: props.clients.code,
    ...(activeThreadId === undefined ? {} : { activeThreadId }),
    navigationRefreshMs: 5_000,
  });
  const threads = (controller.bootstrap?.threads ?? []).filter(
    (thread) => thread.lifecycle === "active",
  );
  return (
    <RemoteThreadPane
      mode="code"
      threads={threads}
      activeThreadId={activeThreadId}
      onSelect={(thread) => setActiveThreadId(thread.id)}
      status={controller.status === "disconnected" ? "disconnected" : "ready"}
      errorMessage={controller.errorMessage}
      emptyMessage="No Code threads on this host yet. Start one from the host; it will appear here."
    >
      {activeThreadId === undefined ? null : (
        <CodeThreadWorkspace
          controller={controller}
          threadId={activeThreadId}
          providerGroups={props.providerGroups}
        />
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
        {props.status === "disconnected" ? (
          <p className="remote-shell__hint" role="alert">
            {props.errorMessage ?? `${label} could not be read from the host.`}
          </p>
        ) : props.status === "loading" ? (
          <p className="remote-shell__hint" role="status">
            Reading {label} threads from the host…
          </p>
        ) : props.threads.length === 0 ? (
          <p className="remote-shell__hint">{props.emptyMessage ?? `No ${label} threads yet.`}</p>
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
          <p className="remote-shell__hint" role="alert">
            {props.errorMessage}
          </p>
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

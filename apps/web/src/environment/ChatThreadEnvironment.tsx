import type { ProjectSummary, WorkspaceTab } from "@octant/contracts";
import { deriveChatEnvironmentProjection } from "@octant/domain/shell-policy";
import { useState, type ReactNode } from "react";
import type { ChatController } from "../chat/useChatController";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { EnvironmentSubagents } from "./EnvironmentSubagents";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";

type ChatThreadWorkspaceTab = Extract<WorkspaceTab, { readonly kind: "chat-thread" }>;
type ChatProject = Extract<ProjectSummary, { readonly type: "chat" }>;

export interface ChatThreadEnvironmentProps {
  readonly children: ReactNode;
  readonly controller: ChatController;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly tab: ChatThreadWorkspaceTab;
  readonly active?: boolean;
  readonly agentRunClient?: AgentRunClient;
  readonly onOpenAgents?: () => void;
  readonly environmentOpen?: boolean;
  readonly onOpenEnvironment?: (opener: HTMLElement) => void;
}

/**
 * Mounts Chat's virtual, thread-authoritative context as a compact summary
 * with a transient disclosure. Facts come only from the active Chat thread
 * view; renderer Project state is used solely to resolve the thread's exact
 * Project id and never as a fallback authority source.
 */
export function ChatThreadEnvironment(props: ChatThreadEnvironmentProps) {
  const [localEnvironmentOpen, setLocalEnvironmentOpen] = useState(false);
  const environmentOpen = props.environmentOpen ?? localEnvironmentOpen;
  const view = props.controller.activeView;
  const projectId = view?.thread.projectId;
  const project = props.projects.find(
    (candidate): candidate is ChatProject =>
      candidate.type === "chat" && candidate.id === projectId,
  );
  const projection = deriveChatEnvironmentProjection({
    controllerStatus: props.controller.status,
    hasAuthoritativeThread: view !== undefined,
    threadHasProject: projectId !== undefined,
    ...(project === undefined ? {} : { projectName: project.name }),
  });

  return (
    <div className="thread-environment-wrapper">
      <ThreadEnvironmentPanel
        {...(props.active === undefined ? {} : { active: props.active })}
        inlineFallback={props.environmentOpen === undefined}
        onOpen={props.onOpenEnvironment ?? (() => setLocalEnvironmentOpen(true))}
        open={environmentOpen}
        summary={{ identity: projection.identity }}
      >
        <ChatEnvironmentFacts
          available={projection.identity.status === "available"}
          controller={props.controller}
          {...(project === undefined ? {} : { project })}
          unavailableMessage={projection.identity.detail}
        />
        {props.agentRunClient === undefined ? null : (
          <EnvironmentSubagents
            client={props.agentRunClient}
            {...(props.onOpenAgents === undefined ? {} : { onOpenAgents: props.onOpenAgents })}
            threadId={String(props.tab.threadId)}
          />
        )}
      </ThreadEnvironmentPanel>
      <div className="thread-environment-wrapper__content">{props.children}</div>
    </div>
  );
}

function ChatEnvironmentFacts(props: {
  readonly available: boolean;
  readonly controller: ChatController;
  readonly project?: ChatProject;
  readonly unavailableMessage: string;
}) {
  const view = props.controller.activeView;
  if (!props.available || view === undefined) {
    const unresolvedProject =
      view?.thread.projectId !== undefined && props.project === undefined
        ? "Authoritative Chat context is unavailable."
        : undefined;
    return (
      <p className="environment-chat-group__status" role="status">
        {props.controller.status === "loading"
          ? "Loading authoritative Chat context."
          : (props.controller.errorMessage ?? unresolvedProject ?? props.unavailableMessage)}
      </p>
    );
  }

  const attachmentCount = view.attachments.filter(
    (attachment) => attachment.status !== "purged",
  ).length;
  return (
    <div className="environment-chat-group">
      <dl>
        <ChatFact label="Context" value={props.project?.name ?? "Unfiled Chat"} />
        <ChatFact
          label="Memory"
          value={props.project === undefined ? "Unavailable for unfiled Chat" : "Project-scoped"}
        />
        <ChatFact label="Attachments" value={countLabel(attachmentCount, "attachment")} />
        <ChatFact label="Sources" value={countLabel(view.citations.length, "source")} />
        <ChatFact label="Recap" value={countLabel(view.turns.length, "turn")} />
      </dl>
    </div>
  );
}

function ChatFact(props: { readonly label: string; readonly value: string }) {
  return (
    <div className="environment-chat-group__row">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

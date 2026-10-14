import type { ProjectSummary, WorkspaceTab } from "@octant/contracts";
import { deriveChatEnvironmentProjection } from "@octant/domain/shell-policy";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { ChatThreadView } from "@octant/contracts/chat";
import type { ChatController } from "../chat/useChatController";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { EnvironmentCard } from "./EnvironmentGroup";
import { EnvironmentSubagents } from "./EnvironmentSubagents";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import { ThreadUsagePanel } from "../usage/ThreadUsagePanel";
import type { UsageDashboardClient, UsageQueryFilter } from "@octant/client-runtime";

type ChatThreadWorkspaceTab = Extract<WorkspaceTab, { readonly kind: "chat-thread" }>;
type ChatProject = Extract<ProjectSummary, { readonly type: "chat" }>;

export interface ChatThreadEnvironmentProps {
  readonly children: ReactNode;
  readonly controller: ChatController;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly tab: ChatThreadWorkspaceTab;
  readonly active?: boolean;
  readonly agentRunClient?: AgentRunClient;
  /** Opens the Agents tool; with a run id, on that subagent. */
  readonly onOpenAgents?: (runId?: string) => void;
  readonly environmentOpen?: boolean;
  readonly usageDashboardClient?: UsageDashboardClient;
  readonly spendCeilingClient?: import("@octant/client-runtime").SpendCeilingClient;
  readonly onOpenUsageDashboard?: (filter: UsageQueryFilter) => void;
}

/**
 * Mounts Chat's virtual, thread-authoritative context as a compact summary
 * with a transient disclosure. Facts come only from the active Chat thread
 * view; renderer Project state is used solely to resolve the thread's exact
 * Project id and never as a fallback authority source.
 */
export function ChatThreadEnvironment(props: ChatThreadEnvironmentProps) {
  const environmentOpen = props.environmentOpen === true;
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
        open={environmentOpen}
        summary={{ identity: projection.identity }}
      >
        <ChatEnvironmentFacts
          available={projection.identity.status === "available"}
          controller={props.controller}
          {...(project === undefined ? {} : { project })}
          unavailableMessage={projection.identity.detail}
        />
        <EnvironmentCard>
          {props.agentRunClient === undefined ? null : (
            <EnvironmentSubagents
              client={props.agentRunClient}
              {...(props.onOpenAgents === undefined ? {} : { onOpenAgents: props.onOpenAgents })}
              threadId={String(props.tab.threadId)}
            />
          )}
          {props.usageDashboardClient === undefined &&
          props.spendCeilingClient === undefined ? null : (
            <ThreadUsagePanel
              client={props.usageDashboardClient}
              subjectType="chat-thread"
              subjectId={String(props.tab.threadId)}
              {...(projectId === undefined ? {} : { projectId: String(projectId) })}
              {...(props.spendCeilingClient === undefined
                ? {}
                : { spendCeilingClient: props.spendCeilingClient })}
              {...(props.onOpenUsageDashboard === undefined
                ? {}
                : { onOpenUsageDashboard: props.onOpenUsageDashboard })}
            />
          )}
        </EnvironmentCard>
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

  return (
    <ChatEnvironmentCounts
      controller={props.controller}
      {...(props.project === undefined ? {} : { project: props.project })}
      view={view}
    />
  );
}

/**
 * The thread's attachment, source, and turn counts are totals over the whole
 * thread. A view that opened on its newest messages holds only the pages that
 * are loaded, so the totals come from the host's whole-thread read while this
 * panel is open, say they are being counted until it answers, and offer to try
 * again when it fails.
 */
function ChatEnvironmentCounts(props: {
  readonly controller: ChatController;
  readonly project?: ChatProject;
  readonly view: ChatThreadView;
}) {
  const transcriptWindow = props.controller.transcriptWindow;
  const windowed = transcriptWindow?.windowed === true;
  const whole = useWholeChatThread(
    windowed ? props.view : undefined,
    transcriptWindow?.supersededTurnCount ?? 0,
    props.controller.readWholeThread,
  );
  const view = windowed ? (whole.kind === "counted" ? whole.view : undefined) : props.view;
  const unread = windowed && whole.kind === "failed" ? "Unavailable" : "Counting";
  const count = (value: (counted: ChatThreadView) => number, singular: string) =>
    view === undefined ? unread : countLabel(value(view), singular);
  return (
    <div className="environment-chat-group">
      <dl>
        <ChatFact label="Context" value={props.project?.name ?? "Unfiled Chat"} />
        <ChatFact
          label="Memory"
          value={props.project === undefined ? "Unavailable for unfiled Chat" : "Project-scoped"}
        />
        <ChatFact
          label="Attachments"
          value={count(
            (counted) =>
              counted.attachments.filter((attachment) => attachment.status !== "purged").length,
            "attachment",
          )}
        />
        <ChatFact label="Sources" value={count((counted) => counted.citations.length, "source")} />
        <ChatFact label="Recap" value={count((counted) => counted.turns.length, "turn")} />
      </dl>
      {windowed && whole.kind === "failed" ? (
        <p className="environment-chat-group__status" role="status">
          The thread&apos;s totals could not be read.{" "}
          <OctantButton onClick={whole.retry} size="sm" type="button" variant="ghost">
            Try again
          </OctantButton>
        </p>
      ) : null}
    </div>
  );
}

type WholeChatThread =
  | { readonly kind: "counting" }
  | { readonly kind: "counted"; readonly view: ChatThreadView }
  | { readonly kind: "failed"; readonly retry: () => void };

/**
 * The whole thread behind a windowed view. It is read again only when the
 * thread itself changes: a turn is added or settles, an edit supersedes turns,
 * or the newest turn gains an attachment or a source. Loading earlier pages
 * changes what is loaded, not the thread, so it reads nothing; nor does a
 * streamed delta.
 */
function useWholeChatThread(
  view: ChatThreadView | undefined,
  supersededTurnCount: number,
  read: (threadId: ChatThreadView["thread"]["id"]) => Promise<ChatThreadView>,
): WholeChatThread {
  const [answer, setAnswer] = useState<
    | { readonly key: string; readonly view: ChatThreadView }
    | { readonly key: string; readonly failed: true }
    | undefined
  >(undefined);
  const [attempt, setAttempt] = useState(0);
  const newest = view?.turns.at(-1);
  const key =
    view === undefined
      ? undefined
      : [
          String(view.thread.id),
          supersededTurnCount,
          String(newest?.id ?? ""),
          newest?.attempts.length ?? 0,
          newest?.attempts.at(-1)?.outcome ?? "",
          view.attachments
            .filter(
              (attachment) =>
                attachment.turnId === undefined ||
                String(attachment.turnId) === String(newest?.id ?? ""),
            )
            .map((attachment) => `${String(attachment.id)}/${attachment.status}`)
            .join(","),
          view.citations.filter((citation) => String(citation.turnId) === String(newest?.id ?? ""))
            .length,
        ].join(":");
  const threadId = view?.thread.id;
  useEffect(() => {
    if (key === undefined || threadId === undefined) return;
    let current = true;
    read(threadId).then(
      (answered) => {
        if (current) setAnswer({ key, view: answered });
      },
      () => {
        if (current) setAnswer({ key, failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, key, read, threadId]);
  const retry = useCallback(() => {
    setAnswer(undefined);
    setAttempt((count) => count + 1);
  }, []);
  // An answer stays shown while the next read for a changed thread is out,
  // as long as it is about this thread.
  if (answer === undefined || threadId === undefined) return { kind: "counting" };
  if ("failed" in answer) {
    return answer.key === key ? { kind: "failed", retry } : { kind: "counting" };
  }
  return String(answer.view.thread.id) === String(threadId)
    ? { kind: "counted", view: answer.view }
    : { kind: "counting" };
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

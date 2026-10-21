import {
  decodeCodeThreadId,
  type CodeBoardCard,
  type CodeBoardQuery,
  type CodeBoardView,
  type LocalServerSnapshot,
  type ProjectId,
} from "@octant/contracts";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isActiveAgentHierarchyStatus,
  subagentNeedsReview,
} from "../agents/buildAgentHierarchyModel";
import { subagentStatusWord } from "../agents/subagentStatus";
import { useChildRunStatus } from "../agents/useChildRunStatus";
import { useLocalServersController } from "../environment/useLocalServersController";
import { relativeTimeLabel } from "../lib/relativeTime";
import {
  DockThreadOverview,
  type DockRemoteAccess,
  type DockThreadBackgroundTask,
  type DockThreadChanges,
  type DockThreadFacts,
  type DockThreadOutput,
  type DockThreadServer,
} from "./DockThreadOverview";
import type { RunningThreadFact } from "./dockThreadOverviewModel";
import type { RemoteAccessAdministrationBridge } from "./hostBridge";
import { useThreadBoardCard } from "./useThreadBoardCard";
import { writtenDocumentId, type WrittenDocument } from "./writtenDocuments";

export interface DockThreadOverviewContentProps {
  readonly mode: "work" | "code";
  readonly threadId: string;
  readonly projectId?: ProjectId | undefined;
  readonly projectName?: string | undefined;
  readonly context?: DockThreadFacts["context"] | undefined;
  /** The display name of the host the thread runs on. */
  readonly host?: string | undefined;
  /** Whether the thread's own row says it runs on a worktree of the Project. */
  readonly worktree?: boolean | undefined;
  /** The branch the row names, used when the board has not answered yet. */
  readonly branchFallback?: string | undefined;
  readonly running: ReadonlyArray<RunningThreadFact>;
  readonly onOpenRunning: (thread: RunningThreadFact) => void;
  readonly onOpenReview: () => void;
  readonly onOpenEnvironment: () => void;
  /** Where this window reaches its host, for the one look at local servers. */
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly loadBoard?: ((query: CodeBoardQuery) => Promise<CodeBoardView>) | undefined;
  readonly boardRevision: number;
  /** Documents and Canvases the window knows the thread has, oldest first. */
  readonly documents?: ReadonlyArray<WrittenDocument> | undefined;
  readonly onOpenDocument?: ((document: WrittenDocument) => void) | undefined;
  /** Reads the runs this thread handed work to, as the Environment tab does. */
  readonly agentRunClient?: AgentRunClient | undefined;
  readonly onOpenSubagent?: ((runId: string) => void) | undefined;
  /**
   * This computer's listener administration: present only in the desktop
   * app's own window, and only for a thread running on this computer.
   */
  readonly remoteAccess?: RemoteAccessAdministrationBridge | undefined;
  readonly onOpenRemoteAccessSettings?: (() => void) | undefined;
  readonly now: number;
}

/** A glance, not a list: the Document and Canvas tools hold the rest. */
const MAX_OUTPUTS = 5;

/**
 * The dock's overview for the thread on screen, gathered from what the window
 * already holds plus, for Code, the board's card for this thread.
 */
export function DockThreadOverviewContent(props: DockThreadOverviewContentProps) {
  const card = useThreadBoardCard({
    loadBoard: props.loadBoard,
    projectId: props.projectId,
    threadId: props.threadId,
    enabled: props.mode === "code",
    changeRevision: props.boardRevision,
  });
  // One look at this checkout's servers when the overview opens, never a poll:
  // the Environment tab is where they are watched live.
  const codeThreadId = useMemo(
    () => (props.mode === "code" ? decodeCodeThreadId(props.threadId) : undefined),
    [props.mode, props.threadId],
  );
  const localServers = useLocalServersController({
    enabled: codeThreadId !== undefined,
    poll: false,
    ...(codeThreadId === undefined ? {} : { threadId: codeThreadId }),
    ...(props.projectId === undefined ? {} : { projectId: props.projectId }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  // The controller keeps its last reading while it reads the next thread, and
  // keeps it if that read fails; a reading taken for another thread is never
  // shown as this one's.
  const snapshot =
    codeThreadId !== undefined &&
    localServers.snapshot !== undefined &&
    String(localServers.snapshot.threadId) === String(codeThreadId)
      ? localServers.snapshot
      : undefined;
  const servers = useMemo(() => checkoutServers(snapshot), [snapshot]);
  const outputs = useMemo(
    () => threadOutputs(props.documents, props.onOpenDocument),
    [props.documents, props.onOpenDocument],
  );
  // The same read, at the same cadence, as the Environment tab's Subagents row.
  const parentThreadId = useMemo(
    () => decodeAgentRunParentThreadId(props.threadId),
    [props.threadId],
  );
  const childRuns = useChildRunStatus({
    ...(props.agentRunClient === undefined ? {} : { client: props.agentRunClient }),
    parentThreadId,
  });
  const backgroundTasks = useMemo(() => {
    if (childRuns.status !== "ready" || childRuns.entries.length === 0) return undefined;
    const open = props.onOpenSubagent;
    const toTask = (entry: (typeof childRuns.entries)[number]): DockThreadBackgroundTask => ({
      id: entry.runId,
      task: entry.task,
      state: subagentNeedsReview(entry) ? "To review" : subagentStatusWord(entry.lifecycleStatus),
      age: relativeTimeLabel(entry.updatedAt, props.now),
      onOpen: () => open?.(entry.runId),
    });
    const byRecent = childRuns.entries.toSorted(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    return {
      running: byRecent
        .filter((entry) => isActiveAgentHierarchyStatus(entry.lifecycleStatus))
        .map(toTask),
      finished: byRecent
        .filter((entry) => !isActiveAgentHierarchyStatus(entry.lifecycleStatus))
        .map(toTask),
    };
  }, [childRuns.status, childRuns.entries, props.onOpenSubagent, props.now]);
  const remoteAccess = useRemoteAccess(props.remoteAccess, props.onOpenRemoteAccessSettings);
  const branch = card === undefined ? props.branchFallback : boardBranch(card);
  const facts: DockThreadFacts = {
    ...(props.projectName === undefined ? {} : { project: props.projectName }),
    ...(props.mode === "code" && (branch !== undefined || props.worktree === true)
      ? {
          checkout: {
            ...(branch === undefined ? {} : { branch }),
            worktree: props.worktree === true,
          },
        }
      : {}),
    ...(props.context === undefined ? {} : { context: props.context }),
    ...(props.host === undefined ? {} : { host: props.host }),
  };
  return (
    <DockThreadOverview
      changes={props.mode === "code" ? boardChanges(card, props.onOpenReview) : undefined}
      facts={facts}
      modeLabel={props.mode === "code" ? "Code" : "Work"}
      onOpenEnvironment={props.onOpenEnvironment}
      pullRequest={card?.pullRequestSummaries.items[0]}
      servers={servers}
      onOpenRunning={props.onOpenRunning}
      outputs={outputs}
      backgroundTasks={backgroundTasks}
      remoteAccess={remoteAccess}
      running={props.running}
    />
  );
}

function boardBranch(card: CodeBoardCard): string | undefined {
  if (card.worktree.kind !== "available") return undefined;
  const head = card.worktree.head;
  if (head.kind === "branch") return head.name;
  if (head.kind === "detached") return `Detached ${head.oid.slice(0, 7)}`;
  return undefined;
}

/**
 * A stale observation is left out: the counts may describe a tree the thread
 * has since changed, and Review reads the checkout itself.
 */
function boardChanges(
  card: CodeBoardCard | undefined,
  onOpenReview: () => void,
): DockThreadChanges | undefined {
  const changed = card?.changedFiles;
  if (changed === undefined || changed.kind !== "observed") return undefined;
  if (changed.freshness === "stale" || changed.changedPathCount === 0) return undefined;
  return {
    files: changed.changedPathCount,
    insertions: changed.insertions,
    deletions: changed.deletions,
    onOpenReview,
  };
}

/** The servers this thread's own checkout is serving; leftovers stay in Environment. */
function checkoutServers(
  snapshot: LocalServerSnapshot | undefined,
): ReadonlyArray<DockThreadServer> {
  return (snapshot?.currentCheckout ?? []).map((listener) => ({
    id: String(listener.listenerId),
    label: listener.framework ?? listener.processName,
    port: listener.port,
    listening: listener.health === "listening",
  }));
}

/** Newest first: the thing a turn just wrote leads. */
function threadOutputs(
  documents: ReadonlyArray<WrittenDocument> | undefined,
  onOpen: ((document: WrittenDocument) => void) | undefined,
): ReadonlyArray<DockThreadOutput> {
  if (documents === undefined || onOpen === undefined) return [];
  return documents
    .toReversed()
    .slice(0, MAX_OUTPUTS)
    .map((document) => {
      const id = writtenDocumentId(document);
      if (document.kind === "canvas") {
        return {
          id,
          kind: "canvas",
          label: document.title ?? "Untitled Canvas",
          onOpen: () => onOpen(document),
        };
      }
      const slash = document.path.lastIndexOf("/");
      return {
        id,
        kind: "file",
        label: document.path.slice(slash + 1),
        ...(slash <= 0 ? {} : { detail: document.path.slice(0, slash) }),
        onOpen: () => onOpen(document),
      };
    });
}

/**
 * One read of the listener when the overview opens, never a poll: Settings is
 * where it is watched. Turning it off goes through the same host action the
 * Settings page uses; a refusal leaves the switch where the host says it is.
 */
function useRemoteAccess(
  bridge: RemoteAccessAdministrationBridge | undefined,
  onOpenSettings: (() => void) | undefined,
): DockRemoteAccess | undefined {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEnabled(undefined);
    if (bridge === undefined) return;
    let cancelled = false;
    bridge.getPrivateListenerStatus().then(
      (status) => {
        if (!cancelled) setEnabled(status.enabled);
      },
      () => {
        // A host that cannot say whether it listens gets no switch: a guess
        // would claim a state the person might act on.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  const onDisable = useCallback(() => {
    if (bridge === undefined) return;
    setBusy(true);
    bridge
      .disablePrivateListener()
      .then(
        (status) => setEnabled(status.enabled),
        () => undefined,
      )
      .finally(() => setBusy(false));
  }, [bridge]);
  if (bridge === undefined || onOpenSettings === undefined || enabled === undefined) {
    return undefined;
  }
  return { enabled, busy, onDisable, onOpenSettings };
}

import {
  decodeCodeThreadId,
  type CodeBoardCard,
  type CodeBoardQuery,
  type CodeBoardView,
  type LocalServerSnapshot,
  type ProjectId,
} from "@octant/contracts";
import { useMemo } from "react";
import { useLocalServersController } from "../environment/useLocalServersController";
import {
  DockThreadOverview,
  type DockThreadChanges,
  type DockThreadFacts,
  type DockThreadServer,
} from "./DockThreadOverview";
import type { RunningThreadFact } from "./dockThreadOverviewModel";
import { useThreadBoardCard } from "./useThreadBoardCard";

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
}

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

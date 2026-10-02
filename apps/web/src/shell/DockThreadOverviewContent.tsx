import type { CodeBoardCard, CodeBoardQuery, CodeBoardView, ProjectId } from "@octant/contracts";
import {
  DockThreadOverview,
  type DockThreadChanges,
  type DockThreadFacts,
} from "./DockThreadOverview";
import type { RunningThreadFact } from "./dockThreadOverviewModel";
import { useThreadBoardCard } from "./useThreadBoardCard";

export interface DockThreadOverviewContentProps {
  readonly mode: "work" | "code";
  readonly threadId: string;
  readonly projectId?: ProjectId | undefined;
  readonly projectName?: string | undefined;
  readonly model?: string | undefined;
  readonly access?: string | undefined;
  readonly context?: DockThreadFacts["context"] | undefined;
  /** Whether the thread's own row says it runs on a worktree of the Project. */
  readonly worktree?: boolean | undefined;
  /** The branch the row names, used when the board has not answered yet. */
  readonly branchFallback?: string | undefined;
  readonly running: ReadonlyArray<RunningThreadFact>;
  readonly onOpenRunning: (thread: RunningThreadFact) => void;
  readonly onOpenReview: () => void;
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
    ...(props.model === undefined ? {} : { model: props.model }),
    ...(props.access === undefined ? {} : { access: props.access }),
    ...(props.context === undefined ? {} : { context: props.context }),
  };
  return (
    <DockThreadOverview
      changes={props.mode === "code" ? boardChanges(card, props.onOpenReview) : undefined}
      facts={facts}
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

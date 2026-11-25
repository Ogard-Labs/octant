import {
  MAX_ACTIVE_WORK_LINKS,
  MAX_ACTIVE_WORK_TITLE_LENGTH,
  decodeActiveWorkRow,
  type ActiveWorkKind,
  type ActiveWorkRow,
} from "@octant/contracts/active-work";
import type { AgentRunLifecycleStatus, CodeBoardCard, WorkBoardCard } from "@octant/contracts";
import type { ChatNavigationThread } from "@octant/contracts/chat";
import type { CodeNavigationRuntime } from "@octant/contracts/code";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectSummary } from "@octant/contracts/projects";
import type { ThreadBoardDerivation } from "@octant/contracts/thread-board";
import { deriveThreadBoardStatus } from "@octant/domain/thread-board-policy";

/** The Project facts a row names: its title, and the one GitHub repository its checkout names. */
export interface ActiveWorkProject {
  readonly id: string;
  readonly name: string;
  readonly repository?: { readonly owner: string; readonly repository: string };
}

/** A Project summary as a row's Project, with the repository its checkout names when it names one. */
export function activeWorkProject(project: ProjectSummary | undefined): {
  readonly project?: ActiveWorkProject;
} {
  if (project === undefined) return {};
  return {
    project: {
      id: String(project.id),
      name: project.name,
      ...(project.type !== "code" || project.connectedRepository === undefined
        ? {}
        : { repository: project.connectedRepository }),
    },
  };
}

/** What a host holds about one piece of work. Nothing here is fetched for the row. */
export interface ActiveWorkFacts {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly title: string;
  readonly board: ThreadBoardDerivation;
  readonly updatedAt: string;
  readonly project?: ActiveWorkProject;
  readonly coordinator?: boolean;
  /** The thread's latest routine run has not ended. */
  readonly routineRun?: boolean;
  readonly subagent?: {
    readonly runId: string;
    /** Absent when the reader may not see what the subagent was asked to do. */
    readonly task?: string;
  };
  readonly branch?: string;
  readonly ownWorktree?: boolean;
  readonly pullRequests?: CodeNavigationRuntime["threadPullRequests"];
  readonly issues?: CodeNavigationRuntime["touchedIssues"];
}

/**
 * The one builder of an active-work row. Its state is the board derivation it
 * is given, and it names linked pull requests and issues by identity alone:
 * a title on GitHub or Linear is text an outsider may have written, and this
 * row is also what an agent's read of other work may show.
 */
export function activeWorkRow(facts: ActiveWorkFacts): ActiveWorkRow {
  const title = facts.subagent === undefined ? facts.title : facts.subagent.task;
  return decodeActiveWorkRow({
    kind: kindOf(facts),
    mode: facts.mode,
    threadId: facts.threadId,
    ...(facts.subagent === undefined ? {} : { runId: facts.subagent.runId }),
    ...(title === undefined ? {} : { title: boundedTitle(title) }),
    ...(facts.subagent === undefined ? {} : { parentTitle: boundedTitle(facts.title) }),
    ...(facts.project === undefined
      ? {}
      : { projectId: facts.project.id, projectName: boundedTitle(facts.project.name) }),
    board: facts.board,
    ...(facts.project?.repository === undefined
      ? {}
      : {
          repository: `${facts.project.repository.owner}/${facts.project.repository.repository}`,
        }),
    ...(facts.branch === undefined ? {} : { branch: facts.branch }),
    ...(facts.ownWorktree === true ? { ownWorktree: true } : {}),
    pullRequests: (facts.pullRequests?.items ?? [])
      .slice(0, MAX_ACTIVE_WORK_LINKS)
      .map(({ identity }) => ({
        owner: identity.repositoryOwner,
        repository: identity.repositoryName,
        number: identity.number,
      })),
    issues: (facts.issues?.items ?? []).slice(0, MAX_ACTIVE_WORK_LINKS).map((issue) =>
      issue.forge === "github"
        ? {
            forge: issue.forge,
            owner: issue.owner,
            repository: issue.repository,
            number: issue.number,
          }
        : { forge: issue.forge, identifier: issue.identifier },
    ),
    updatedAt: facts.updatedAt,
  });
}

/** A Code board card, with the links and worktree its sidebar row already carries. */
export function codeActiveWork(input: {
  readonly card: Pick<
    CodeBoardCard,
    "threadId" | "title" | "status" | "statusReason" | "lastMeaningfulActivityAt"
  >;
  readonly updatedAt: string;
  readonly coordinator: boolean;
  readonly project?: ActiveWorkProject;
  readonly runtime?: CodeNavigationRuntime;
}): ActiveWorkFacts {
  const { card, runtime } = input;
  return {
    mode: "code",
    threadId: String(card.threadId),
    title: card.title,
    board: { status: card.status, reason: card.statusReason },
    updatedAt: later(card.lastMeaningfulActivityAt, input.updatedAt),
    coordinator: input.coordinator,
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(runtime?.checkoutChip === undefined
      ? {}
      : {
          branch: runtime.checkoutChip.label,
          ownWorktree: runtime.checkoutChip.checkoutKind === "managed-worktree",
        }),
    ...(runtime?.threadPullRequests === undefined
      ? {}
      : { pullRequests: runtime.threadPullRequests }),
    ...(runtime?.touchedIssues === undefined ? {} : { issues: runtime.touchedIssues }),
  };
}

export function workActiveWork(input: {
  readonly card: Pick<
    WorkBoardCard,
    "threadId" | "title" | "status" | "statusReason" | "lastMeaningfulActivityAt"
  >;
  readonly updatedAt: string;
  readonly project?: ActiveWorkProject;
}): ActiveWorkFacts {
  const { card } = input;
  return {
    mode: "work",
    threadId: String(card.threadId),
    title: card.title,
    board: { status: card.status, reason: card.statusReason },
    updatedAt: later(card.lastMeaningfulActivityAt, input.updatedAt),
    ...(input.project === undefined ? {} : { project: input.project }),
  };
}

/**
 * A Chat thread while it runs or waits on the person. Chat has no board and no
 * delivery, so an idle Chat is no work to list; the same derivation names the
 * two states it can have.
 */
export function chatActiveWork(
  thread: Pick<
    ChatNavigationThread,
    "id" | "title" | "executing" | "awaitingInput" | "updatedAt" | "completedAt"
  >,
  project?: ActiveWorkProject,
): ActiveWorkFacts | undefined {
  const awaitingInput = thread.awaitingInput === true;
  if (thread.completedAt !== undefined || (!thread.executing && !awaitingInput)) return undefined;
  return {
    mode: "chat",
    threadId: String(thread.id),
    title: thread.title,
    board: deriveThreadBoardStatus({
      deliverySatisfaction: "pending",
      executing: thread.executing,
      awaitingInput,
      interrupted: false,
      recovering: false,
    }),
    updatedAt: String(thread.updatedAt),
    ...(project === undefined ? {} : { project }),
  };
}

/**
 * A subagent's own state: queued, starting, and running are In progress, and
 * one waiting is a wait on the person. (The Work board counts a waiting child
 * toward its parent's activity; a row of its own says what it waits on.)
 */
export function subagentBoard(status: AgentRunLifecycleStatus): ThreadBoardDerivation {
  return deriveThreadBoardStatus({
    deliverySatisfaction: "pending",
    executing: status === "queued" || status === "starting" || status === "running",
    awaitingInput: status === "waiting",
    interrupted: false,
    recovering: false,
  });
}

function kindOf(facts: ActiveWorkFacts): ActiveWorkKind {
  if (facts.subagent !== undefined) return "subagent";
  if (facts.coordinator === true) return "coordinator";
  return facts.routineRun === true ? "routine-run" : "thread";
}

function boundedTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length <= MAX_ACTIVE_WORK_TITLE_LENGTH
    ? trimmed
    : trimmed.slice(0, MAX_ACTIVE_WORK_TITLE_LENGTH).trim();
}

function later(left: string | null, right: string): string {
  return left !== null && Date.parse(left) > Date.parse(right) ? left : right;
}

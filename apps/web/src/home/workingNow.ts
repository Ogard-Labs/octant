import type {
  AgentRunCenterSummary,
  CodeBoardCard,
  OctantMode,
  ThreadLiveStep,
} from "@octant/contracts";
import { isAgentRunActiveStatus } from "@octant/domain";
import { isLoopbackHostname } from "../shell/capabilityTransport";
import type { ChatThreadNavigationItem, ThreadProviderIdentity } from "../shell/navigationModel";
import { isRunningThread } from "../shell/runningNow";

/** Rows the card lists before it says "+N more". */
export const WORKING_NOW_ROW_LIMIT = 5;

/**
 * One thing in progress. Every field is something the host already projects;
 * a field the host does not know is absent rather than filled in.
 */
export interface WorkingNowRow {
  readonly key: string;
  readonly mode: OctantMode;
  /** The thread a click opens: a Code child run opens its own worktree thread. */
  readonly threadId: string;
  readonly title: string;
  readonly projectName?: string;
  /**
   * The latest line about what is happening: the running turn's own step when
   * the host reports one, otherwise the board's activity line or a running
   * agent's task.
   */
  readonly step?: string;
  /**
   * `tool` is a tool and its redacted argument, shown as code; `status` is the
   * turn waiting on the person, shown as prose. Absent for a line the board or
   * an agent run supplied.
   */
  readonly stepKind?: "tool" | "status";
  /**
   * When the work began: a turn's start as the host reports it, or an agent
   * run's creation. A thread whose host reports neither says when it last
   * moved instead.
   */
  readonly startedAt?: string;
  readonly activeAt?: string;
  readonly provider?: ThreadProviderIdentity;
  /** The host the work runs on, only when that is not this computer. */
  readonly host?: string;
}

/** What the Code board adds to a running Code thread. */
export interface WorkingNowBoardFacts {
  readonly step?: string;
  /** How far the thread's live plan has come, such as "Plan: 2 of 5 steps done". */
  readonly planProgress?: string;
  readonly activeAt?: string;
}

export function boardFactsByThread(
  cards: ReadonlyArray<CodeBoardCard>,
): ReadonlyMap<string, WorkingNowBoardFacts> {
  return new Map(
    cards
      .filter((card) => card.executing)
      .map((card) => [
        String(card.threadId),
        {
          ...(card.childAgents.latestSummary === undefined
            ? {}
            : { step: card.childAgents.latestSummary }),
          ...(card.planProgress.kind === "present" && card.planProgress.total > 0
            ? {
                planProgress: `Plan: ${String(card.planProgress.done)} of ${String(card.planProgress.total)} steps done`,
              }
            : {}),
          ...(card.lastMeaningfulActivityAt === null
            ? {}
            : { activeAt: card.lastMeaningfulActivityAt }),
        },
      ]),
  );
}

export interface WorkingNowThread {
  readonly mode: OctantMode;
  readonly thread: ChatThreadNavigationItem;
}

export interface WorkingNowInput {
  readonly threads: ReadonlyArray<WorkingNowThread>;
  /** The modes this start screen speaks for; a run in another mode is not listed. */
  readonly modes: ReadonlyArray<OctantMode>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly providers: ReadonlyMap<string, ThreadProviderIdentity>;
  readonly boardFacts: ReadonlyMap<string, WorkingNowBoardFacts>;
  /** Active agent runs from the AgentRun projection; absent until read. */
  readonly runs: ReadonlyArray<AgentRunCenterSummary> | undefined;
  readonly host?: string;
}

/** The provider a thread row runs on: the mark the shell attached, else its instance looked up. */
export function threadProvider(
  thread: Pick<ChatThreadNavigationItem, "provider" | "providerInstanceId">,
  providers: ReadonlyMap<string, ThreadProviderIdentity>,
): ThreadProviderIdentity | undefined {
  return (
    thread.provider ??
    (thread.providerInstanceId === undefined ? undefined : providers.get(thread.providerInstanceId))
  );
}

/** A running turn's own step, in words a row can show. */
export function liveStepLine(step: ThreadLiveStep): {
  readonly text: string;
  readonly kind: "tool" | "status";
} {
  if (step.kind === "waiting") {
    return {
      kind: "status",
      text: step.reason === "approval" ? "Waiting for approval" : "Waiting for your answer",
    };
  }
  return {
    kind: "tool",
    text: step.argument === undefined ? step.tool : `${step.tool}: ${step.argument}`,
  };
}

function agentLine(run: AgentRunCenterSummary): string {
  const firstLine = run.task.split("\n", 1)[0] ?? run.task;
  return `${run.role}: ${firstLine.trim()}`;
}

/**
 * The threads and agent runs in progress across Projects, most recently moved
 * first. A running thread is one row; its active agent runs fold into the
 * row's step line instead of listing the same work twice. A run whose thread
 * is not itself executing (the parent is resting while its agent works) is its
 * own row, opening the thread the run belongs to.
 */
export function buildWorkingNowRows(input: WorkingNowInput): ReadonlyArray<WorkingNowRow> {
  const activeRuns = (input.runs ?? []).filter(
    (run) => isAgentRunActiveStatus(run.lifecycleStatus) && input.modes.includes(run.mode),
  );
  const running = input.threads.filter(({ thread }) => isRunningThread(thread));
  const runningIds = new Set(running.map(({ thread }) => thread.threadId));
  // A run reports under the running thread it belongs to: its own worktree
  // thread when that is a row, otherwise its parent.
  const runsByThread = new Map<string, AgentRunCenterSummary[]>();
  const claimedRuns = new Set<string>();
  for (const run of activeRuns) {
    const home = [run.childThreadId, run.parentThreadId]
      .map((id) => (id === undefined ? undefined : String(id)))
      .find((id) => id !== undefined && runningIds.has(id));
    if (home === undefined) continue;
    claimedRuns.add(String(run.runId));
    runsByThread.set(home, [...(runsByThread.get(home) ?? []), run]);
  }

  const rows: WorkingNowRow[] = [];
  for (const { mode, thread } of running) {
    const facts = input.boardFacts.get(thread.threadId);
    const own = runsByThread.get(thread.threadId) ?? [];
    const latestRun = own.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    // The most live line the host has: the turn's own step, then its activity
    // line, then the agent run working in the thread, then how far the plan
    // has come.
    const live = thread.liveStep === undefined ? undefined : liveStepLine(thread.liveStep);
    const step =
      live?.text ??
      facts?.step ??
      (latestRun === undefined
        ? undefined
        : own.length > 1
          ? `${String(own.length)} agents: ${agentLine(latestRun)}`
          : agentLine(latestRun)) ??
      facts?.planProgress;
    const projectName =
      thread.projectId === undefined ? undefined : input.projectNames.get(thread.projectId);
    const provider = threadProvider(thread, input.providers);
    const activeAt = facts?.activeAt ?? thread.updatedAt;
    rows.push({
      key: `thread:${mode}:${thread.threadId}`,
      mode,
      threadId: thread.threadId,
      title: thread.title,
      ...(projectName === undefined ? {} : { projectName }),
      ...(step === undefined ? {} : { step }),
      ...(live === undefined ? {} : { stepKind: live.kind }),
      ...(thread.turnStartedAt === undefined ? {} : { startedAt: thread.turnStartedAt }),
      ...(activeAt === undefined ? {} : { activeAt }),
      ...(provider === undefined ? {} : { provider }),
      ...(input.host === undefined ? {} : { host: input.host }),
    });
  }

  for (const run of activeRuns) {
    if (claimedRuns.has(String(run.runId))) continue;
    const projectName =
      run.projectId === undefined ? undefined : input.projectNames.get(String(run.projectId));
    const provider = input.providers.get(String(run.route.executionProviderInstanceId));
    rows.push({
      key: `run:${String(run.runId)}`,
      mode: run.mode,
      threadId: String(run.childThreadId ?? run.parentThreadId),
      title: run.parentThreadTitle,
      ...(projectName === undefined ? {} : { projectName }),
      step: agentLine(run),
      startedAt: run.createdAt,
      activeAt: run.updatedAt,
      ...(provider === undefined ? {} : { provider }),
      ...(input.host === undefined ? {} : { host: input.host }),
    });
  }

  return rows.toSorted((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""));
}

/**
 * The host to name on a row, which is only a host that is not this computer.
 * A window whose server is on loopback is reading this machine, so a label
 * would say nothing; a paired or browser window reading another machine names
 * it so a row is never mistaken for local work.
 */
export function remoteHostLabel(
  serverUrl: string,
  hostName: string | undefined,
): string | undefined {
  if (hostName === undefined) return undefined;
  try {
    return isLoopbackHostname(new URL(serverUrl).hostname) ? undefined : hostName;
  } catch {
    return undefined;
  }
}

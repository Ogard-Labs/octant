import type {
  PendingRequest,
  ProjectId,
  WindowId,
  WorkThread,
  WorkThreadId,
  WorkTurnState,
} from "@octant/contracts";
import { parseTurnDecision, turnDecisionIsOpen } from "@octant/domain";

/**
 * The decision a Work thread's latest turn closed with, as a pending request
 * whose answer is the thread's next turn. The reply is the turn's normalized
 * `response`, the text its transcript shows. Only the latest turn speaks, and
 * only once it completed: a turn that started since, or one that was
 * interrupted or failed (a turn that died with the process is settled
 * interrupted on restart), closes the decision. The answer carries the
 * authority the composer would send now; the host checks it again when the
 * turn starts.
 */
export function workTurnDecision(
  thread: WorkThread,
  turns: ReadonlyArray<WorkTurnState>,
): Extract<PendingRequest, { readonly mode: "work"; readonly kind: "decision" }> | undefined {
  const latest = turns.at(-1);
  if (
    latest === undefined ||
    !turnDecisionIsOpen({
      latestTurnCompleted: latest.status === "completed",
      archived: thread.lifecycle !== "active",
      completed: thread.completedAt !== undefined,
      snoozed: thread.snooze !== undefined,
    })
  ) {
    return undefined;
  }
  const decision = parseTurnDecision(latest.response ?? "");
  if (decision === undefined) return undefined;
  return {
    mode: "work",
    kind: "decision",
    projectId: thread.projectId,
    threadId: thread.id,
    threadTitle: thread.title,
    requestedAt: latest.updatedAt,
    text: decision.ask,
    options: decision.options,
    answer: {
      threadId: thread.id,
      turnId: latest.turnId,
      authority: {
        ...latest.authority,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        ...(thread.bindingRevisionId === undefined
          ? {}
          : { bindingRevisionId: thread.bindingRevisionId }),
        ...(thread.workingDirectory === undefined
          ? {}
          : { workingDirectory: thread.workingDirectory }),
      },
    },
  };
}

export interface WorkTurnDecisionSources {
  readonly projects: (windowId: WindowId) => Promise<{
    readonly active: ReadonlyArray<{ readonly id: ProjectId; readonly type: string }>;
  }>;
  /** The window's Work thread list: a thread it cannot open is never offered. */
  readonly threads: (
    windowId: WindowId,
  ) => Promise<{ readonly threads: ReadonlyArray<WorkThread> }>;
  readonly turns: (threadId: WorkThreadId) => ReadonlyArray<WorkTurnState>;
}

/**
 * Every open Work decision this window could answer: the same Work Project
 * access and thread list the Work send command checks. The caller orders and
 * bounds the result.
 */
export async function listWorkTurnDecisions(
  sources: WorkTurnDecisionSources,
  windowId: WindowId,
): Promise<ReadonlyArray<PendingRequest>> {
  const [projects, { threads }] = await Promise.all([
    sources.projects(windowId),
    sources.threads(windowId),
  ]);
  const workProjects = new Set(
    projects.active
      .filter((project) => project.type === "work")
      .map((project) => String(project.id)),
  );
  const pending: PendingRequest[] = [];
  for (const thread of threads) {
    if (!workProjects.has(String(thread.projectId))) continue;
    const decision = workTurnDecision(thread, sources.turns(thread.id));
    if (decision !== undefined) pending.push(decision);
  }
  return pending;
}

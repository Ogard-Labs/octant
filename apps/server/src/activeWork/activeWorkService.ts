import { MAX_ACTIVE_WORK_ROWS, type ActiveWork } from "@octant/contracts/active-work";
import type { AgentRunLifecycleStatus, ProductSurfaceSettings, WindowId } from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";
import { enabledModes } from "@octant/domain";
import {
  compareThreadBoardActivityDescending,
  threadBoardProjectStatusRank,
} from "@octant/domain/thread-board-policy";
import { principalIsHubIntroduced, type ClientPrincipal } from "../clientPrincipal";
import { hubActRefusal, type HubActScopePort } from "../hub/hubActScope";
import { activeWorkRow, subagentBoard, type ActiveWorkFacts } from "./activeWorkRow";

/** A child run that has not ended, under the thread it works for. */
export interface ActiveWorkSubagent {
  readonly runId: string;
  readonly parentThreadId: string;
  readonly mode: OctantMode;
  readonly task: string;
  readonly lifecycleStatus: AgentRunLifecycleStatus;
  /** Why a waiting run waits, as the run records it. */
  readonly recoveryReason?: string;
  readonly updatedAt: string;
  /** Whether this window may read the run itself, by the Agents page's own rule. */
  readonly readableBy: (windowId: WindowId) => boolean;
}

export interface ActiveWorkSources {
  readonly readSettings: () => ProductSurfaceSettings;
  /**
   * Each mode's threads under that mode's own sidebar read, so a thread the
   * reader could not list is never a fact here.
   */
  readonly code: (windowId: WindowId) => Promise<ReadonlyArray<ActiveWorkFacts>>;
  readonly work: (windowId: WindowId) => Promise<ReadonlyArray<ActiveWorkFacts>>;
  /** Every active Chat thread, idle ones included: an idle Chat may hold a running subagent. */
  readonly chat: () => ReadonlyArray<{
    readonly threadId: string;
    readonly title: string;
    readonly project?: NonNullable<ActiveWorkFacts["project"]>;
    readonly facts: ActiveWorkFacts | undefined;
  }>;
  readonly subagents: () => ReadonlyArray<ActiveWorkSubagent>;
  /** Threads whose routine run has not ended. */
  readonly routineThreadIds: () => ReadonlySet<string>;
  readonly hubActScope: () => HubActScopePort | undefined;
}

/**
 * The work on this host that is not Done and that the reader may already
 * open. It adds no authority and keeps no state: the threads are each mode's
 * own sidebar list, the states are the boards' own, and a subagent is listed
 * only under a thread already listed.
 */
export class ActiveWorkService {
  readonly #sources: ActiveWorkSources;

  constructor(sources: ActiveWorkSources) {
    this.#sources = sources;
  }

  async list(windowId: WindowId, principal: ClientPrincipal): Promise<ActiveWork> {
    const modes = enabledModes(this.#sources.readSettings());
    const [work, allCode] = await Promise.all([
      modes.includes("work") ? this.#sources.work(windowId) : [],
      modes.includes("code") ? this.#sources.code(windowId) : [],
    ]);
    const chat = modes.includes("chat") ? this.#sources.chat() : [];
    const code = this.#insideAct(allCode, principal);

    const routineThreadIds = this.#sources.routineThreadIds();
    const threads = [
      ...code,
      ...work,
      ...chat.flatMap((thread) => (thread.facts === undefined ? [] : [thread.facts])),
    ];
    const parents = new Map<string, Pick<ActiveWorkFacts, "mode" | "title" | "project">>();
    for (const parent of [
      ...code,
      ...work,
      ...chat.map(({ facts: _facts, ...thread }) => ({ ...thread, mode: "chat" as const })),
    ])
      parents.set(parent.threadId, parent);
    const subagents = this.#sources.subagents().flatMap((subagent): ActiveWorkFacts[] => {
      const parent = parents.get(subagent.parentThreadId);
      if (parent === undefined || parent.mode !== subagent.mode) return [];
      const readable = principal.kind === "local-window" && subagent.readableBy(windowId);
      // A Work or Code board already counts this subagent for the reader; a
      // Chat thread's subagents show only to a window that may read them.
      if (subagent.mode === "chat" && !readable) return [];
      return [
        {
          mode: subagent.mode,
          threadId: subagent.parentThreadId,
          title: parent.title,
          board: subagentBoard(subagent.lifecycleStatus, subagent.recoveryReason),
          updatedAt: subagent.updatedAt,
          ...(parent.project === undefined ? {} : { project: parent.project }),
          subagent: {
            runId: subagent.runId,
            ...(readable ? { task: subagent.task } : {}),
          },
        },
      ];
    });

    const active = [
      ...threads.map((facts) =>
        routineThreadIds.has(facts.threadId) ? { ...facts, routineRun: true } : facts,
      ),
      ...subagents,
    ]
      .filter((facts) => facts.board.status !== "done")
      .toSorted(
        (left, right) =>
          threadBoardProjectStatusRank(left.board.status) -
            threadBoardProjectStatusRank(right.board.status) ||
          compareThreadBoardActivityDescending(
            { lastMeaningfulActivityAtMs: Date.parse(left.updatedAt) },
            { lastMeaningfulActivityAtMs: Date.parse(right.updatedAt) },
          ),
      );
    return {
      rows: active.slice(0, MAX_ACTIVE_WORK_ROWS).map(activeWorkRow),
      truncated: active.length > MAX_ACTIVE_WORK_ROWS,
    };
  }

  /**
   * A device only the hub introduced is not told of a Code Project the
   * member's Act item leaves out, exactly as its Projects read is not, and the
   * rows there would name one.
   */
  #insideAct(
    code: ReadonlyArray<ActiveWorkFacts>,
    principal: ClientPrincipal,
  ): ReadonlyArray<ActiveWorkFacts> {
    if (!principalIsHubIntroduced(principal)) return code;
    const scope = this.#sources.hubActScope();
    return code.filter((facts) => hubActRefusal(scope, facts.project?.id, "start") === undefined);
  }
}

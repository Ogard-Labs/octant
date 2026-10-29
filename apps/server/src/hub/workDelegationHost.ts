// The receiving spoke's delegation host for Work: an ordinary Work thread in
// the named Project, created and started the way a routine's thread is, under
// this host's own scope. It shows in this host's sidebar and board like any
// Work thread, runs ask-first in the Project folder with this host's provider
// sign-ins, and is marked Done only by a person.
//
// Code is not carried here. A Code thread needs a managed worktree and a
// delivery target a person confirmed, and a peer's request cannot stand in for
// that person, so a Code Project reports no delegable mode and the request is
// refused.

import { randomUUID } from "node:crypto";
import {
  WorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type BindingRevisionId,
  type Project,
  type ProjectId,
  type WindowId,
  type WorkTurnState,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { DelegationProjectAuthority } from "@octant/domain";
import { Schema } from "effect";
import type { ChildReading, PeerDelegationHost, StartedThread } from "./peerDelegationService";

const MAX_TITLE = 80;
const decodeWorkThreadId = Schema.decodeUnknownSync(WorkThreadId);

/** What the host reads of a Project; a full `Project` has it. */
export interface DelegationProjectFacts {
  readonly type: Project["type"];
  readonly lifecycle: Project["lifecycle"];
  readonly bindingHistory?: ReadonlyArray<{ readonly revisionId: BindingRevisionId }>;
}

/** What the host reads of a Work turn; a `WorkTurnState` has it. */
export type DelegationTurnFacts = Pick<
  WorkTurnState,
  "requestId" | "threadId" | "turnId" | "status" | "updatedAt"
> & { readonly response?: string | undefined };

export interface WorkDelegationServices {
  readonly readProject: (projectId: ProjectId) => DelegationProjectFacts | undefined;
  /** Whether Work is turned on in this host's settings right now; read live, never cached. */
  readonly isWorkEnabled: () => boolean;
  readonly threads: {
    readonly execute: (scope: WindowId, command: unknown) => Promise<unknown>;
    readonly bootstrap: (scope: WindowId) => Promise<{
      readonly settings?:
        | {
            readonly defaultProviderInstanceId?: string | undefined;
            readonly defaultModelId?: string | undefined;
          }
        | undefined;
    }>;
  };
  readonly turns: {
    readonly startFirstTurn: (
      scope: WindowId,
      command: unknown,
      options?: {
        readonly holdAskFirst?: boolean;
        readonly admissionCurrent?: () => boolean;
      },
    ) => Promise<{ readonly kind: string }>;
    readonly turns: (
      scope: WindowId,
      threadId: ReturnType<typeof decodeWorkThreadId>,
    ) => Promise<ReadonlyArray<DelegationTurnFacts>>;
    readonly cancelFirstTurn: (
      scope: WindowId,
      command: unknown,
    ) => Promise<{ readonly kind: string }>;
  };
  /** The host's own scope, which no window or device can claim. */
  readonly scope: WindowId;
  readonly uuid?: () => string;
}

export function createWorkDelegationHost(services: WorkDelegationServices): PeerDelegationHost {
  const uuid = services.uuid ?? randomUUID;
  return {
    projectAuthority: (projectId): DelegationProjectAuthority | undefined => {
      const project = services.readProject(projectId);
      if (project === undefined || project.lifecycle !== "active" || project.type === "chat") {
        return undefined;
      }
      // Turning Work off keeps its Projects but hides them from peers.
      if (project.type === "work" && !services.isWorkEnabled()) return undefined;
      // Work never reaches Full access, and Code is not delegable on this host.
      return {
        projectId,
        modes: project.type === "work" ? ["work"] : [],
        ceiling: "approval-gated",
      };
    },

    startThread: async (input): Promise<StartedThread> => {
      const project = services.readProject(input.projectId);
      if (project?.type !== "work" || project.lifecycle !== "active") {
        return { status: "refused", kind: "project-unavailable" };
      }
      if (input.authority.mode !== "work" || !services.isWorkEnabled()) {
        return { status: "refused", kind: "mode-unavailable" };
      }
      // Work asks first; it has no read-only posture to run a plan-only request at.
      if (input.authority.posture !== "approval-gated") {
        return { status: "refused", kind: "posture-unavailable" };
      }
      // A named provider profile is not resolved here: the work runs on the
      // default this host's Work settings name, with this host's sign-ins.
      if (input.authority.profileId !== undefined) {
        return { status: "refused", kind: "provider-unavailable" };
      }
      const binding = project.bindingHistory?.at(-1);
      const settings = (await services.threads.bootstrap(services.scope)).settings;
      if (
        binding === undefined ||
        settings?.defaultProviderInstanceId === undefined ||
        settings.defaultModelId === undefined
      ) {
        return { status: "refused", kind: "provider-unavailable" };
      }
      // The sender's grant may have ended while this start waited on settings.
      if (!input.admissionCurrent()) return { status: "refused", kind: "delegation-not-granted" };
      const threadId = uuid();
      try {
        const created = await services.threads.execute(services.scope, {
          kind: "create-work-thread",
          threadId,
          projectId: input.projectId,
          title: titleFor(input.senderName, input.task),
          providerInstanceId: settings.defaultProviderInstanceId,
          modelId: settings.defaultModelId,
          hostId: LOCAL_HOST_ID,
          bindingRevisionId: binding.revisionId,
          workingDirectory: ".",
        });
        if (!wasCreated(created)) return { status: "refused", kind: "start-failed" };
        // Work may have been turned off while the thread was being created.
        if (!services.isWorkEnabled()) return { status: "refused", kind: "mode-unavailable" };
        const turnId = uuid();
        const started = await services.turns.startFirstTurn(
          services.scope,
          {
            kind: "start-work-thread-turn",
            requestId: decodeWorkTurnRequestId(uuid()),
            threadId,
            turnId: decodeWorkTurnId(turnId),
            prompt: input.task,
            authority: {
              hostId: LOCAL_HOST_ID,
              projectId: input.projectId,
              bindingRevisionId: binding.revisionId,
              workingDirectory: ".",
              confinementPosture: "project-root-confined",
              providerInstanceId: settings.defaultProviderInstanceId,
              modelId: settings.defaultModelId,
            },
          },
          // Nobody asked for this turn at this host, so it asks before every
          // edit whatever the host's Work default is.
          // The turn service rechecks this after it prepares and before the
          // provider runs, so a grant ended meanwhile starts no work.
          { holdAskFirst: true, admissionCurrent: input.admissionCurrent },
        );
        return started.kind === "accepted"
          ? { status: "started", threadId, turnId }
          : { status: "refused", kind: "start-failed" };
      } catch {
        return {
          status: "refused",
          kind: input.admissionCurrent() ? "start-failed" : "delegation-not-granted",
        };
      }
    },

    readThread: async (threadId, turnId): Promise<ChildReading | undefined> => {
      const turn = await delegatedTurn(services, threadId, turnId);
      if (turn === undefined) return undefined;
      return {
        state: childStateOf(turn),
        ...(turn.response === undefined ? {} : { finalMessage: turn.response }),
        // A Work turn reports the paths it changed, not content digests, so no
        // artifact reference is made up for them.
        artifacts: [],
        completedAt: turn.updatedAt,
      };
    },

    interrupt: async (threadId, turnId) => {
      const turn = await delegatedTurn(services, threadId, turnId);
      if (turn === undefined) return "unavailable";
      if (childStateOf(turn) !== "running" && childStateOf(turn) !== "waiting-for-approval") {
        return "already-finished";
      }
      try {
        const cancelled = await services.turns.cancelFirstTurn(services.scope, {
          kind: "cancel-work-turn",
          requestId: turn.requestId,
          threadId: turn.threadId,
          turnId: turn.turnId,
        });
        return cancelled.kind === "turn-cancelled" ? "interrupted" : "already-finished";
      } catch {
        return "unavailable";
      }
    },
  };
}

/**
 * The turn the delegation started, not the thread's latest: a person here may
 * continue the thread, and their follow-up is neither the peer's result nor
 * something the peer may cancel.
 */
async function delegatedTurn(
  services: WorkDelegationServices,
  threadId: string,
  turnId: string,
): Promise<DelegationTurnFacts | undefined> {
  try {
    return (await services.turns.turns(services.scope, decodeWorkThreadId(threadId))).find(
      (turn) => String(turn.turnId) === turnId,
    );
  } catch {
    return undefined;
  }
}

/** A create command's answer is the created thread, or a failure that has no `kind`. */
function wasCreated(answer: unknown): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    "kind" in answer &&
    answer.kind === "thread-created"
  );
}

function titleFor(senderName: string, task: string): string {
  const firstLine = task.split("\n", 1)[0]?.trim() ?? "";
  const title = `${senderName}: ${firstLine}`;
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

/** Narrows a state a Work turn reports to the one a delegating spoke is told. */
function childStateOf(turn: DelegationTurnFacts): ChildReading["state"] {
  switch (turn.status) {
    case "accepted":
    case "running":
      return "running";
    case "waiting":
      return "waiting-for-approval";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

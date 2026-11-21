// The receiving spoke's delegation host for Code (hub and spokes, decision
// H25): a managed Code thread in a Code Project whose person marked it as
// taking delegated Code work, on a branch of its own named from the request,
// approval-gated, and marked as having read outside content from its first
// turn, because its task is another member's text. The delivery target is the
// one the person confirmed with the mark; nothing in the request can change it.

import { randomUUID } from "node:crypto";
import type {
  CodeProjectDelegatedCode,
  DelegationRequestId,
  Project,
  ProjectId,
} from "@octant/contracts";
import type { DelegationProjectAuthority } from "@octant/domain";
import type { ChildReading, PeerDelegationHost, StartedThread } from "./peerDelegationService";

const MAX_TITLE = 80;
const MAX_SLUG = 40;

/** What the host reads of a Project; a full `Project` has it. */
export interface CodeDelegationProjectFacts {
  readonly type: Project["type"];
  readonly lifecycle: Project["lifecycle"];
  readonly delegatedCode?: CodeProjectDelegatedCode | undefined;
  readonly bindingHistory?: ReadonlyArray<{ readonly revisionId: string }>;
}

export interface CodeDelegationServices {
  readonly readProject: (projectId: ProjectId) => CodeDelegationProjectFacts | undefined;
  /**
   * The provider and model a new Code thread in the Project would start on:
   * the first provider in the person's order the Project allows, at its own
   * default model. Undefined when none can run Code there.
   */
  readonly defaultProvider: (
    projectId: ProjectId,
  ) => { readonly providerInstanceId: string; readonly modelId: string } | undefined;
  /**
   * The `owner/repository` the named remote of the Project's checkout points
   * at, as a pull request names its base. Undefined when the remote is missing
   * or is not a GitHub repository.
   */
  readonly deliveryRepository: (
    projectId: ProjectId,
    remoteName: string,
  ) => Promise<string | undefined>;
  /** Creates the managed thread with the outside-content mark it starts with. */
  readonly createThread: (
    command: unknown,
    mark: { readonly sourceLabel: string; readonly contentReference: string },
  ) => Promise<{
    readonly kind: string;
    readonly thread?: { readonly id: string; readonly checkoutId?: string | undefined };
  }>;
  readonly startTurn: (input: {
    readonly threadId: string;
    readonly checkoutId: string;
    readonly operationId: string;
    readonly sessionId: string;
    readonly prompt: string;
    /**
     * The live admission check, asked again immediately before the provider
     * turn starts, after any awaited preparation.
     */
    readonly admissionCurrent: () => boolean;
  }) => Promise<"accepted" | "refused">;
  /** The delegated turn, not whatever turn the thread has run since. */
  readonly readTurn: (threadId: string, operationId: string) => Promise<ChildReading | undefined>;
  /** Stops the delegated turn only; a later turn on the thread is never touched. */
  readonly cancelTurn: (
    threadId: string,
    operationId: string,
  ) => Promise<"interrupted" | "already-finished" | "unavailable">;
  readonly uuid?: () => string;
}

/**
 * The delegated thread's branch: readable from the task, unique from the
 * request, under a prefix no person's branch uses.
 */
export function delegatedCodeBranch(requestId: DelegationRequestId, task: string): string {
  const slug =
    (task.split("\n", 1)[0] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG)
      .replace(/-+$/g, "") || "task";
  return `octant/delegated/${slug}-${String(requestId).replaceAll("-", "").slice(0, 12)}`;
}

export function createCodeDelegationHost(services: CodeDelegationServices): PeerDelegationHost {
  const uuid = services.uuid ?? randomUUID;
  return {
    projectAuthority: (projectId): DelegationProjectAuthority | undefined => {
      const project = services.readProject(projectId);
      if (project?.type !== "code" || project.lifecycle !== "active") return undefined;
      // Only a Project its person marked takes Code from a peer, and at most
      // asking first: Full access is never reached through delegation here.
      if (project.delegatedCode === undefined) return undefined;
      return { projectId, modes: ["code"], ceiling: "approval-gated" };
    },

    startThread: async (input): Promise<StartedThread> => {
      const project = services.readProject(input.projectId);
      const mark = project?.delegatedCode;
      if (project?.type !== "code" || project.lifecycle !== "active" || mark === undefined) {
        return { status: "refused", kind: "project-unavailable" };
      }
      if (input.authority.mode !== "code") return { status: "refused", kind: "mode-unavailable" };
      if (input.authority.posture !== "approval-gated") {
        return { status: "refused", kind: "posture-unavailable" };
      }
      // A named provider profile is not resolved here; the thread runs on the
      // provider this host's person ranks first for the Project.
      if (input.authority.profileId !== undefined) {
        return { status: "refused", kind: "provider-unavailable" };
      }
      const binding = project.bindingHistory?.at(-1);
      const provider = services.defaultProvider(input.projectId);
      if (binding === undefined || provider === undefined) {
        return { status: "refused", kind: "provider-unavailable" };
      }
      // A pull request names its base as `owner/repository`, so a pull-request
      // outcome needs the repository the confirmed remote points at; without
      // one the outcome could never be reached. Other outcomes keep the
      // Project's own identity, as other managed threads here do.
      const repository = await services.deliveryRepository(input.projectId, mark.remoteName);
      const wantsPullRequest = mark.outcomeKind === "opened-pr" || mark.outcomeKind === "merged-pr";
      if (wantsPullRequest && repository === undefined) {
        return { status: "refused", kind: "start-failed" };
      }
      if (!input.admissionCurrent()) return { status: "refused", kind: "delegation-not-granted" };
      const threadId = uuid();
      try {
        const created = await services.createThread(
          {
            kind: "create-managed-code-thread",
            threadId,
            projectId: input.projectId,
            bindingRevisionId: binding.revisionId,
            title: titleFor(input.senderName, input.task),
            providerInstanceId: provider.providerInstanceId,
            modelId: provider.modelId,
            executionPolicy: "approval-gated",
            permissionPersistence: "current-session",
            deliveryTarget: {
              branchIntent: delegatedCodeBranch(input.requestId, input.task),
              remoteName: mark.remoteName,
              proposedBaseRepository: repository ?? String(input.projectId),
              proposedBaseBranch: mark.baseBranch,
              outcomeKind: mark.outcomeKind,
              confirmedAt: mark.confirmedAt,
            },
            sourceBranch: mark.baseBranch,
            startFromOrigin: true,
            remoteName: mark.remoteName,
          },
          {
            sourceLabel: `Task delegated by ${input.senderName}`,
            contentReference: `delegation:${String(input.requestId)}`,
          },
        );
        const checkoutId = created.thread?.checkoutId;
        if (created.kind !== "managed-thread-created" || checkoutId === undefined) {
          return { status: "refused", kind: "start-failed" };
        }
        // The sender's grant may have ended while the worktree was made.
        if (!input.admissionCurrent()) {
          return { status: "refused", kind: "delegation-not-granted" };
        }
        const operationId = uuid();
        const started = await services.startTurn({
          threadId: created.thread?.id ?? threadId,
          checkoutId,
          operationId,
          sessionId: uuid(),
          prompt: input.task,
          admissionCurrent: input.admissionCurrent,
        });
        if (started === "refused" && !input.admissionCurrent()) {
          return { status: "refused", kind: "delegation-not-granted" };
        }
        return started === "accepted"
          ? { status: "started", threadId: created.thread?.id ?? threadId, turnId: operationId }
          : { status: "refused", kind: "start-failed" };
      } catch {
        return {
          status: "refused",
          kind: input.admissionCurrent() ? "start-failed" : "delegation-not-granted",
        };
      }
    },

    readThread: (threadId, turnId) => services.readTurn(threadId, turnId),
    interrupt: (threadId, turnId) => services.cancelTurn(threadId, turnId),
  };
}

/**
 * One host for every mode a peer may delegate: each Project is judged by the
 * host for its type, so a Work Project never reaches the Code host or the
 * reverse.
 */
export function delegationHostByProjectType(input: {
  readonly readType: (projectId: ProjectId) => Project["type"] | undefined;
  readonly work: PeerDelegationHost;
  readonly code: PeerDelegationHost;
  /** Which host started a thread, kept so reads and stops go back to it. */
  readonly codeThreads: { readonly has: (threadId: string) => boolean };
}): PeerDelegationHost {
  const hostFor = (projectId: ProjectId) =>
    input.readType(projectId) === "code" ? input.code : input.work;
  const hostForThread = (threadId: string) =>
    input.codeThreads.has(threadId) ? input.code : input.work;
  return {
    projectAuthority: (projectId) => hostFor(projectId).projectAuthority(projectId),
    startThread: (start) => hostFor(start.projectId).startThread(start),
    readThread: (threadId, turnId) => hostForThread(threadId).readThread(threadId, turnId),
    interrupt: (threadId, turnId) => hostForThread(threadId).interrupt(threadId, turnId),
  };
}

function titleFor(senderName: string, task: string): string {
  const firstLine = task.split("\n", 1)[0]?.trim() ?? "";
  const title = `${senderName}: ${firstLine}`;
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

import { createHash } from "node:crypto";
import type {
  CodeThread,
  OwnerThreadWake,
  OwnerThreadWakeChangeRequest,
  Project,
} from "@octant/contracts";
import type { CodeService } from "../code/codeService";

export type OwnerThreadWakeRefusalKind = "not-found" | "not-a-worker" | "wake-stale" | "refused";
export type OwnerThreadWakeRead =
  | { readonly status: "read"; readonly wake: OwnerThreadWake }
  | { readonly status: "refused"; readonly kind: OwnerThreadWakeRefusalKind };
export type OwnerThreadWakeChange =
  | { readonly status: "changed"; readonly wake: OwnerThreadWake }
  | { readonly status: "refused"; readonly kind: OwnerThreadWakeRefusalKind };
/** Host facts from the authenticated owner route, never decoded from the request body. */
export interface OwnerThreadWakeAuthority {
  readonly ownerMemberId: string;
  /** The request carried its own fresh unlock, not an open administration session. */
  readonly fresh: boolean;
}
export interface OwnerThreadWakeHost {
  readonly read: (threadId: CodeThread["id"]) => Promise<OwnerThreadWakeRead>;
  readonly change: (
    request: OwnerThreadWakeChangeRequest,
    authority: OwnerThreadWakeAuthority,
  ) => Promise<OwnerThreadWakeChange>;
}

/**
 * An owner device's view of one Code thread's wake switches, read and changed
 * against the host's current state. The coordinator role is not here: making
 * or stopping a coordinator stays a person's choice at a window on this host.
 */
export function createOwnerThreadWakeHost(options: {
  readonly readCodeThread: (threadId: CodeThread["id"]) => CodeThread | undefined;
  readonly readProject: (projectId: Project["id"]) => Project | undefined;
  readonly code: Pick<CodeService, "changeOwnerWake"> | undefined;
}): OwnerThreadWakeHost {
  const snapshot = (threadId: CodeThread["id"]): OwnerThreadWakeRead => {
    const thread = options.readCodeThread(threadId);
    const project = thread === undefined ? undefined : options.readProject(thread.projectId);
    if (
      thread?.lifecycle !== "active" ||
      project?.type !== "code" ||
      project.lifecycle !== "active"
    )
      return { status: "refused", kind: "not-found" };
    // The signed change names this digest, so a change made against an earlier
    // reading of the thread or its Project cannot apply.
    const version = createHash("sha256").update(JSON.stringify({ thread, project })).digest("hex");
    return {
      status: "read",
      wake: {
        threadId: thread.id,
        messageWake: thread.messageWake === true,
        ...(thread.coordinatorThreadId === undefined
          ? {}
          : { coordinatorWake: thread.coordinatorWakeOff !== true }),
        version,
      },
    };
  };
  return {
    read: async (threadId) => snapshot(threadId),
    change: async (request, authority) => {
      // A wake switch lets other threads start turns here, so it is never
      // covered by an open administration session.
      if (!authority.fresh) return { status: "refused", kind: "refused" };
      if (options.code === undefined) return { status: "refused", kind: "not-found" };
      const before = snapshot(request.threadId);
      if (before.status === "refused") return before;
      if (before.wake.version !== request.expectedVersion)
        return { status: "refused", kind: "wake-stale" };
      if (request.switch === "coordinator-wake" && before.wake.coordinatorWake === undefined)
        return { status: "refused", kind: "not-a-worker" };
      const current = options.readCodeThread(request.threadId);
      if (current === undefined) return { status: "refused", kind: "not-found" };
      try {
        // No await between the snapshot and the synchronous service
        // transaction: another command cannot change the thread here.
        options.code.changeOwnerWake({
          threadId: current.id,
          expectedVersion: current.version,
          switch: request.switch,
          wake: request.wake,
          ownerMemberId: authority.ownerMemberId,
        });
      } catch {
        return { status: "refused", kind: "refused" };
      }
      const after = snapshot(request.threadId);
      return after.status === "read" ? { status: "changed", wake: after.wake } : after;
    },
  };
}

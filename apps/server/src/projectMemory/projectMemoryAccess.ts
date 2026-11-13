import {
  decodeMemoryEntryId,
  decodeProjectId,
  type ApprovalOutsideContent,
  type OctantMode,
  type ProjectId,
  type ProjectMemoryView,
  type WindowId,
} from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { ProjectService } from "../projectService";
import {
  agentMemoryCommandFor,
  ProjectMemoryProposalService,
} from "./projectMemoryProposalService";
import { createProjectMemoryTools } from "./projectMemoryTools";

export interface ProjectMemoryTurnScope {
  readonly windowId: WindowId;
  readonly mode: OctantMode;
  readonly threadId: string;
  /** Absent for a Chat thread outside a Project, which is offered no tool. */
  readonly projectId: string | undefined;
  /** Why this turn may not write, such as Plan mode; read on every call. */
  readonly writeRefusal?: () => string | undefined;
  /**
   * Whether the thread is at Full access now, read on every call. Absent for
   * Chat, which has no such level.
   */
  readonly fullAccess?: () => boolean;
}

export interface ProjectMemoryAccess {
  readonly proposals: ProjectMemoryProposalService;
  readonly toolsFor: (scope: ProjectMemoryTurnScope) => AppManagedToolSet | undefined;
}

/**
 * Project memory as a thread's agent may use it: `octant_memory` for any
 * thread in a Project, in every mode and on every provider that takes Octant's
 * tools. A write at Full access, or in a Project that lets agents write its
 * memory, goes straight to Project memory's own command path; any other waits
 * for the person through the proposal service, which applies a confirmed
 * change through the same path.
 */
export function createProjectMemoryAccess(input: {
  readonly projects: Pick<ProjectService, "executeAgentMemory">;
  readonly readMemory: (projectId: ProjectId) => ProjectMemoryView | undefined;
  /** The Project's "Agents may write Project memory without asking" setting. */
  readonly agentsWriteWithoutAsking: (projectId: ProjectId) => boolean;
  /** The host acting on its own (a routine's run, a resumed turn): nobody is there to confirm. */
  readonly isHostScope: (windowId: WindowId) => boolean;
  /**
   * A paired device's turn. Its proposal would wait on a device that has no
   * card for it, so writes are confirmed only from a window on this computer.
   */
  readonly isPairedDeviceScope: (windowId: WindowId) => boolean;
  readonly outsideContent: (threadId: string) => ApprovalOutsideContent | undefined;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly onChanged?: () => void;
}): ProjectMemoryAccess {
  const proposals = new ProjectMemoryProposalService({
    uuid: input.uuid,
    now: input.now,
    apply: (command, origin, actor) => input.projects.executeAgentMemory(command, origin, actor),
    ...(input.onChanged === undefined ? {} : { onChanged: input.onChanged }),
  });
  return {
    proposals,
    toolsFor: (scope) => {
      if (scope.projectId === undefined) return undefined;
      let projectId: ProjectId;
      try {
        projectId = decodeProjectId(scope.projectId);
      } catch {
        return undefined;
      }
      return createProjectMemoryTools({
        windowId: scope.windowId,
        thread: { id: scope.threadId, mode: scope.mode, projectId },
        readMemory: () => input.readMemory(projectId),
        proposals,
        nobodyToConfirm:
          input.isHostScope(scope.windowId) || input.isPairedDeviceScope(scope.windowId),
        ...(scope.writeRefusal === undefined ? {} : { writeRefusal: scope.writeRefusal }),
        fullAccess: () => scope.fullAccess?.() === true,
        projectAllowsUnaskedWrites: () => input.agentsWriteWithoutAsking(projectId),
        writeUnasked: (write) =>
          input.projects.executeAgentMemory(
            agentMemoryCommandFor({ ...write, projectId }, () => decodeMemoryEntryId(input.uuid())),
            {
              kind: "agent-authored",
              mode: scope.mode,
              threadId: scope.threadId,
              unconfirmed: true,
            },
          ),
        outsideContent: () => input.outsideContent(scope.threadId),
      });
    },
  };
}

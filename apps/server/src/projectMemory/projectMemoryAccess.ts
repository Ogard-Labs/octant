import {
  decodeProjectId,
  type ApprovalOutsideContent,
  type OctantMode,
  type ProjectId,
  type ProjectMemoryView,
  type WindowId,
} from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { ProjectService } from "../projectService";
import { ProjectMemoryProposalService } from "./projectMemoryProposalService";
import { createProjectMemoryTools } from "./projectMemoryTools";

export interface ProjectMemoryTurnScope {
  readonly windowId: WindowId;
  readonly mode: OctantMode;
  readonly threadId: string;
  /** Absent for a Chat thread outside a Project, which is offered no tool. */
  readonly projectId: string | undefined;
  /** Why this turn may not write, such as Plan mode; read on every call. */
  readonly writeRefusal?: () => string | undefined;
}

export interface ProjectMemoryAccess {
  readonly proposals: ProjectMemoryProposalService;
  readonly toolsFor: (scope: ProjectMemoryTurnScope) => AppManagedToolSet | undefined;
}

/**
 * Project memory as a thread's agent may use it: `octant_memory` for any
 * thread in a Project, in every mode and on every provider that takes Octant's
 * tools. Writes wait for the person through the proposal service, which applies
 * a confirmed change through Project memory's own command path.
 */
export function createProjectMemoryAccess(input: {
  readonly projects: Pick<ProjectService, "executeAgentMemory">;
  readonly readMemory: (projectId: ProjectId) => ProjectMemoryView | undefined;
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
    apply: (command, origin) => input.projects.executeAgentMemory(command, origin),
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
        outsideContent: () => input.outsideContent(scope.threadId),
      });
    },
  };
}

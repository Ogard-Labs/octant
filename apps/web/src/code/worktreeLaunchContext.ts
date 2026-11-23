import { createContext } from "react";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { CodeWorktreeCreationProgress } from "@octant/contracts";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import type { PreparationTarget } from "../projects/WorktreePreparationDialog";

export interface WorktreeLaunch {
  readonly threadId: CodeThreadId;
  readonly composerId: string;
  readonly projectId: ProjectId;
  readonly startFromOrigin: boolean;
  readonly phase?: CodeWorktreeCreationProgress["phase"];
  readonly sourceMs?: number;
  readonly checkoutMs?: number;
  readonly target?: PreparationTarget;
  readonly turn?: "starting" | "started";
  readonly blocked?: boolean;
}

export const WorktreeLaunchContext = createContext<
  | {
      readonly launches: ReadonlyMap<CodeThreadId, WorktreeLaunch>;
      readonly client: ProjectTerminalClient;
      readonly onDetails: (target: PreparationTarget) => void;
      readonly detailsThreadId: CodeThreadId | undefined;
    }
  | undefined
>(undefined);

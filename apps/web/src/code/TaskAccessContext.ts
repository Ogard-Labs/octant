import type { SandboxRestrictionsClient } from "@octant/client-runtime/sandbox-restrictions-client";
import { createContext } from "react";
import type { ContextClient } from "@octant/client-runtime/context-client";
import type { ContextSubjectRef } from "@octant/contracts";

export interface TaskAccessContextValue {
  readonly sandboxRestrictionsClient?: SandboxRestrictionsClient;
  readonly client: ContextClient;
  readonly subject: ContextSubjectRef;
  readonly onOpenProviders?: () => void;
  readonly onOpenAccess?: () => void;
  readonly onOpenProtectedFiles?: () => void;
  readonly onOpenSandboxRestrictions?: () => void;
}
export const TaskAccessContext = createContext<TaskAccessContextValue | undefined>(undefined);

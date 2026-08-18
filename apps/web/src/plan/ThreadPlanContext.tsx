import { createContext, useContext, type ReactNode } from "react";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import { usePlanController, type PlanController } from "./usePlanController";

const ThreadPlanContext = createContext<PlanController | undefined>(undefined);

export interface ThreadPlanProviderProps {
  readonly client?: PlanClient;
  readonly threadId: string;
  readonly children: ReactNode;
}

/**
 * One plan controller for one thread, read by every surface showing that plan.
 *
 * The plan appears twice — beside the transcript it belongs to and in the
 * thread's own panel — and two controllers would mean two reads and two
 * versions of the same plan, which is exactly how a reader ends up approving
 * one revision while looking at another.
 */
export function ThreadPlanProvider(props: ThreadPlanProviderProps) {
  const controller = usePlanController({
    client: props.client,
    enabled: props.client !== undefined,
    threadId: props.threadId,
  });
  return (
    <ThreadPlanContext.Provider value={controller}>{props.children}</ThreadPlanContext.Provider>
  );
}

/** The plan of the thread this surface belongs to, or nothing outside one. */
export function useThreadPlan(): PlanController | undefined {
  return useContext(ThreadPlanContext);
}

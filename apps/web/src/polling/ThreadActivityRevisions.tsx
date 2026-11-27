import { createContext, useContext } from "react";

export interface ThreadActivityRevisions {
  readonly browserCaptures: number;
  readonly toolApprovals: number;
  readonly threadFollowUps: number;
  readonly threadMessageQueue: number;
}

export const ThreadActivityRevisionsContext = createContext<ThreadActivityRevisions | undefined>(
  undefined,
);

export function useThreadActivityRevision(topic: keyof ThreadActivityRevisions) {
  return useContext(ThreadActivityRevisionsContext)?.[topic];
}

export const THREAD_ACTIVITY_RECOVERY_MS = 30_000;

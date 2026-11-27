import { createContext, useContext, type ReactNode } from "react";

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

/**
 * The Code navigation notice, which the sidebar rows reload on. Its own
 * context because it changes far more often than the topics above, and their
 * readers must not rerender with it.
 */
export const CodeNavigationRevisionContext = createContext<number | undefined>(undefined);

export function useCodeNavigationRevision() {
  return useContext(CodeNavigationRevisionContext);
}

export function ThreadActivityRevisionsProvider(props: {
  readonly value: ThreadActivityRevisions;
  readonly codeNavigation: number;
  readonly children: ReactNode;
}) {
  return (
    <CodeNavigationRevisionContext.Provider value={props.codeNavigation}>
      <ThreadActivityRevisionsContext.Provider value={props.value}>
        {props.children}
      </ThreadActivityRevisionsContext.Provider>
    </CodeNavigationRevisionContext.Provider>
  );
}

export const THREAD_ACTIVITY_RECOVERY_MS = 30_000;

import type { AgentGrantClient } from "@octant/client-runtime/agent-grant-client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";

/** Thread id to the name of the outside agent that started it. */
type AgentThreadNames = ReadonlyMap<string, string>;

const NO_NAMES: AgentThreadNames = new Map();
const AgentThreadNamesContext = createContext<AgentThreadNames>(NO_NAMES);

/**
 * A thread an outside agent starts lands without warning while the person
 * works, so the list is read again every half minute while the window is in
 * view. It is a few rows: one per agent-started thread.
 */
const REFRESH_MS = 30_000;

/**
 * Holds which threads outside agents started, for "Started by" on sidebar
 * rows and pane headers and for the agent's name on Needs you rows. A host
 * that cannot answer (an older one, or a read that failed) leaves the last
 * names in place, and with none every thread reads as the person's own.
 */
export function AgentThreadAttributionProvider(props: {
  readonly client: AgentGrantClient | undefined;
  readonly children: ReactNode;
}) {
  const [names, setNames] = useState<AgentThreadNames>(NO_NAMES);
  const client = props.client;
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined) return;
      const answer = await client.threads(signal);
      const next = new Map(answer.threads.map((thread) => [thread.threadId, thread.agentName]));
      setNames((previous) => (sameNames(previous, next) ? previous : next));
    },
    [client],
  );
  useVisibleRefresh(refresh, undefined, REFRESH_MS);
  return (
    <AgentThreadNamesContext.Provider value={names}>
      {props.children}
    </AgentThreadNamesContext.Provider>
  );
}

/** The name of the outside agent that started this thread, if one did. */
export function useAgentThreadName(threadId: string | undefined): string | undefined {
  const names = useContext(AgentThreadNamesContext);
  return threadId === undefined ? undefined : names.get(threadId);
}

function sameNames(left: AgentThreadNames, right: AgentThreadNames): boolean {
  if (left.size !== right.size) return false;
  for (const [threadId, name] of right) if (left.get(threadId) !== name) return false;
  return true;
}

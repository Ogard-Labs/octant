import type { AgentGrantClient } from "@octant/client-runtime/agent-grant-client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";

/**
 * Thread id to the name of the outside agent that started it, and a thread's
 * turn id (the id its turn record keeps) to the agent that sent that turn.
 */
interface AgentNames {
  readonly threads: ReadonlyMap<string, string>;
  readonly turns: ReadonlyMap<string, string>;
}

const NO_NAMES: AgentNames = { threads: new Map(), turns: new Map() };
const AgentThreadNamesContext = createContext<AgentNames>(NO_NAMES);

const turnName = (threadId: string, turnKey: string) => `${threadId}\u0000${turnKey}`;

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
  const [names, setNames] = useState<AgentNames>(NO_NAMES);
  const client = props.client;
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined) return;
      const answer = await client.threads(signal);
      const next: AgentNames = {
        threads: new Map(answer.threads.map((thread) => [thread.threadId, thread.agentName])),
        turns: new Map(
          (answer.turns ?? []).map((turn) => [
            turnName(turn.threadId, turn.turnKey),
            turn.agentName,
          ]),
        ),
      };
      setNames((previous) =>
        sameNames(previous.threads, next.threads) && sameNames(previous.turns, next.turns)
          ? previous
          : next,
      );
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
  return threadId === undefined ? undefined : names.threads.get(threadId);
}

/**
 * "Sent by <agent>" under a prompt an outside agent sent, so it is not read as
 * the person's own words. Renders nothing for the person's prompts.
 */
export function AgentTurnSender(props: { readonly agentName: string | undefined }) {
  if (props.agentName === undefined) return null;
  return (
    <span className="oct-meta agent-turn-sender" title={`Sent by ${props.agentName}`}>
      {`Sent by ${props.agentName}`}
    </span>
  );
}

function sameNames(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [threadId, name] of right) if (left.get(threadId) !== name) return false;
  return true;
}

/**
 * A lookup from a turn id (the id the turn's record keeps: a Code operation
 * id, a Chat submission id, a Work turn id) to the outside agent that sent it,
 * for one thread. Read once in a transcript and used for every turn in it.
 */
export function useAgentTurnSenders(
  threadId: string | undefined,
): (turnKey: string | undefined) => string | undefined {
  const names = useContext(AgentThreadNamesContext);
  return useCallback(
    (turnKey) =>
      threadId === undefined || turnKey === undefined
        ? undefined
        : names.turns.get(turnName(threadId, turnKey)),
    [names, threadId],
  );
}

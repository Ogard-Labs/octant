import type { AgentRunCenterSummary } from "@octant/contracts";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { isAgentRunActiveStatus } from "@octant/domain";
import { useEffect, useState } from "react";

/** More than a person can follow on a glance card; the card shows five. */
const ACTIVE_RUN_LIMIT = 50;

type ActiveRuns = ReadonlyArray<AgentRunCenterSummary>;

/**
 * The one read this window shares between every start-screen surface that
 * lists runs: the Working now card, the Running tab, and the Computers card.
 * Each of them used to read on its own, so one change to the thread lists cost
 * the host up to three AgentRun center reads.
 */
interface SharedActiveRunRead {
  readonly listeners: Set<(runs: ActiveRuns) => void>;
  runs: ActiveRuns | undefined;
  requestedRevision: number | undefined;
  inFlight: boolean;
  pending: boolean;
  closed: boolean;
}

const sharedReads = new WeakMap<AgentRunClient, SharedActiveRunRead>();

function sharedReadFor(client: AgentRunClient): SharedActiveRunRead {
  const existing = sharedReads.get(client);
  if (existing !== undefined) return existing;
  const created: SharedActiveRunRead = {
    listeners: new Set(),
    runs: undefined,
    requestedRevision: undefined,
    inFlight: false,
    pending: false,
    closed: false,
  };
  sharedReads.set(client, created);
  return created;
}

function runSharedRead(client: AgentRunClient, read: SharedActiveRunRead): void {
  read.inFlight = true;
  read.pending = false;
  client
    .center({ status: "active", mode: "all", limit: ACTIVE_RUN_LIMIT })
    .then(
      (response) => {
        if (read.closed) return;
        const runs = response.items.filter((run) => isAgentRunActiveStatus(run.lifecycleStatus));
        read.runs = runs;
        for (const listener of read.listeners) listener(runs);
      },
      () => {
        // A read the host refuses says nothing new; keep what is on screen. Forget
        // which revision it was for, so the next surface that mounts reads again
        // rather than waiting for the thread lists to change.
        if (!read.pending) read.requestedRevision = undefined;
      },
    )
    .finally(() => {
      read.inFlight = false;
      if (read.pending && !read.closed) runSharedRead(client, read);
    });
}

/**
 * The agent runs in progress, from the AgentRun projection the Agents Center
 * reads. One read when the first surface mounts, and one more whenever the
 * thread lists change (`revision`), which is the cadence the sidebar already
 * follows: this adds no timer. `undefined` until the first answer, and a
 * refused read keeps the last answer, so the card keeps listing what it can see,
 * and the next surface to mount reads again.
 *
 * Every surface on the screen shares the read, and changes are coalesced: at
 * most one read is in flight, and any number of revisions that arrive
 * meanwhile become one more read once it lands. A streaming Chat reply moves
 * the navigation topics on every delta, so a read per revision per surface
 * would make the host walk the projection several times for every token.
 * When the last surface unmounts the shared answer is dropped, so coming back
 * to the start screen reads again.
 */
export function useActiveAgentRuns(
  client: AgentRunClient | undefined,
  revision: number,
): ActiveRuns | undefined {
  const [runs, setRuns] = useState<ActiveRuns | undefined>(() =>
    client === undefined ? undefined : sharedReads.get(client)?.runs,
  );
  useEffect(() => {
    if (client === undefined) {
      setRuns(undefined);
      return;
    }
    const read = sharedReadFor(client);
    read.listeners.add(setRuns);
    setRuns(read.runs);
    return () => {
      read.listeners.delete(setRuns);
      if (read.listeners.size === 0) {
        read.closed = true;
        sharedReads.delete(client);
      }
    };
  }, [client]);
  useEffect(() => {
    if (client === undefined) return;
    const read = sharedReadFor(client);
    if (read.requestedRevision === revision) return;
    read.requestedRevision = revision;
    if (read.inFlight) read.pending = true;
    else runSharedRead(client, read);
  }, [client, revision]);
  return runs;
}

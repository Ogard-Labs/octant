import type { AgentRunCenterSummary } from "@octant/contracts";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { isAgentRunActiveStatus } from "@octant/domain";
import { useEffect, useState } from "react";

/** More than a person can follow on a glance card; the card shows five. */
const ACTIVE_RUN_LIMIT = 50;

/**
 * The agent runs in progress, from the AgentRun projection the Agents Center
 * reads. One read when the card mounts, and one more whenever the thread
 * lists change (`revision`), which is the cadence the sidebar already follows:
 * this adds no timer. `undefined` until the first answer, and a refused read keeps
 * the last answer, so the card keeps listing what it can see.
 */
export function useActiveAgentRuns(
  client: AgentRunClient | undefined,
  revision: number,
): ReadonlyArray<AgentRunCenterSummary> | undefined {
  const [runs, setRuns] = useState<ReadonlyArray<AgentRunCenterSummary> | undefined>(undefined);
  useEffect(() => {
    if (client === undefined) {
      setRuns(undefined);
      return;
    }
    let cancelled = false;
    client.center({ status: "active", mode: "all", limit: ACTIVE_RUN_LIMIT }).then(
      (response) => {
        if (cancelled) return;
        setRuns(response.items.filter((run) => isAgentRunActiveStatus(run.lifecycleStatus)));
      },
      () => {
        // A read the host refuses says nothing new; keep what is on screen.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, revision]);
  return runs;
}

import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { useEffect, useRef, useState } from "react";
import { ComputerUseLifecycleSurface } from "./ComputerUseLifecycleSurface";
import { samePollingData } from "../polling/samePollingData";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";

export function ComputerUseActivitySurface(props: {
  readonly client: ComputerUseClient;
  readonly excludedSessions?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly pollIntervalMs?: number;
}) {
  const [sessions, setSessions] = useState<ReadonlyArray<ComputerUseSessionView>>([]);
  const firstSchedule = useRef(true);
  const backgroundSessions = sessions.filter((session) => {
    const threadId = String(session.threadId);
    const excludedSessionIds = props.excludedSessions?.get(threadId);
    if (excludedSessionIds === undefined) return true;
    return isNonterminalSession(session) && !excludedSessionIds.has(String(session.sessionId));
  });
  // A session that is still running can change every second; with none
  // running this list changes only when a thread starts one, so an idle
  // window re-reads on a slow cadence rather than every few seconds.
  const pollIntervalMs =
    props.pollIntervalMs ?? (backgroundSessions.some(isNonterminalSession) ? 1_000 : 30_000);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const next = await props.client.list();
        if (!active) return;
        setSessions((current) => (samePollingData(current, next) ? current : next));
      } catch {
        if (active) setSessions((current) => (current.length === 0 ? current : []));
      } finally {
        inFlight = false;
      }
    };
    const runImmediately = firstSchedule.current;
    firstSchedule.current = false;
    const stop = scheduleVisibleInterval(() => void load(), pollIntervalMs, { runImmediately });
    return () => {
      active = false;
      stop();
    };
  }, [pollIntervalMs, props.client]);

  if (backgroundSessions.length === 0) return null;
  return (
    <aside aria-label="Background computer use" className="computer-use-activity">
      {backgroundSessions.map((session) => (
        <ComputerUseLifecycleSurface
          client={props.client}
          key={session.sessionId}
          scope={{
            sessionId: session.sessionId,
            threadId: session.threadId,
            authority: session.authority,
          }}
        />
      ))}
    </aside>
  );
}

function isNonterminalSession(session: ComputerUseSessionView): boolean {
  return (
    session.state === "requesting-approval" ||
    session.state === "active" ||
    session.state === "waiting-for-approval" ||
    session.state === "running" ||
    session.state === "stopping"
  );
}

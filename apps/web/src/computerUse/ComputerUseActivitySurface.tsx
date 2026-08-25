import type { ComputerUseClient } from "@octant/client-runtime/computer-use-client";
import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { useEffect, useState } from "react";
import { ComputerUseLifecycleSurface } from "./ComputerUseLifecycleSurface";
import { samePollingData } from "../polling/samePollingData";

export function ComputerUseActivitySurface(props: {
  readonly client: ComputerUseClient;
  readonly excludedSessions?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly pollIntervalMs?: number;
}) {
  const [sessions, setSessions] = useState<ReadonlyArray<ComputerUseSessionView>>([]);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
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
    void load();
    const timer = setInterval(() => void load(), props.pollIntervalMs ?? 1_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [props.client, props.pollIntervalMs]);

  const backgroundSessions = sessions.filter((session) => {
    const threadId = String(session.threadId);
    const excludedSessionIds = props.excludedSessions?.get(threadId);
    if (excludedSessionIds === undefined) return true;
    return isNonterminalSession(session) && !excludedSessionIds.has(String(session.sessionId));
  });
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

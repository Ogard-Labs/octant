import type { AgentMessageMessagingFacts } from "@octant/contracts";
import type { AgentMessageClient } from "@octant/client-runtime/agent-message-client";
import { useEffect, useState } from "react";

export interface AgentMessagingFactsRowProps {
  readonly client: AgentMessageClient | undefined;
  /** Injected in tests; ordinary callers refresh on the interval. */
  readonly facts?: AgentMessageMessagingFacts;
}

const REFRESH_MS = 15_000;

const REFUSE_LABELS: Record<string, string> = {
  unauthorized: "unauthorized",
  "depth-exceeded": "too deep",
  "recipient-terminal": "recipient closed",
  oversize: "too large",
  policy: "refused by policy",
};

/**
 * The host's messaging facts in the bounds the policy admits, under the run
 * list it governs: how many messages sit open in flight against the per-sender
 * cap and what the host last refused. A stranded message states its refuse
 * reason instead of vanishing; bodies are never shown here.
 */
export function AgentMessagingFactsRow(props: AgentMessagingFactsRowProps) {
  const [loaded, setLoaded] = useState<AgentMessageMessagingFacts | undefined>(props.facts);
  const client = props.client;
  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    const read = () => {
      client
        .facts()
        .then((facts) => {
          if (!cancelled) setLoaded(facts);
        })
        .catch(() => {
          // The row is a status aid, not the center's purpose: an unavailable
          // read leaves the last facts up rather than shouting over the list.
        });
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // The client identity is stable for the surface's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const facts = props.facts ?? loaded;
  if (facts === undefined) return null;
  const latestRefusal = facts.recent.find((entry) => entry.state === "refused");
  return (
    <p
      aria-label="Agent messaging bounds"
      className="agents-center__messaging"
      data-testid="agent-messaging-facts"
    >
      <span>
        {facts.openInFlight} of {facts.maxOpenInFlightPerSender} open messages per sender
      </span>
      <span>
        {facts.delivered} delivered · {facts.refused} refused
      </span>
      {latestRefusal === undefined ? null : (
        <span>
          Latest refusal: {REFUSE_LABELS[latestRefusal.refuseReason ?? "policy"] ?? "refused"}
        </span>
      )}
    </p>
  );
}

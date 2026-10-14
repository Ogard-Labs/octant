import type { AgentMessageMessagingFacts } from "@octant/contracts";
import type { AgentMessageClient } from "@octant/client-runtime/agent-message-client";
import { useEffect, useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

export interface AgentMessagingFactsRowProps {
  readonly client: AgentMessageClient | undefined;
  /** Injected in tests; ordinary callers refresh on the interval. */
  readonly facts?: AgentMessageMessagingFacts;
}

const REFRESH_MS = 15_000;
/** The facts carry the twenty newest; the list states the few a person reads. */
const SHOWN_REFUSALS = 5;

function threadLabel(threadId: string): string {
  return threadId.length > 8 ? `${threadId.slice(0, 8)}…` : threadId;
}

const REFUSE_LABELS: Record<string, string> = {
  unauthorized: "not reachable",
  "depth-exceeded": "too deep",
  "recipient-terminal": "recipient closed",
  oversize: "too large",
  policy: "refused by policy",
};

/**
 * The host's messaging facts in the bounds the policy admits, under the run
 * list it governs: how many messages sit open in flight against the per-sender
 * cap and what the host refused. A refused message states its reason, the
 * thread that sent it, and the thread it named instead of vanishing, whether
 * the host refused it at the send or at delivery; bodies are never shown here.
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
    // A hidden window should not keep asking the host for a status row nobody
    // can see; becoming visible refreshes it before the person reads it.
    const stop = scheduleVisibleInterval(read, REFRESH_MS);
    return () => {
      cancelled = true;
      stop();
    };
    // The client identity is stable for the surface's lifetime.
  }, [client]);

  const facts = props.facts ?? loaded;
  if (facts === undefined) return null;
  const refusals = facts.recent.filter((entry) => entry.state === "refused");
  const latestRefusal = refusals[0];
  return (
    <>
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
      {refusals.length === 0 ? null : (
        <ul aria-label="Refused agent messages" className="agents-center__refusals">
          {refusals.slice(0, SHOWN_REFUSALS).map((entry) => (
            <li key={String(entry.messageId)}>
              <span title={String(entry.senderThreadId)}>
                {threadLabel(String(entry.senderThreadId))}
              </span>
              {" → "}
              <span title={String(entry.recipientThreadId)}>
                {threadLabel(String(entry.recipientThreadId))}
              </span>
              <span>{REFUSE_LABELS[entry.refuseReason ?? "policy"] ?? "refused"}</span>
              <time dateTime={String(entry.occurredAt)}>
                {relativeTimeLabel(String(entry.occurredAt))}
              </time>
            </li>
          ))}
          {refusals.length > SHOWN_REFUSALS ? (
            <li>{refusals.length - SHOWN_REFUSALS} more recent refusals</li>
          ) : null}
        </ul>
      )}
    </>
  );
}

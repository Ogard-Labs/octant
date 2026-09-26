import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { ArrowUpRight, Bot } from "lucide-react";
import { useChildRunStatus } from "../agents/useChildRunStatus";
import type { AgentHierarchyInputEntry } from "../agents/buildAgentHierarchyModel";
import { OctantButton } from "../ui/base/OctantButton";

const ACTIVE = new Set(["queued", "starting", "running", "waiting"]);

/**
 * One Environment row that says what this thread's subagents are doing and
 * opens them in the Agents tool.
 *
 * It had been a second, smaller Agents tool — its own Active and Done lists
 * and an inline transcript — beside the real one a tab away, and the two
 * disagreed on wording and on which runs they showed. The row keeps the count
 * in view; reading and steering a subagent belongs to the tool built for it.
 */
export function EnvironmentSubagents(props: {
  readonly client: AgentRunClient;
  readonly threadId: string;
  readonly onOpenAgents?: () => void;
}) {
  const controller = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  // A row that vanished when nothing had been delegated could not be told
  // apart from a missing feature, so an empty thread says None.
  const summary = controller.status !== "ready" ? "Reading" : subagentSummary(controller.entries);
  const content = (
    <>
      <Bot aria-hidden="true" className="environment-row__icon" size={16} strokeWidth={1.7} />
      <span className="environment-row__title">Subagents</span>
      <span className="environment-row__detail">{summary}</span>
    </>
  );

  if (props.onOpenAgents === undefined) {
    return (
      <section aria-label="Subagents" className="environment-row">
        {content}
      </section>
    );
  }
  return (
    <OctantButton
      aria-label={`Subagents, ${summary}. Open in Agents`}
      className="environment-link window-no-drag"
      onClick={props.onOpenAgents}
      type="button"
      variant="link"
    >
      {content}
      <ArrowUpRight
        aria-hidden="true"
        className="environment-row__trailing"
        size={14}
        strokeWidth={1.8}
      />
    </OctantButton>
  );
}

/** "1 working · 2 to review", in the order a reader acts on them. */
export function subagentSummary(entries: ReadonlyArray<AgentHierarchyInputEntry>): string {
  if (entries.length === 0) return "None";
  let working = 0;
  let toReview = 0;
  let done = 0;
  for (const entry of entries) {
    if (ACTIVE.has(entry.lifecycleStatus)) working += 1;
    else if (entry.resultAcknowledgement.required && !entry.resultAcknowledgement.acknowledged) {
      toReview += 1;
    } else done += 1;
  }
  const parts: string[] = [];
  if (working > 0) parts.push(`${String(working)} working`);
  if (toReview > 0) parts.push(`${String(toReview)} to review`);
  if (done > 0) parts.push(`${String(done)} done`);
  return parts.join(" · ");
}

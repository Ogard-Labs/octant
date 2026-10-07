import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { Bot } from "lucide-react";
import { useChildRunStatus } from "../agents/useChildRunStatus";
import {
  isActiveAgentHierarchyStatus,
  subagentNeedsReview,
  type AgentHierarchyInputEntry,
} from "../agents/buildAgentHierarchyModel";
import { SubagentStatusIcon, subagentStatusWord } from "../agents/subagentStatus";
import { OctantButton } from "../ui/base/OctantButton";
import { EnvironmentGroup } from "./EnvironmentGroup";

/**
 * Every subagent this thread's agent delegated, working and finished, as one
 * Environment row that opens into the list.
 *
 * The composer's card shows only what is running, so this is where a finished
 * one — reviewed or waiting for review — is found again. A row opens that
 * subagent's page in the Agents tool, where its conversation and controls are.
 */
export function EnvironmentSubagents(props: {
  readonly client: AgentRunClient;
  readonly threadId: string;
  readonly onOpenAgents?: (runId?: string) => void;
}) {
  const controller = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  // A row that vanished when nothing had been delegated could not be told
  // apart from a missing feature, so an empty thread says None.
  const summary = controller.status !== "ready" ? "Reading" : subagentSummary(controller.entries);
  const working = controller.entries.filter((entry) =>
    isActiveAgentHierarchyStatus(entry.lifecycleStatus),
  );
  const finished = controller.entries
    .filter((entry) => !isActiveAgentHierarchyStatus(entry.lifecycleStatus))
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return (
    <EnvironmentGroup icon={Bot} summary={summary} title="Subagents">
      {/* Before the first read answers the list is empty but unknown; saying
          None there hid runs that existed and contradicted the header. */}
      {controller.status !== "ready" ? (
        <p className="environment-subagents__empty" role="status">
          Reading subagents…
        </p>
      ) : controller.entries.length === 0 ? (
        <p className="environment-subagents__empty">
          None yet. They appear when the agent hands off part of its work.
        </p>
      ) : (
        <>
          <SubagentList
            entries={working}
            label="Working"
            {...(props.onOpenAgents === undefined ? {} : { onOpen: props.onOpenAgents })}
          />
          <SubagentList
            entries={finished}
            label="Finished"
            {...(props.onOpenAgents === undefined ? {} : { onOpen: props.onOpenAgents })}
          />
        </>
      )}
    </EnvironmentGroup>
  );
}

function SubagentList(props: {
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly label: string;
  readonly onOpen?: (runId: string) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <section aria-label={props.label} className="environment-subagents__section">
      <h4 className="environment-subagents__label">
        {props.label} · {props.entries.length}
      </h4>
      <ul className="environment-subagents__list">
        {props.entries.map((entry) => {
          const state = subagentNeedsReview(entry)
            ? "To review"
            : subagentStatusWord(entry.lifecycleStatus);
          const content = (
            <>
              <SubagentStatusIcon lifecycleStatus={entry.lifecycleStatus} />
              <span className="environment-subagents__task">{entry.task}</span>
              <span className="environment-subagents__state">{state}</span>
            </>
          );
          return (
            <li key={entry.runId}>
              {props.onOpen === undefined ? (
                <span className="environment-subagent">{content}</span>
              ) : (
                <OctantButton
                  aria-label={`${entry.task}. ${state}. Open in Agents`}
                  className="environment-subagent window-no-drag"
                  onClick={() => props.onOpen?.(entry.runId)}
                  title={entry.task}
                  type="button"
                  variant="link"
                >
                  {content}
                </OctantButton>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "1 working · 2 to review", in the order a reader acts on them. */
export function subagentSummary(entries: ReadonlyArray<AgentHierarchyInputEntry>): string {
  if (entries.length === 0) return "None";
  let working = 0;
  let toReview = 0;
  let done = 0;
  for (const entry of entries) {
    if (isActiveAgentHierarchyStatus(entry.lifecycleStatus)) working += 1;
    else if (subagentNeedsReview(entry)) toReview += 1;
    else done += 1;
  }
  const parts: string[] = [];
  if (working > 0) parts.push(`${String(working)} working`);
  if (toReview > 0) parts.push(`${String(toReview)} to review`);
  if (done > 0) parts.push(`${String(done)} done`);
  return parts.join(" · ");
}

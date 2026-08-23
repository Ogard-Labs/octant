import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { Bot, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useChildRunStatus } from "../agents/useChildRunStatus";
import { OctantButton } from "../ui/base/OctantButton";

const ACTIVE = new Set(["queued", "starting", "running", "waiting"]);

export function EnvironmentSubagents(props: {
  readonly client: AgentRunClient;
  readonly threadId: string;
  readonly onOpenAgents?: () => void;
}) {
  const controller = useChildRunStatus({
    client: props.client,
    parentThreadId: decodeAgentRunParentThreadId(props.threadId),
  });
  const [selectedRunId, setSelectedRunId] = useState<string>();
  if (controller.status !== "ready" || controller.entries.length === 0) return null;
  const active = controller.entries.filter((entry) => ACTIVE.has(entry.lifecycleStatus));
  const history = controller.entries.filter((entry) => !ACTIVE.has(entry.lifecycleStatus));

  return (
    <section aria-label="Subagents" className="environment-subagents">
      <header className="environment-subagents__header">
        <div>
          <h3>Subagents</h3>
          <p>
            {active.length} active · {history.length} done
          </p>
        </div>
        {props.onOpenAgents === undefined ? null : (
          <OctantButton onClick={props.onOpenAgents} size="sm" type="button" variant="ghost">
            Open Agents
          </OctantButton>
        )}
      </header>
      <AgentGroup
        entries={active}
        label="Active"
        {...(selectedRunId === undefined ? {} : { selectedRunId })}
        onSelect={setSelectedRunId}
      />
      <AgentGroup
        entries={history}
        label="Done"
        {...(selectedRunId === undefined ? {} : { selectedRunId })}
        onSelect={setSelectedRunId}
      />
    </section>
  );
}

function AgentGroup(props: {
  readonly entries: ReturnType<typeof useChildRunStatus>["entries"];
  readonly label: string;
  readonly selectedRunId?: string;
  readonly onSelect: (runId: string | undefined) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <section aria-label={props.label} className="environment-subagents__group">
      <h4>
        {props.label} · {props.entries.length}
      </h4>
      <ul>
        {props.entries.map((entry) => {
          const selected = props.selectedRunId === entry.runId;
          const model =
            entry.route?.executionModelId ?? entry.route?.requestedModelId ?? "Model unavailable";
          return (
            <li key={entry.runId}>
              <button
                aria-expanded={selected}
                className="environment-subagents__row"
                onClick={() => props.onSelect(selected ? undefined : entry.runId)}
                type="button"
              >
                <Bot aria-hidden="true" size={15} strokeWidth={1.7} />
                <span>
                  <strong>{entry.task}</strong>
                  <small>
                    {model} · {entry.lifecycleStatus}
                  </small>
                </span>
                <ChevronRight aria-hidden="true" size={14} strokeWidth={1.7} />
              </button>
              {selected ? (
                <div className="environment-subagents__conversation">
                  <div>
                    <span>Task</span>
                    <p>{entry.task}</p>
                  </div>
                  <div>
                    <span>Response</span>
                    <p>
                      {entry.result?.text ??
                        (ACTIVE.has(entry.lifecycleStatus)
                          ? "The subagent is still working. Live response text is not available yet."
                          : "No retained response is available.")}
                    </p>
                    {entry.result?.truncated === true ? <small>Response truncated</small> : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

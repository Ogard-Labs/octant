import { useState } from "react";
import type { CodeActivityRow, CodeTurnActivity } from "./transcriptActivity";
import { activeRowCount } from "./transcriptActivity";

export interface CodeTranscriptRowProps {
  readonly activity: CodeTurnActivity;
  readonly running: boolean;
}

function toolStateLabel(state: CodeActivityRow["state"]): string {
  switch (state) {
    case "started":
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
  }
}

/**
 * The work behind one assistant turn: the tools it ran, the tasks it tracked,
 * and its reasoning channel. Both disclosures start closed so a long turn stays
 * one line until the user asks for the detail.
 */
export function CodeTranscriptRow(props: CodeTranscriptRowProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const { activity, running } = props;
  const open = activeRowCount(activity);
  const hasRows = activity.rows.length > 0;
  const hasReasoning = activity.reasoning.trim().length > 0;
  if (!hasRows && !hasReasoning) return null;

  return (
    <div className="code-transcript-row">
      {hasRows ? (
        <details
          className="code-transcript-row__disclosure"
          onToggle={(event) => setToolsOpen(event.currentTarget.open)}
          open={toolsOpen}
        >
          <summary>
            {activity.rows.length === 1 ? "1 step" : `${String(activity.rows.length)} steps`}
            {open > 0 && running ? ` · ${String(open)} running` : ""}
          </summary>
          <ul className="code-transcript-row__steps">
            {activity.rows.map((row) => (
              <li
                className="code-transcript-row__step"
                data-state={row.state}
                key={`${row.kind}:${row.id}`}
              >
                <span className="code-transcript-row__step-name">
                  {row.kind === "tool" ? row.toolName : "Task"}
                </span>
                <span className="code-transcript-row__step-state">{toolStateLabel(row.state)}</span>
                {row.summary === undefined ? null : (
                  <span className="code-transcript-row__step-summary">{row.summary}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {hasReasoning ? (
        <details
          className="code-transcript-row__disclosure"
          onToggle={(event) => setReasoningOpen(event.currentTarget.open)}
          open={reasoningOpen}
        >
          <summary>Thinking</summary>
          <p className="code-transcript-row__reasoning">{activity.reasoning}</p>
        </details>
      ) : null}
    </div>
  );
}

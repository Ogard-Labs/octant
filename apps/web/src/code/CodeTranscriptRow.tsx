import { ChevronRight, CircleAlert } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode, type ToggleEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { CodeActivityRow, CodeTurnActivity } from "./transcriptActivity";

export interface CodeTranscriptRowProps {
  readonly activity: CodeTurnActivity;
  readonly running: boolean;
}

/** Expanded tool output is clipped to this many characters until the user asks for all of it. */
export const TOOL_OUTPUT_PREVIEW_LIMIT = 1_200;

function outcomeLabel(row: CodeActivityRow): string {
  switch (row.state) {
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

function rowKey(row: CodeActivityRow): string {
  return `${row.kind}:${row.id}`;
}

function disclosureName(row: CodeActivityRow): string {
  const name = row.kind === "tool" ? row.toolName : "Task";
  return `${name}, ${outcomeLabel(row)}`;
}

function clipOutput(
  text: string,
  revealed: boolean,
): { readonly text: string; readonly clipped: boolean } {
  if (revealed || text.length <= TOOL_OUTPUT_PREVIEW_LIMIT) {
    return { text, clipped: false };
  }
  return { text: text.slice(0, TOOL_OUTPUT_PREVIEW_LIMIT), clipped: true };
}

function setHas(values: ReadonlySet<string>, id: string, present: boolean): ReadonlySet<string> {
  if (present === values.has(id)) return values;
  const next = new Set(values);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * One assistant turn's machinery, folded so the reply can be read first.
 *
 * Each tool call and the thinking channel is its own native disclosure. Bodies
 * stay in the document while closed: in-page find can match them, and Chromium
 * expands the hit. Expanding is remembered per row for as long as this turn
 * stays mounted, so a streaming state change does not collapse a row the user
 * opened.
 */
export function CodeTranscriptRow(props: CodeTranscriptRowProps) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [revealedOutputIds, setRevealedOutputIds] = useState<ReadonlySet<string>>(() => new Set());
  const { activity, running } = props;
  const hasRows = activity.rows.length > 0;
  const hasReasoning = activity.reasoning.trim().length > 0;
  if (!hasRows && !hasReasoning) return null;

  const onToggle = (id: string) => (event: ToggleEvent<HTMLDetailsElement>) => {
    const nextOpen = event.newState === "open";
    setOpenIds((current) => setHas(current, id, nextOpen));
  };

  const onSummaryKeyDown = (id: string) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setOpenIds((current) => setHas(current, id, !current.has(id)));
  };

  return (
    <div className="code-transcript-row" {...(running ? { "data-live": "true" } : {})}>
      {hasReasoning ? (
        <details
          className="code-transcript-row__disclosure code-transcript-row__disclosure--thinking"
          onToggle={onToggle("thinking")}
          open={openIds.has("thinking")}
        >
          <summary
            aria-expanded={openIds.has("thinking")}
            aria-label="Thinking"
            onKeyDown={onSummaryKeyDown("thinking")}
            role="button"
          >
            <ChevronRight
              aria-hidden="true"
              className="code-transcript-row__chevron"
              size={13}
              strokeWidth={2}
            />
            <span className="code-transcript-row__name">Thinking</span>
          </summary>
          <p className="code-transcript-row__thinking-body">{activity.reasoning}</p>
        </details>
      ) : null}
      {activity.truncated === true ? (
        <p className="code-transcript-row__truncated">Earliest steps kept</p>
      ) : null}
      {hasRows
        ? activity.rows.map((row) => {
            const id = rowKey(row);
            return (
              <ActivityDisclosure
                key={id}
                onKeyDown={onSummaryKeyDown(id)}
                onToggle={onToggle(id)}
                open={openIds.has(id)}
                revealed={revealedOutputIds.has(id)}
                row={row}
                onReveal={() => setRevealedOutputIds((current) => setHas(current, id, true))}
              />
            );
          })
        : null}
    </div>
  );
}

function ActivityDisclosure(props: {
  readonly row: CodeActivityRow;
  readonly open: boolean;
  readonly revealed: boolean;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onToggle: (event: ToggleEvent<HTMLDetailsElement>) => void;
  readonly onReveal: () => void;
}) {
  const { row } = props;
  const failed = row.state === "failed";
  return (
    <details
      className="code-transcript-row__disclosure"
      data-kind={row.kind}
      data-state={row.state}
      onToggle={props.onToggle}
      open={props.open}
    >
      <summary
        aria-expanded={props.open}
        aria-label={disclosureName(row)}
        onKeyDown={props.onKeyDown}
        role="button"
      >
        <ChevronRight
          aria-hidden="true"
          className="code-transcript-row__chevron"
          size={13}
          strokeWidth={2}
        />
        <span className="code-transcript-row__name">
          {row.kind === "tool" ? row.toolName : "Task"}
        </span>
        <span className="code-transcript-row__outcome">{outcomeLabel(row)}</span>
        {failed ? (
          <CircleAlert
            aria-hidden="true"
            className="code-transcript-row__status-icon"
            size={12}
            strokeWidth={2}
          />
        ) : null}
      </summary>
      <div className="code-transcript-row__body">{activityDetail(row, props)}</div>
    </details>
  );
}

function activityDetail(
  row: CodeActivityRow,
  props: { readonly revealed: boolean; readonly onReveal: () => void },
): ReactNode {
  if (row.kind === "task") {
    return <p className="code-transcript-row__pre">{row.summary}</p>;
  }
  const open = row.state === "started" || row.state === "running";
  const argumentsText = row.arguments ?? (open ? row.summary : undefined);
  const outputText = row.output ?? (open ? undefined : row.summary);
  const same =
    argumentsText !== undefined && outputText !== undefined && argumentsText === outputText;
  if (argumentsText === undefined && outputText === undefined) {
    return (
      <p className="code-transcript-row__empty-detail">No arguments or output were recorded.</p>
    );
  }
  return (
    <>
      {argumentsText === undefined || same ? null : (
        <section>
          <p className="code-transcript-row__section-label">Arguments</p>
          <pre className="code-transcript-row__pre">{argumentsText}</pre>
        </section>
      )}
      {outputText === undefined ? null : (
        <OutputSection onReveal={props.onReveal} revealed={props.revealed} text={outputText} />
      )}
    </>
  );
}

function OutputSection(props: {
  readonly text: string;
  readonly revealed: boolean;
  readonly onReveal: () => void;
}) {
  const clipped = clipOutput(props.text, props.revealed);
  return (
    <section>
      <p className="code-transcript-row__section-label">Output</p>
      <pre className="code-transcript-row__pre">{clipped.text}</pre>
      {clipped.clipped ? (
        <OctantButton onClick={props.onReveal} size="sm" type="button" variant="ghost">
          Show all
        </OctantButton>
      ) : null}
    </section>
  );
}

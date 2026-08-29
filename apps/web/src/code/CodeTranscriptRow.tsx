import { ChevronRight, CircleAlert } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode, type ToggleEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  alwaysVisibleActivityRows,
  settledTurnActivitySummary,
  type CodeActivityRow,
  type CodeTurnActivity,
} from "./transcriptActivity";

export interface CodeTranscriptRowProps {
  readonly activity: CodeTurnActivity;
  readonly running: boolean;
  /**
   * When true, the turn has finished and its machinery folds behind one summary
   * line. While a turn is live or waiting on approval, the fold stays open so
   * pending work and diffs remain visible.
   */
  readonly settled?: boolean;
}

/** Expanded summaries are clipped to this many characters until the user asks for all of it. */
export const TOOL_SUMMARY_PREVIEW_LIMIT = 1_200;

/**
 * Collapsed accessible names clip a task summary here so a 2 KiB journaled
 * message does not become the disclosure's spoken name.
 */
export const ACCESSIBLE_SUMMARY_LIMIT = 120;

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

function boundAccessibleSummary(text: string): string {
  if (text.length <= ACCESSIBLE_SUMMARY_LIMIT) return text;
  return `${text.slice(0, ACCESSIBLE_SUMMARY_LIMIT - 1)}…`;
}

function collapsedName(row: CodeActivityRow): string {
  return row.kind === "tool" ? row.toolName : row.summary;
}

function disclosureName(row: CodeActivityRow): string {
  const name = row.kind === "tool" ? row.toolName : boundAccessibleSummary(row.summary);
  return `${name}, ${outcomeLabel(row)}`;
}

function clipSummary(
  text: string,
  revealed: boolean,
): { readonly text: string; readonly clipped: boolean } {
  if (revealed || text.length <= TOOL_SUMMARY_PREVIEW_LIMIT) {
    return { text, clipped: false };
  }
  return { text: text.slice(0, TOOL_SUMMARY_PREVIEW_LIMIT), clipped: true };
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
 *
 * When the turn has settled, the whole toolchain folds behind one summary line
 * that the user can expand. Waiting or in-flight rows never hide inside that
 * outer fold — an approval-pending edit stays visible so it can be judged.
 */
export function CodeTranscriptRow(props: CodeTranscriptRowProps) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [revealedSummaryIds, setRevealedSummaryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Outer fold is remembered on this turn alone: expanding one settled turn
  // must not re-fold another that the user already opened.
  const [toolchainOpen, setToolchainOpen] = useState(false);
  const { activity, running } = props;
  const settled = props.settled === true;
  const hasRows = activity.rows.length > 0;
  const hasReasoning = activity.reasoning.trim().length > 0;
  if (!hasRows && !hasReasoning) return null;

  const pinnedRows = alwaysVisibleActivityRows(activity);
  const pinnedIds = new Set(pinnedRows.map(rowKey));
  const foldableRows = activity.rows.filter((row) => !pinnedIds.has(rowKey(row)));
  const summary = settledTurnActivitySummary(activity);
  const foldSettledToolchain =
    settled && !running && summary.length > 0 && (foldableRows.length > 0 || hasReasoning);

  const onToggle = (id: string) => (event: ToggleEvent<HTMLDetailsElement>) => {
    const nextOpen = event.newState === "open";
    setOpenIds((current) => setHas(current, id, nextOpen));
  };

  const onSummaryKeyDown = (id: string) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setOpenIds((current) => setHas(current, id, !current.has(id)));
  };

  const renderDisclosure = (row: CodeActivityRow) => {
    const id = rowKey(row);
    return (
      <ActivityDisclosure
        key={id}
        onKeyDown={onSummaryKeyDown(id)}
        onToggle={onToggle(id)}
        open={openIds.has(id)}
        revealed={revealedSummaryIds.has(id)}
        row={row}
        onReveal={() => setRevealedSummaryIds((current) => setHas(current, id, true))}
      />
    );
  };

  const thinkingDisclosure = hasReasoning ? (
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
          size={14}
          strokeWidth={2}
        />
        <span className="code-transcript-row__name">Thinking</span>
      </summary>
      <p className="code-transcript-row__thinking-body">{activity.reasoning}</p>
    </details>
  ) : null;

  const foldableBody = (
    <>
      {thinkingDisclosure}
      {foldableRows.map(renderDisclosure)}
    </>
  );

  return (
    <div className="code-transcript-row" {...(running ? { "data-live": "true" } : {})}>
      {activity.truncated === true ? (
        <p className="code-transcript-row__truncated">Earliest steps kept</p>
      ) : null}
      {pinnedRows.map(renderDisclosure)}
      {foldSettledToolchain ? (
        <details
          className="code-transcript-row__disclosure code-transcript-row__disclosure--toolchain"
          onToggle={(event) => setToolchainOpen(event.newState === "open")}
          open={toolchainOpen}
        >
          <summary
            aria-expanded={toolchainOpen}
            aria-label={summary}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setToolchainOpen((current) => !current);
            }}
            role="button"
          >
            <ChevronRight
              aria-hidden="true"
              className="code-transcript-row__chevron"
              size={14}
              strokeWidth={2}
            />
            <span className="code-transcript-row__name">{summary}</span>
          </summary>
          <div className="code-transcript-row__toolchain">{foldableBody}</div>
        </details>
      ) : (
        foldableBody
      )}
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
          size={14}
          strokeWidth={2}
        />
        <span className="code-transcript-row__name">{collapsedName(row)}</span>
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
  const summary = row.summary;
  if (summary === undefined) {
    return <p className="code-transcript-row__empty-detail">No summary was recorded.</p>;
  }
  const clipped = clipSummary(summary, props.revealed);
  return (
    <>
      <p className="code-transcript-row__pre">{clipped.text}</p>
      {clipped.clipped ? (
        <OctantButton onClick={props.onReveal} size="sm" type="button" variant="ghost">
          Show all
        </OctantButton>
      ) : null}
    </>
  );
}

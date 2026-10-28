import { ChatRichText } from "../chat/ChatRichText";
import { Check, ChevronRight, Circle, CircleX, Clock3, LoaderCircle } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode, type ToggleEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { PublishedPageCard } from "./PublishedPageCard";
import { PublishedSnapshot } from "./PublishedSnapshot";
import type { DesignRunRuntime } from "../canvas/blocks/designRunningFrame";
import {
  alwaysVisibleActivityRows,
  settledTurnActivitySummary,
  type TurnActivity,
  type TurnActivityRow,
} from "./turnActivity";

export interface TurnActivityRowsProps {
  readonly activity: TurnActivity;
  readonly running: boolean;
  /**
   * When true, the turn has finished and its machinery folds behind one summary
   * line. While a turn is live or waiting on approval, the fold stays open so
   * pending work and diffs remain visible.
   */
  readonly settled?: boolean;
  /**
   * How a published page's snapshot runs its script, by the tool call that
   * published it. Absent leaves such a snapshot unable to run here.
   */
  readonly publishedSnapshotRuntime?: (toolCallId: string) => DesignRunRuntime | undefined;
}

/** Expanded summaries are clipped to this many characters until the user asks for all of it. */
export const TOOL_SUMMARY_PREVIEW_LIMIT = 1_200;

/**
 * Collapsed accessible names clip a task summary here so a 2 KiB journaled
 * message does not become the disclosure's spoken name.
 */
export const ACCESSIBLE_SUMMARY_LIMIT = 120;

function unfinishedTool(row: TurnActivityRow, settled: boolean): boolean {
  return settled && row.kind === "tool" && (row.state === "started" || row.state === "running");
}

function outcomeLabel(row: TurnActivityRow, settled = false): string {
  if (unfinishedTool(row, settled)) return "unfinished";
  switch (row.state) {
    // A started tool is running: the host journals "started" when the call
    // begins and "completed" or "failed" when the provider reports its end.
    // Before the end was journaled every finished tool read "queued" forever.
    case "started":
    case "running":
      return "running";
    case "pending":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
  }
}

/**
 * The mark beside the state word: the same vocabulary the turn header uses,
 * so a running tool and a running turn spin the same way and a finished one
 * carries the same check.
 */
function outcomeIcon(row: TurnActivityRow, settled: boolean) {
  if (unfinishedTool(row, settled)) return Circle;
  switch (row.state) {
    case "started":
    case "running":
      return LoaderCircle;
    case "pending":
      return Circle;
    case "waiting":
      return Clock3;
    case "completed":
      return Check;
    case "failed":
      return CircleX;
  }
}

type PublishedToolRow = Extract<TurnActivityRow, { kind: "tool" }> & {
  readonly published: NonNullable<Extract<TurnActivityRow, { kind: "tool" }>["published"]>;
};

function rowKey(row: TurnActivityRow): string {
  return `${row.kind}:${row.id}`;
}

function boundAccessibleSummary(text: string): string {
  if (text.length <= ACCESSIBLE_SUMMARY_LIMIT) return text;
  return `${text.slice(0, ACCESSIBLE_SUMMARY_LIMIT - 1)}…`;
}

function collapsedName(row: TurnActivityRow): string {
  return row.kind === "tool" ? row.toolName : row.summary;
}

function disclosureName(row: TurnActivityRow, settled: boolean): string {
  const name = row.kind === "tool" ? row.toolName : boundAccessibleSummary(row.summary);
  return `${name}, ${outcomeLabel(row, settled)}`;
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
export function TurnActivityRows(props: TurnActivityRowsProps) {
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
  const foldSettledToolchain = settled && !running && summary.length > 0 && foldableRows.length > 0;
  // A published page is what the turn delivered, so it stays in view below the
  // rows even when the settled toolchain folds away.
  const publishedPages = activity.rows.filter(
    (row): row is PublishedToolRow => row.kind === "tool" && row.published !== undefined,
  );

  const onToggle = (id: string) => (event: ToggleEvent<HTMLDetailsElement>) => {
    const nextOpen = event.newState === "open";
    setOpenIds((current) => setHas(current, id, nextOpen));
  };

  const onSummaryKeyDown = (id: string) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setOpenIds((current) => setHas(current, id, !current.has(id)));
  };

  const renderDisclosure = (row: TurnActivityRow) => {
    const id = rowKey(row);
    return (
      <ActivityDisclosure
        key={id}
        onKeyDown={onSummaryKeyDown(id)}
        onToggle={onToggle(id)}
        open={openIds.has(id)}
        revealed={revealedSummaryIds.has(id)}
        row={row}
        settled={settled && !running}
        onReveal={() => setRevealedSummaryIds((current) => setHas(current, id, true))}
      />
    );
  };

  const thinkingDisclosure = hasReasoning ? (
    <details
      className="turn-activity__disclosure turn-activity__disclosure--thinking"
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
          className="turn-activity__chevron"
          size={14}
          strokeWidth={2}
        />
        <span className="turn-activity__name">Thinking</span>
      </summary>
      <div className="turn-activity__thinking-body">
        <ChatRichText body={activity.reasoning} />
      </div>
    </details>
  ) : null;

  // Live turns keep every row in one stable list so a tool finishing does not
  // remount its disclosure (and clear the open state the user just set). The
  // pinned/foldable split only applies once the outer settled fold is active.
  return (
    <div className="turn-activity" {...(running ? { "data-live": "true" } : {})}>
      {activity.truncated === true ? (
        <p className="turn-activity__truncated">Earliest steps kept</p>
      ) : null}
      {thinkingDisclosure}
      {foldSettledToolchain ? (
        <>
          {pinnedRows.map(renderDisclosure)}
          <details
            className="turn-activity__disclosure turn-activity__disclosure--toolchain"
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
                className="turn-activity__chevron"
                size={14}
                strokeWidth={2}
              />
              <span className="turn-activity__name">{summary}</span>
            </summary>
            <div className="turn-activity__toolchain">{foldableRows.map(renderDisclosure)}</div>
          </details>
        </>
      ) : (
        <>{activity.rows.map(renderDisclosure)}</>
      )}
      {publishedPages.length === 0 ? null : (
        <ul aria-label="Published pages" className="turn-activity__published">
          {publishedPages.map((row) => (
            <li className="turn-activity__published-page" key={rowKey(row)}>
              <PublishedPageCard page={row.published} />
              {row.published.snapshot === undefined ? null : (
                <PublishedSnapshot
                  snapshot={row.published.snapshot}
                  title={row.published.title ?? "Published page"}
                  {...withRuntime(props.publishedSnapshotRuntime?.(row.id))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityDisclosure(props: {
  readonly row: TurnActivityRow;
  readonly settled: boolean;
  readonly open: boolean;
  readonly revealed: boolean;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onToggle: (event: ToggleEvent<HTMLDetailsElement>) => void;
  readonly onReveal: () => void;
}) {
  const { row } = props;
  const StateIcon = outcomeIcon(row, props.settled);
  return (
    <details
      className="turn-activity__disclosure"
      data-kind={row.kind}
      data-state={unfinishedTool(row, props.settled) ? "unfinished" : row.state}
      onToggle={props.onToggle}
      open={props.open}
    >
      <summary
        aria-expanded={props.open}
        aria-label={disclosureName(row, props.settled)}
        onKeyDown={props.onKeyDown}
        role="button"
      >
        <ChevronRight
          aria-hidden="true"
          className="turn-activity__chevron"
          size={14}
          strokeWidth={2}
        />
        <span className="turn-activity__name">{collapsedName(row)}</span>
        <span className="turn-activity__outcome">{outcomeLabel(row, props.settled)}</span>
        <StateIcon
          aria-hidden="true"
          className="turn-activity__status-icon"
          size={12}
          strokeWidth={1.8}
        />
      </summary>
      <div className="turn-activity__body">{activityDetail(row, props)}</div>
    </details>
  );
}

function activityDetail(
  row: TurnActivityRow,
  props: { readonly revealed: boolean; readonly onReveal: () => void },
): ReactNode {
  const summary = row.summary;
  if (summary === undefined) {
    return <p className="turn-activity__empty-detail">No summary was recorded.</p>;
  }
  const clipped = clipSummary(summary, props.revealed);
  return (
    <>
      <p className="turn-activity__pre">{clipped.text}</p>
      {clipped.clipped ? (
        <OctantButton onClick={props.onReveal} size="sm" type="button" variant="ghost">
          Show all
        </OctantButton>
      ) : null}
    </>
  );
}

function withRuntime(runtime: DesignRunRuntime | undefined): {
  readonly runRuntime?: DesignRunRuntime;
} {
  return runtime === undefined ? {} : { runRuntime: runtime };
}

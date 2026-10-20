import type { PublishedPage } from "@octant/contracts";
import { ChatRichText } from "../chat/ChatRichText";
import {
  Check,
  ChevronRight,
  Circle,
  CircleX,
  Clock3,
  Copy,
  ExternalLink,
  Globe,
  LoaderCircle,
} from "lucide-react";
import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type ToggleEvent,
} from "react";
import { MarkdownLink, useExternalLinkOpener } from "../markdown/Markdown";
import { OctantButton } from "../ui/base/OctantButton";
import { copyToClipboard } from "./CodeBlock";
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
  // A published page is what the turn produced, not machinery: its card stays
  // below the rows and outside the settled fold, so it is never buried behind
  // "N tool calls".
  const publishedPages = activity.rows.flatMap((row) =>
    row.kind === "tool" && row.publishedPage !== undefined
      ? [{ id: rowKey(row), page: row.publishedPage }]
      : [],
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
      {publishedPages.map(({ id, page }) => (
        <PublishedPageCard key={id} page={page} />
      ))}
    </div>
  );
}

type CopyState = "idle" | "copied" | "refused";

/** How long the Copy control reports its outcome before it offers to copy again. */
const COPY_RECEIPT_MS = 1600;

function copyLabel(state: CopyState): string {
  switch (state) {
    case "idle":
      return "Copy link";
    case "copied":
      return "Copied";
    case "refused":
      return "Not copied";
  }
}

/**
 * The page a tool published, as the turn's product: its title, its address,
 * and the two things a person does with an address. Open leaves the app the
 * same way a link in the reply does; Copy reports honestly when the host has
 * no clipboard. The tool row above still records the call and its summary.
 */
function PublishedPageCard(props: { readonly page: PublishedPage }) {
  const openExternal = useExternalLinkOpener();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const titleId = useId();
  const title = props.page.title ?? "Published page";

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), COPY_RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  return (
    <section aria-labelledby={titleId} className="turn-published-page">
      <Globe aria-hidden="true" className="turn-published-page__mark" size={16} strokeWidth={1.7} />
      <div className="turn-published-page__text">
        <h3 className="turn-published-page__title" id={titleId} title={title}>
          {title}
        </h3>
        <p className="turn-published-page__url" title={props.page.url}>
          {props.page.url}
        </p>
      </div>
      <div className="turn-published-page__actions">
        <OctantButton
          onClick={() => openExternal(props.page.url)}
          size="sm"
          type="button"
          variant="outline"
        >
          <ExternalLink aria-hidden="true" data-icon="inline-start" strokeWidth={1.7} />
          Open
        </OctantButton>
        <OctantButton
          onClick={() => {
            void copyToClipboard(props.page.url).then((copied) =>
              setCopyState(copied ? "copied" : "refused"),
            );
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" data-icon="inline-start" strokeWidth={2} />
          ) : (
            <Copy aria-hidden="true" data-icon="inline-start" strokeWidth={1.7} />
          )}
          {copyLabel(copyState)}
        </OctantButton>
      </div>
    </section>
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

/** An `https` address inside a summary; the characters a URL in prose never ends on are left out. */
const HTTPS_URL = /https:\/\/[^\s<>"'`()[\]]+/g;

/**
 * A summary's text with each `https` address rendered as a link the person
 * can open or copy. A tool that publishes a page reports where it went; a
 * result the person cannot open is a result they would have to retype.
 */
function summaryWithLinks(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(HTTPS_URL)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <MarkdownLink href={url} key={`${match.index}-${url}`}>
        {url}
      </MarkdownLink>,
    );
    last = match.index + url.length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
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
      <p className="turn-activity__pre">{summaryWithLinks(clipped.text)}</p>
      {clipped.clipped ? (
        <OctantButton onClick={props.onReveal} size="sm" type="button" variant="ghost">
          Show all
        </OctantButton>
      ) : null}
    </>
  );
}

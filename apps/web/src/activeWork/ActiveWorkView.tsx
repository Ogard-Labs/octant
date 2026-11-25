import "../styles/board.css";
import "./active-work.css";
import type { ActiveWorkIssue, ActiveWorkKind, ActiveWorkRow } from "@octant/contracts/active-work";
import type { ThreadBoardStatus } from "@octant/contracts/thread-board";
import { THREAD_BOARD_PROJECT_STATUS_ORDER } from "@octant/domain/thread-board-policy";
import { useState } from "react";
import {
  absoluteTimeFormatter,
  compactRelativeTimeLabel,
  relativeTimeLabel,
} from "../lib/relativeTime";
import { ThreadBoardStatusMark } from "../threadBoard/ThreadBoardCardParts";
import {
  threadBoardStatusLabel,
  threadBoardStatusReasonLabel,
} from "../threadBoard/threadBoardGrouping";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { useActiveWork, type ActiveWorkHost, type ActiveWorkReading } from "./useActiveWork";

/** Rows a section shows before Show all, so a long idle list stays below what needs the person. */
const SECTION_ROWS = 25;

const KIND_LABEL: Readonly<Record<ActiveWorkKind, string | undefined>> = {
  thread: undefined,
  coordinator: "Coordinator",
  subagent: "Subagent",
  "routine-run": "Routine run",
};

const SECTIONS = THREAD_BOARD_PROJECT_STATUS_ORDER.filter((status) => status !== "done");

interface ListedRow {
  readonly host: ActiveWorkHost;
  readonly row: ActiveWorkRow;
}

export interface ActiveWorkViewProps {
  readonly hosts: ReadonlyArray<ActiveWorkHost>;
  /** Whether this window can open a thread of that kind on that computer. */
  readonly canOpen: (host: ActiveWorkHost, row: ActiveWorkRow) => boolean;
  readonly onOpen: (host: ActiveWorkHost, row: ActiveWorkRow) => void;
  readonly onStartThread?: () => void;
}

/**
 * The work that is not Done on every computer this window reaches, in the
 * Board's words. Each computer answers for itself; one that does not answer is
 * named as that, with no rows.
 */
export function ActiveWorkView(props: ActiveWorkViewProps) {
  const readings = useActiveWork(props.hosts);
  const now = Date.now();
  const listed = props.hosts.flatMap((host): ListedRow[] => {
    const reading = readings.get(host.hostId);
    return reading?.status === "answered" ? reading.work.rows.map((row) => ({ host, row })) : [];
  });
  const reading = props.hosts.some((host) => readings.get(host.hostId)?.status === "loading");
  const notes = props.hosts.flatMap((host) => {
    const note = hostNote(host, readings.get(host.hostId), now);
    return note === undefined ? [] : [{ hostId: host.hostId, note }];
  });
  return (
    <div className="active-work">
      {SECTIONS.map((status) => (
        <ActiveWorkSection
          canOpen={props.canOpen}
          key={status}
          now={now}
          onOpen={props.onOpen}
          rows={listed
            .filter(({ row }) => row.board.status === status)
            .toSorted((left, right) => right.row.updatedAt.localeCompare(left.row.updatedAt))}
          status={status}
        />
      ))}
      {listed.length > 0 ? null : reading ? (
        <OctantEmpty layout="line" title="Reading active work…" />
      ) : (
        <OctantEmpty
          layout="line"
          title={
            notes.length === 0 ? "No active work" : "No active work on the computers that answered"
          }
          {...(props.onStartThread === undefined
            ? {}
            : {
                action: (
                  <OctantButton onClick={props.onStartThread} type="button" variant="outline">
                    Start a thread
                  </OctantButton>
                ),
              })}
        />
      )}
      {notes.length === 0 ? null : (
        <ul aria-label="Computers" className="active-work__notes oct-meta">
          {notes.map(({ hostId, note }) => (
            <li key={hostId}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActiveWorkSection(props: {
  readonly status: ThreadBoardStatus;
  readonly rows: ReadonlyArray<ListedRow>;
  readonly now: number;
  readonly canOpen: ActiveWorkViewProps["canOpen"];
  readonly onOpen: ActiveWorkViewProps["onOpen"];
}) {
  const [all, setAll] = useState(false);
  if (props.rows.length === 0) return null;
  const label = threadBoardStatusLabel(props.status);
  const shown = all ? props.rows : props.rows.slice(0, SECTION_ROWS);
  return (
    <section aria-label={`${label} (${String(props.rows.length)})`}>
      <header className="active-work__head oct-meta">
        <h2>{label}</h2>
        <span aria-hidden="true">{props.rows.length}</span>
      </header>
      <ul className="active-work__rows">
        {shown.map(({ host, row }) => (
          <li key={`${host.hostId}:${row.mode}:${row.threadId}:${row.runId ?? ""}`}>
            <ActiveWorkRowItem
              host={host}
              now={props.now}
              row={row}
              {...(props.canOpen(host, row) ? { onOpen: () => props.onOpen(host, row) } : {})}
            />
          </li>
        ))}
      </ul>
      {shown.length === props.rows.length ? null : (
        <OctantButton onClick={() => setAll(true)} type="button" variant="ghost">
          {`Show all ${String(props.rows.length)}`}
        </OctantButton>
      )}
    </section>
  );
}

function ActiveWorkRowItem(props: {
  readonly host: ActiveWorkHost;
  readonly row: ActiveWorkRow;
  readonly now: number;
  readonly onOpen?: () => void;
}) {
  const { host, row } = props;
  const facts = [
    KIND_LABEL[row.kind],
    row.parentTitle === undefined ? undefined : `For ${row.parentTitle}`,
    host.name,
    row.projectName,
    row.repository,
    row.branch === undefined
      ? undefined
      : row.ownWorktree === true
        ? `${row.branch} (own worktree)`
        : row.branch,
    ...row.pullRequests.map(
      (pullRequest) =>
        `PR ${reference(row, pullRequest.owner, pullRequest.repository, pullRequest.number)}`,
    ),
    ...row.issues.map((issue) => issueLabel(row, issue)),
    props.onOpen === undefined ? `Open it on ${host.name}` : undefined,
  ].filter((fact) => fact !== undefined);
  const body = (
    <>
      <ThreadBoardStatusMark
        executing={row.board.reason === "executing"}
        status={row.board.status}
      />
      <span className="active-work__title">{row.title ?? "Subagent"}</span>
      <span className="active-work__reason oct-meta">
        {row.board.status === "waiting" ? threadBoardStatusReasonLabel(row.board.reason) : null}
      </span>
      <span className="active-work__facts oct-meta">
        <span className="active-work__facts-text">{facts.join(" · ")}</span>
        <time
          dateTime={row.updatedAt}
          title={absoluteTimeFormatter.format(new Date(row.updatedAt))}
        >
          {compactRelativeTimeLabel(row.updatedAt, props.now)}
        </time>
      </span>
    </>
  );
  return props.onOpen === undefined ? (
    <div className="active-work__row">{body}</div>
  ) : (
    <OctantButton
      className="active-work__row"
      onClick={props.onOpen}
      title={facts.join(" · ")}
      type="button"
      variant="bare"
    >
      {body}
    </OctantButton>
  );
}

/** `#7` beside the repository the row already names, `owner/name#7` for another. */
function reference(row: ActiveWorkRow, owner: string, repository: string, number: number): string {
  const name = `${owner}/${repository}`;
  return row.repository === name ? `#${String(number)}` : `${name}#${String(number)}`;
}

function issueLabel(row: ActiveWorkRow, issue: ActiveWorkIssue): string {
  return issue.forge === "linear"
    ? issue.identifier
    : `Issue ${reference(row, issue.owner, issue.repository, issue.number)}`;
}

/** What a computer that gave no full answer is said to be, and nothing about its work. */
function hostNote(
  host: ActiveWorkHost,
  reading: ActiveWorkReading | undefined,
  now: number,
): string | undefined {
  switch (reading?.status) {
    case "answered":
      return reading.work.truncated ? `${host.name} has more work than it lists here.` : undefined;
    case "unsupported":
      return `${host.name} runs an older Octant that does not list its work.`;
    case "refused":
      return `${host.name} does not let this device list its work.`;
    case "unreachable":
    case "not-connected": {
      const seen =
        host.lastReadyAt === undefined
          ? "Never connected."
          : `Last connected ${relativeTimeLabel(host.lastReadyAt, now)}.`;
      return `${host.name} is unreachable. ${seen}`;
    }
    case "loading":
      return host.reach === "connecting" ? `Connecting to ${host.name}…` : undefined;
    case undefined:
      return undefined;
  }
}

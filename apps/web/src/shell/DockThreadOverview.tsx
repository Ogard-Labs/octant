import { Check, ChevronRight, Folder, GitBranch, LoaderCircle, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import type { ThreadBoardPullRequestSummary } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import type { RunningThreadFact } from "./dockThreadOverviewModel";

export interface DockThreadFacts {
  readonly project?: string;
  readonly checkout?: { readonly branch?: string; readonly worktree: boolean };
  readonly context?: { readonly label: string; readonly percent: number };
  /** Where the thread runs, by the host's own display name. */
  readonly host?: string;
}

export interface DockThreadChanges {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly onOpenReview: () => void;
}

/** One server this thread's checkout is serving, as the card lists it. */
export interface DockThreadServer {
  readonly id: string;
  readonly label: string;
  readonly port: number;
  readonly listening: boolean;
}

export interface DockThreadOverviewProps {
  /** The mode the thread is in, named at the Environment card's right edge. */
  readonly modeLabel: string;
  readonly running: ReadonlyArray<RunningThreadFact>;
  readonly onOpenRunning: (thread: RunningThreadFact) => void;
  readonly facts: DockThreadFacts;
  /** Code only, and only once the host has observed changed files. */
  readonly changes?: DockThreadChanges | undefined;
  /** The pull request the thread carries, when the board has one. */
  readonly pullRequest?: ThreadBoardPullRequestSummary | undefined;
  /** Code only, and only once the host has observed this checkout's servers. */
  readonly servers?: ReadonlyArray<DockThreadServer> | undefined;
  readonly onOpenEnvironment?: (() => void) | undefined;
}

/**
 * What a thread dock opens on before any tool is chosen: a stack of cards,
 * each one fact group the window already holds — where the thread runs, what
 * it serves, how full its context is, what it changed, and what else is
 * running. A card with nothing true to say is not drawn, so a quiet thread
 * gets a short stack and not a form of blanks. Tools open from the title band
 * above, not from here.
 */
export function DockThreadOverview(props: DockThreadOverviewProps) {
  const { facts } = props;
  const environmentRows = [
    ...(facts.host === undefined
      ? []
      : [{ key: "host", icon: Monitor, label: facts.host, meta: undefined }]),
    ...(facts.project === undefined
      ? []
      : [{ key: "project", icon: Folder, label: facts.project, meta: undefined }]),
    ...(facts.checkout?.branch === undefined
      ? []
      : [
          {
            key: "branch",
            icon: GitBranch,
            label: facts.checkout.branch,
            meta: facts.checkout.worktree ? "Worktree" : undefined,
          },
        ]),
  ];
  const servers = props.servers ?? [];
  const showChanges = props.changes !== undefined || props.pullRequest !== undefined;
  if (
    environmentRows.length === 0 &&
    servers.length === 0 &&
    facts.context === undefined &&
    !showChanges &&
    props.running.length === 0
  ) {
    return null;
  }

  return (
    <div aria-label="Thread overview" className="dock-overview" role="region">
      {environmentRows.length === 0 ? null : (
        <DockCard
          meta={props.modeLabel}
          {...(props.onOpenEnvironment === undefined ? {} : { onOpen: props.onOpenEnvironment })}
          title="Environment"
        >
          {environmentRows.map((row) => (
            <div className="dock-card__row" data-row={row.key} key={row.key}>
              <row.icon
                aria-hidden="true"
                className="dock-card__icon"
                size={14}
                strokeWidth={1.7}
              />
              <span className="dock-card__label" title={row.label}>
                {row.label}
              </span>
              {row.meta === undefined ? null : <span className="dock-card__meta">{row.meta}</span>}
            </div>
          ))}
        </DockCard>
      )}
      {servers.length === 0 ? null : (
        <DockCard
          {...(props.onOpenEnvironment === undefined ? {} : { onOpen: props.onOpenEnvironment })}
          title="Local servers"
        >
          {servers.map((server) => (
            <div className="dock-card__row" key={server.id}>
              <span
                aria-hidden="true"
                className="dock-card__dot"
                data-listening={server.listening ? "true" : "false"}
              />
              <span className="dock-card__label">{server.label}</span>
              <span className="dock-card__meta">{`:${String(server.port)}`}</span>
            </div>
          ))}
        </DockCard>
      )}
      {facts.context === undefined ? null : (
        <DockCard
          meta={`${String(Math.round(facts.context.percent))}%`}
          title="Context"
          aside={<ContextBar percent={facts.context.percent} />}
        >
          <span className="dock-card__detail">{facts.context.label}</span>
        </DockCard>
      )}
      {!showChanges ? null : (
        <DockCard title="Changes">
          {props.changes === undefined ? null : (
            <OctantButton
              aria-label="Open review"
              className="dock-card__row dock-card__action"
              onClick={props.changes.onOpenReview}
              type="button"
              variant="bare"
            >
              <span className="diffstat dock-card__label">
                <span className="add">{`+${props.changes.insertions.toLocaleString()}`}</span>{" "}
                <span className="del">{`−${props.changes.deletions.toLocaleString()}`}</span>
              </span>
              <span className="dock-card__meta">
                {`${props.changes.files.toLocaleString()} ${props.changes.files === 1 ? "file" : "files"}`}
              </span>
            </OctantButton>
          )}
          {props.pullRequest === undefined ? null : (
            <div className="dock-card__row" data-row="pull-request">
              <span className="dock-card__label" title={props.pullRequest.title}>
                {`#${String(props.pullRequest.identity.number)} ${props.pullRequest.title}`}
              </span>
              <span className="dock-card__meta" data-checks={props.pullRequest.checks}>
                {props.pullRequest.checks === "passing" ? (
                  <Check aria-hidden="true" size={12} strokeWidth={2} />
                ) : null}
                {checksWords(props.pullRequest.checks)}
              </span>
            </div>
          )}
        </DockCard>
      )}
      {props.running.length === 0 ? null : (
        <DockCard title="Running now">
          {props.running.map((thread) => (
            <OctantButton
              className="dock-card__row dock-card__action"
              key={`${thread.mode}:${thread.threadId}`}
              onClick={() => props.onOpenRunning(thread)}
              type="button"
              variant="bare"
            >
              <LoaderCircle
                aria-hidden="true"
                className="dock-card__spinner"
                size={14}
                strokeWidth={1.7}
              />
              <span className="dock-card__label">{thread.title}</span>
              {thread.projectName === undefined ? null : (
                <span className="dock-card__meta">{thread.projectName}</span>
              )}
              {thread.age === undefined ? null : (
                <span className="dock-card__meta">{thread.age}</span>
              )}
            </OctantButton>
          ))}
        </DockCard>
      )}
    </div>
  );
}

function checksWords(checks: ThreadBoardPullRequestSummary["checks"]): string {
  switch (checks) {
    case "passing":
      return "Checks pass";
    case "failing":
      return "Checks fail";
    case "pending":
      return "Checks running";
    default:
      return "No checks";
  }
}

/**
 * One card: a title, an optional figure or word at the right, and its rows. A
 * card that opens a tool says so with a chevron on its title, the whole title
 * row being the control.
 */
function DockCard(props: {
  readonly title: string;
  readonly meta?: string;
  readonly aside?: ReactNode;
  readonly onOpen?: () => void;
  readonly children: ReactNode;
}) {
  const head = (
    <>
      <span className="dock-card__title">{props.title}</span>
      {props.onOpen === undefined ? null : (
        <ChevronRight aria-hidden="true" className="dock-card__chevron" size={12} />
      )}
      {props.meta === undefined ? null : <span className="dock-card__figure">{props.meta}</span>}
      {props.aside}
    </>
  );
  return (
    <section aria-label={props.title} className="dock-card">
      {props.onOpen === undefined ? (
        <div className="dock-card__head">{head}</div>
      ) : (
        <OctantButton
          aria-label={`Open ${props.title}`}
          className="dock-card__head dock-card__action"
          onClick={props.onOpen}
          type="button"
          variant="bare"
        >
          {head}
        </OctantButton>
      )}
      <div className="dock-card__rows">{props.children}</div>
    </section>
  );
}

/** The context window's fill as a short bar in the meta ink, beside the figure. */
function ContextBar(props: { readonly percent: number }) {
  const used = Math.max(0, Math.min(100, props.percent));
  return (
    <span
      aria-label="Context used"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(used)}
      className="dock-card__bar"
      role="meter"
    >
      <span style={{ width: `${String(used)}%` }} />
    </span>
  );
}

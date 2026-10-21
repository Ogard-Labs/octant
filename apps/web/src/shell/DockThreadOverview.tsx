import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  LayoutPanelTop,
  LoaderCircle,
  Monitor,
  Radio,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ThreadBoardPullRequestSummary } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSwitch } from "../ui/base/OctantSwitch";
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

/** One thing the thread produced, as the Outputs card lists it. */
export interface DockThreadOutput {
  readonly id: string;
  readonly kind: "file" | "canvas";
  readonly label: string;
  /** The folder a file sits in, so two files of one name read apart. */
  readonly detail?: string;
  readonly onOpen: () => void;
}

/** One agent run this thread's agent handed work to. */
export interface DockThreadBackgroundTask {
  readonly id: string;
  readonly task: string;
  /** "Working", "Done", "To review": the word the Environment tab uses. */
  readonly state: string;
  /** Compact age of the run's last change, such as "4m ago". */
  readonly age?: string;
  readonly onOpen: () => void;
}

/**
 * This computer's remote listener, in a window that administers it. Enabling
 * needs an address and a certificate, so the switch turns the listener off
 * here and sends the person to Settings to turn it on.
 */
export interface DockRemoteAccess {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly onDisable: () => void;
  readonly onOpenSettings: () => void;
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
  /** Documents and Canvases the thread produced, newest first. */
  readonly outputs?: ReadonlyArray<DockThreadOutput> | undefined;
  readonly backgroundTasks?:
    | {
        readonly running: ReadonlyArray<DockThreadBackgroundTask>;
        readonly finished: ReadonlyArray<DockThreadBackgroundTask>;
      }
    | undefined;
  /** Only in a window that administers this computer's remote listener. */
  readonly remoteAccess?: DockRemoteAccess | undefined;
}

/**
 * What a thread dock opens on before any tool is chosen: a stack of cards,
 * each one fact group the window already holds — where the thread runs, what
 * it serves, how full its context is, what it changed, and what else is
 * running, what it produced, and what it handed to other agents. A card with
 * nothing true to say is not drawn, so a quiet thread
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
  const outputs = props.outputs ?? [];
  const runningTasks = props.backgroundTasks?.running ?? [];
  const finishedTasks = props.backgroundTasks?.finished ?? [];
  const showChanges = props.changes !== undefined || props.pullRequest !== undefined;
  const showEnvironment = environmentRows.length > 0 || props.remoteAccess !== undefined;
  if (
    !showEnvironment &&
    servers.length === 0 &&
    facts.context === undefined &&
    !showChanges &&
    outputs.length === 0 &&
    runningTasks.length + finishedTasks.length === 0 &&
    props.running.length === 0
  ) {
    return null;
  }

  return (
    <div aria-label="Thread overview" className="dock-overview" role="region">
      {!showEnvironment ? null : (
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
          {props.remoteAccess === undefined ? null : (
            <RemoteAccessRow remoteAccess={props.remoteAccess} />
          )}
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
      {outputs.length === 0 ? null : (
        <DockCard meta={outputs.length.toLocaleString()} title="Outputs">
          {outputs.map((output) => {
            const Icon = output.kind === "canvas" ? LayoutPanelTop : FileText;
            return (
              <OctantButton
                aria-label={`Open ${output.label}`}
                className="dock-card__row dock-card__action"
                key={output.id}
                onClick={output.onOpen}
                title={
                  output.detail === undefined ? output.label : `${output.detail}/${output.label}`
                }
                type="button"
                variant="bare"
              >
                <Icon aria-hidden="true" className="dock-card__icon" size={14} strokeWidth={1.7} />
                <span className="dock-card__label">{output.label}</span>
                <span className="dock-card__meta">
                  {output.kind === "canvas" ? "Canvas" : (output.detail ?? "")}
                </span>
              </OctantButton>
            );
          })}
        </DockCard>
      )}
      {runningTasks.length + finishedTasks.length === 0 ? null : (
        <BackgroundTasksCard finished={finishedTasks} running={runningTasks} />
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

/**
 * Running runs lead, each with a spinner and its age; finished ones fold under
 * one "N finished" row, since the Agents tool is where they are read.
 */
function BackgroundTasksCard(props: {
  readonly running: ReadonlyArray<DockThreadBackgroundTask>;
  readonly finished: ReadonlyArray<DockThreadBackgroundTask>;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const FoldIcon = showFinished ? ChevronDown : ChevronRight;
  return (
    <DockCard
      {...(props.running.length === 0
        ? {}
        : { meta: `${props.running.length.toLocaleString()} running` })}
      title="Background tasks"
    >
      {props.running.map((task) => (
        <TaskRow key={task.id} running task={task} />
      ))}
      {props.finished.length === 0 ? null : (
        <OctantButton
          aria-expanded={showFinished}
          className="dock-card__row dock-card__action"
          onClick={() => setShowFinished((shown) => !shown)}
          type="button"
          variant="bare"
        >
          <FoldIcon aria-hidden="true" className="dock-card__icon" size={14} strokeWidth={1.7} />
          <span className="dock-card__label dock-card__label--meta">
            {`${props.finished.length.toLocaleString()} finished`}
          </span>
        </OctantButton>
      )}
      {showFinished
        ? props.finished.map((task) => <TaskRow key={task.id} running={false} task={task} />)
        : null}
    </DockCard>
  );
}

function TaskRow(props: { readonly task: DockThreadBackgroundTask; readonly running: boolean }) {
  const { task } = props;
  return (
    <OctantButton
      aria-label={`${task.task}. ${task.state}. Open in Agents`}
      className="dock-card__row dock-card__action"
      onClick={task.onOpen}
      title={task.task}
      type="button"
      variant="bare"
    >
      {props.running ? (
        <LoaderCircle
          aria-hidden="true"
          className="dock-card__spinner"
          size={14}
          strokeWidth={1.7}
        />
      ) : (
        <Check aria-hidden="true" className="dock-card__icon" size={14} strokeWidth={1.7} />
      )}
      <span className="dock-card__label">{task.task}</span>
      <span className="dock-card__meta">
        {props.running ? (task.age ?? task.state) : task.state}
      </span>
    </OctantButton>
  );
}

/**
 * The listener's state as a switch. On turns it off through the host's own
 * administration; off sends the person to Settings, where the address and
 * certificate it needs are chosen and confirmed.
 */
function RemoteAccessRow(props: { readonly remoteAccess: DockRemoteAccess }) {
  const { remoteAccess } = props;
  return (
    <div className="dock-card__row" data-row="remote-access">
      <Radio aria-hidden="true" className="dock-card__icon" size={14} strokeWidth={1.7} />
      <span className="dock-card__label">Remote access</span>
      <span className="dock-card__meta">
        <OctantSwitch
          checked={remoteAccess.enabled}
          disabled={remoteAccess.busy}
          label="Remote access"
          onCheckedChange={(checked) => {
            if (checked) remoteAccess.onOpenSettings();
            else remoteAccess.onDisable();
          }}
        />
      </span>
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

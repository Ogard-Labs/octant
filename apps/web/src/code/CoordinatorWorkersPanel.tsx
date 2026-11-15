import { Network, X } from "lucide-react";
import { useState } from "react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { WorkerMark } from "../projects/coordinatorMarks";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { PullRequestChip } from "./PullRequestChip";
import {
  COORDINATOR_WORKER_STATE_WORDS,
  coordinatorWorkerSections,
  type CoordinatorWorkerRow,
} from "./coordinatorWorkerPanel";
import { useCoordinatorWorkersPanel } from "./coordinatorWorkersPanelStore";
import "./coordinator-workers.css";

/** The workers a coordinator's thread shows, and the action that opens one. */
export interface CoordinatorWorkersSource {
  readonly rows: ReadonlyArray<CoordinatorWorkerRow>;
  readonly onOpenWorker: (threadId: string) => void;
}

/**
 * The Workers button in a coordinator's pane header. It opens the panel beside
 * the transcript, and the count says how many workers need you so a closed
 * panel hides nothing.
 */
export function CoordinatorWorkersToggle(props: {
  readonly coordinatorThreadId: string;
  readonly workerCount: number;
  readonly needsYouCount: number;
}) {
  const [open, setOpen] = useCoordinatorWorkersPanel(props.coordinatorThreadId);
  return (
    <OctantButton
      aria-expanded={open}
      className="coordinator-workers-toggle window-no-drag"
      onClick={() => setOpen(!open)}
      // The pane header's grip starts a drag on pointerdown; a press that
      // begins on this control must stay a click.
      onPointerDown={(event) => event.stopPropagation()}
      size="sm"
      type="button"
      variant="ghost"
    >
      <Network aria-hidden="true" size={14} />
      Workers
      {props.workerCount === 0 ? null : (
        <span className="coordinator-workers-toggle__count">{props.workerCount}</span>
      )}
      {props.needsYouCount === 0 ? null : (
        <span className="sr-only">{`, ${String(props.needsYouCount)} need you`}</span>
      )}
    </OctantButton>
  );
}

/**
 * What a worker's pane header says: whose worker it is and the way back. The
 * worker is listed nowhere new by being open (docs/design/workspace.md#coordinators).
 */
export function WorkerOfStrip(props: {
  readonly coordinatorTitle: string;
  readonly onBack: () => void;
}) {
  return (
    <span className="worker-of-strip window-no-drag">
      <WorkerMark coordinatorName={props.coordinatorTitle} size={14} />
      <span className="worker-of-strip__label" title={`Worker of ${props.coordinatorTitle}`}>
        {`Worker of ${props.coordinatorTitle}`}
      </span>
      <OctantButton
        onClick={props.onBack}
        onPointerDown={(event) => event.stopPropagation()}
        size="sm"
        type="button"
        variant="ghost"
      >
        Back to coordinator
      </OctantButton>
    </span>
  );
}

function WorkerRow(props: {
  readonly row: CoordinatorWorkerRow;
  readonly now: number;
  readonly onOpen: (threadId: string) => void;
  readonly onSelectPullRequest?: ((row: CoordinatorWorkerRow) => void) | undefined;
}) {
  const { row } = props;
  const select = props.onSelectPullRequest;
  return (
    <li className="coordinator-workers-panel__row" data-state={row.state}>
      <OctantButton
        className="coordinator-workers-panel__open"
        onClick={() => props.onOpen(row.threadId)}
        type="button"
        variant="bare"
      >
        <span className="coordinator-workers-panel__title" title={row.title}>
          {row.title}
        </span>
        <span className="coordinator-workers-panel__facts">
          <span className="coordinator-workers-panel__state">
            {COORDINATOR_WORKER_STATE_WORDS[row.state]}
          </span>
          <span className="coordinator-workers-panel__model" title={row.modelLabel}>
            {row.modelLabel}
          </span>
          {row.updatedAt === undefined ? null : (
            <span title={row.updatedAt}>{relativeTimeLabel(row.updatedAt, props.now)}</span>
          )}
        </span>
      </OctantButton>
      {row.pullRequest === undefined ? null : (
        <PullRequestChip
          checks={row.pullRequest.checks}
          className="coordinator-workers-panel__pull-request"
          number={row.pullRequest.identity.number}
          state={row.pullRequest.state}
          {...(select === undefined ? {} : { onOpen: () => select(row) })}
        />
      )}
    </li>
  );
}

function Section(props: {
  readonly label: string;
  readonly rows: ReadonlyArray<CoordinatorWorkerRow>;
  readonly now: number;
  readonly onOpen: (threadId: string) => void;
  readonly onSelectPullRequest?: ((row: CoordinatorWorkerRow) => void) | undefined;
}) {
  if (props.rows.length === 0) return null;
  return (
    <section aria-label={props.label} className="coordinator-workers-panel__section">
      <h3>{`${props.label} · ${String(props.rows.length)}`}</h3>
      <ul>
        {props.rows.map((row) => (
          <WorkerRow
            key={row.threadId}
            now={props.now}
            onOpen={props.onOpen}
            onSelectPullRequest={props.onSelectPullRequest}
            row={row}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * A coordinator's workers beside its transcript: Needs you, Working, In
 * review, and Done folded. It reads the window's Code thread list, the same
 * rows the Agents tool's Workers section reads, so a worker this window cannot
 * see is never listed. A row opens the worker.
 */
export function CoordinatorWorkersPanel(props: {
  readonly coordinatorThreadId: string;
  readonly coordinatorTitle: string;
  readonly source: CoordinatorWorkersSource;
  readonly now?: number;
  readonly onSelectPullRequest?: (row: CoordinatorWorkerRow) => void;
}) {
  const [, setOpen] = useCoordinatorWorkersPanel(props.coordinatorThreadId);
  const [showDone, setShowDone] = useState(false);
  const now = props.now ?? Date.now();
  const sections = coordinatorWorkerSections(props.source.rows);
  return (
    <aside
      aria-label={`Workers of ${props.coordinatorTitle}`}
      className="coordinator-workers-panel"
    >
      <header className="coordinator-workers-panel__header">
        <h2>Workers</h2>
        <OctantIconButton label="Close Workers" onClick={() => setOpen(false)}>
          <X aria-hidden="true" size={14} />
        </OctantIconButton>
      </header>
      {props.source.rows.length === 0 ? (
        <p className="coordinator-workers-panel__empty">
          No workers yet. Ask the coordinator to start some.
        </p>
      ) : null}
      <Section
        label="Needs you"
        now={now}
        onOpen={props.source.onOpenWorker}
        onSelectPullRequest={props.onSelectPullRequest}
        rows={sections.needsYou}
      />
      <Section
        label="Working"
        now={now}
        onOpen={props.source.onOpenWorker}
        onSelectPullRequest={props.onSelectPullRequest}
        rows={sections.working}
      />
      <Section
        label="In review"
        now={now}
        onOpen={props.source.onOpenWorker}
        onSelectPullRequest={props.onSelectPullRequest}
        rows={sections.inReview}
      />
      {sections.done.length === 0 ? null : (
        <section aria-label="Done" className="coordinator-workers-panel__section">
          <h3>{`Done · ${String(sections.done.length)}`}</h3>
          {showDone ? (
            <ul>
              {sections.done.map((row) => (
                <WorkerRow
                  key={row.threadId}
                  now={now}
                  onOpen={props.source.onOpenWorker}
                  onSelectPullRequest={props.onSelectPullRequest}
                  row={row}
                />
              ))}
            </ul>
          ) : null}
          <OctantButton
            aria-expanded={showDone}
            onClick={() => setShowDone((current) => !current)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {showDone ? "Show less" : "Show more"}
          </OctantButton>
        </section>
      )}
    </aside>
  );
}

/**
 * A small card in the coordinator's transcript for a worker it started: its
 * title, model and live state, from host facts and never agent text. Clicking
 * opens the worker.
 */
export function CoordinatorWorkerCards(props: {
  readonly rows: ReadonlyArray<CoordinatorWorkerRow>;
  readonly onOpenWorker: (threadId: string) => void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <div className="coordinator-worker-cards thread-column">
      {props.rows.map((row) => (
        <OctantButton
          aria-label={`Worker ${row.title}, ${COORDINATOR_WORKER_STATE_WORDS[row.state]}`}
          className="coordinator-worker-card"
          data-state={row.state}
          key={row.threadId}
          onClick={() => props.onOpenWorker(row.threadId)}
          type="button"
          variant="bare"
        >
          <WorkerMark size={14} />
          <span className="coordinator-worker-card__title" title={row.title}>
            {row.title}
          </span>
          <span className="coordinator-worker-card__model">{row.modelLabel}</span>
          <span className="coordinator-worker-card__state">
            {COORDINATOR_WORKER_STATE_WORDS[row.state]}
          </span>
        </OctantButton>
      ))}
    </div>
  );
}

/** The panel beside the transcript while this coordinator's Workers button has it open. */
export function CoordinatorWorkersPanelSlot(props: {
  readonly coordinatorThreadId: string;
  readonly coordinatorTitle: string;
  readonly source: CoordinatorWorkersSource;
  readonly onSelectPullRequest?: (row: CoordinatorWorkerRow) => void;
}) {
  const [open] = useCoordinatorWorkersPanel(props.coordinatorThreadId);
  return open ? <CoordinatorWorkersPanel {...props} /> : null;
}

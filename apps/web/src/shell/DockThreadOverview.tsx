import { LoaderCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { RunningThreadFact } from "./dockThreadOverviewModel";

export interface DockThreadFacts {
  readonly project?: string;
  readonly checkout?: { readonly branch?: string; readonly worktree: boolean };
  readonly model?: string;
  readonly access?: string;
  readonly context?: { readonly label: string; readonly percent: number };
}

export interface DockThreadChanges {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly onOpenReview: () => void;
}

export interface DockThreadOverviewProps {
  readonly running: ReadonlyArray<RunningThreadFact>;
  readonly onOpenRunning: (thread: RunningThreadFact) => void;
  readonly facts: DockThreadFacts;
  /** Code only, and only once the host has observed changed files. */
  readonly changes?: DockThreadChanges | undefined;
}

/**
 * What a thread dock opens on before any tool is chosen: what else is running,
 * what this thread is, and what it has changed.
 *
 * Every row is a fact the window already holds. A value the window does not
 * have is left out rather than shown as a placeholder, and a section with no
 * rows is not drawn, so a quiet thread gets a short overview and not a form of
 * blanks.
 */
export function DockThreadOverview(props: DockThreadOverviewProps) {
  const facts = props.facts;
  const hasFacts =
    facts.project !== undefined ||
    facts.checkout !== undefined ||
    facts.model !== undefined ||
    facts.access !== undefined ||
    facts.context !== undefined;
  if (props.running.length === 0 && !hasFacts && props.changes === undefined) return null;

  return (
    <div aria-label="Thread overview" className="dock-overview" role="region">
      {props.running.length === 0 ? null : (
        <section aria-labelledby="dock-overview-running" className="dock-overview__section">
          <h2 className="dock-overview__label" id="dock-overview-running">
            Running now
          </h2>
          <ul className="dock-overview__running">
            {props.running.map((thread) => (
              <li key={`${thread.mode}:${thread.threadId}`}>
                <OctantButton
                  className="dock-overview__running-row"
                  onClick={() => props.onOpenRunning(thread)}
                  type="button"
                  variant="ghost"
                >
                  <LoaderCircle
                    aria-hidden="true"
                    className="dock-overview__spinner"
                    size={14}
                    strokeWidth={1.7}
                  />
                  <span className="dock-overview__running-title">{thread.title}</span>
                  {thread.projectName === undefined ? null : (
                    <span className="dock-overview__project">
                      <span aria-hidden="true" className="dock-overview__dot" />
                      <span className="dock-overview__project-name">{thread.projectName}</span>
                    </span>
                  )}
                  {thread.age === undefined ? null : (
                    <span className="dock-overview__age">{thread.age}</span>
                  )}
                </OctantButton>
              </li>
            ))}
          </ul>
        </section>
      )}
      {hasFacts ? (
        <section aria-labelledby="dock-overview-thread" className="dock-overview__section">
          <h2 className="dock-overview__label" id="dock-overview-thread">
            This thread
          </h2>
          <dl className="dock-overview__facts">
            {facts.project === undefined ? null : (
              <Fact label="Project">
                <span className="dock-overview__value">{facts.project}</span>
              </Fact>
            )}
            {facts.checkout === undefined ? null : (
              <Fact label="Checkout">
                {facts.checkout.branch === undefined ? null : (
                  <span className="dock-overview__chip" title={facts.checkout.branch}>
                    {facts.checkout.branch}
                  </span>
                )}
                {facts.checkout.worktree ? (
                  <span className="dock-overview__value">Worktree</span>
                ) : null}
              </Fact>
            )}
            {facts.model === undefined ? null : (
              <Fact label="Model">
                <span className="dock-overview__value">{facts.model}</span>
              </Fact>
            )}
            {facts.access === undefined ? null : (
              <Fact label="Access">
                <span className="dock-overview__value">{facts.access}</span>
              </Fact>
            )}
            {facts.context === undefined ? null : (
              <Fact label="Context">
                <span className="dock-overview__value">
                  {`${facts.context.label} (${String(Math.round(facts.context.percent))}%)`}
                </span>
                <span
                  aria-label="Context used"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(Math.max(0, Math.min(100, facts.context.percent)))}
                  className="dock-overview__meter"
                  role="meter"
                  style={
                    {
                      "--dock-overview-fill": `${String(Math.max(0, Math.min(100, facts.context.percent)))}%`,
                    } as CSSProperties
                  }
                />
              </Fact>
            )}
          </dl>
        </section>
      ) : null}
      {props.changes === undefined ? null : (
        <section aria-labelledby="dock-overview-changes" className="dock-overview__section">
          <h2 className="dock-overview__label" id="dock-overview-changes">
            Changes
          </h2>
          <div className="dock-overview__changes">
            <span className="dock-overview__value">
              {`${props.changes.files.toLocaleString()} ${props.changes.files === 1 ? "file" : "files"}`}
            </span>
            <span className="dock-overview__diffstat">
              <span>{`+${props.changes.insertions.toLocaleString()}`}</span>
              <span>{`−${props.changes.deletions.toLocaleString()}`}</span>
            </span>
            <OctantButton
              className="dock-overview__review"
              onClick={props.changes.onOpenReview}
              size="sm"
              type="button"
              variant="secondary"
            >
              Open review
            </OctantButton>
          </div>
        </section>
      )}
    </div>
  );
}

function Fact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="dock-overview__fact">
      <dt className="dock-overview__fact-label">{props.label}</dt>
      <dd className="dock-overview__fact-value">{props.children}</dd>
    </div>
  );
}

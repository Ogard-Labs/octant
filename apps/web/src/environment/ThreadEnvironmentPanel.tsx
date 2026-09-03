import type { EnvironmentCompactIdentity } from "@octant/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface ThreadEnvironmentSummaryFacts {
  readonly identity: EnvironmentCompactIdentity;
  readonly branch?: string;
  readonly changes?: "clean" | "dirty";
  readonly workingLocation?: string;
  readonly runningServerCount?: number;
}

export interface ThreadEnvironmentPanelProps {
  readonly summary: ThreadEnvironmentSummaryFacts;
  readonly open: boolean;
  readonly active?: boolean;
  readonly children?: ReactNode;
}

/**
 * Routes the active pane's authoritative Environment into the right dock.
 * The dock tab is the only way in; the title band used to carry a second
 * Environment button, which duplicated the tab once Environment moved into
 * the dock. Without a dock host the content renders in place, which is how
 * component tests and non-shell hosts see it.
 */
export function ThreadEnvironmentPanel(props: ThreadEnvironmentPanelProps) {
  const [dockHost, setDockHost] = useState<Element | null>(null);
  const active = props.active !== false;
  const shown = active && props.open;
  const facts = summaryFacts(props.summary);

  useEffect(() => {
    setDockHost(shown ? document.querySelector("[data-octant-environment-dock]") : null);
  }, [shown]);

  if (!shown) return null;
  const content = (
    <section
      aria-label="Environment details"
      className="thread-environment-dock"
      data-environment-status={props.summary.identity.status}
    >
      <header className="thread-environment-dock__header">
        <h2>Environment</h2>
        <span>{[props.summary.identity.label, ...facts].join(" · ")}</span>
      </header>
      <div className="thread-environment-dock__body">{props.children}</div>
    </section>
  );
  return dockHost === null ? content : createPortal(content, dockHost);
}

function summaryFacts(summary: ThreadEnvironmentSummaryFacts): ReadonlyArray<string> {
  const facts: string[] = [];
  if (summary.branch !== undefined) facts.push(summary.branch);
  else facts.push(summary.identity.detail);
  if (summary.changes !== undefined) facts.push(summary.changes === "dirty" ? "Dirty" : "Clean");
  // "." is the repository root: saying so adds nothing to the identity line.
  if (summary.workingLocation !== undefined && summary.workingLocation !== ".") {
    facts.push(summary.workingLocation);
  }
  if (summary.runningServerCount !== undefined)
    facts.push(runningServerLabel(summary.runningServerCount));
  return facts;
}

export function runningServerLabel(count: number): string {
  return count === 1 ? "1 server" : `${String(count)} servers`;
}

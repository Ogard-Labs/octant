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

  // The dock host can mount after the panel opens, and the dock replaces it
  // whenever it re-keys the tool body — the tool tab and the pane's
  // Environment arrive on different renders. A single lookup left the panel
  // inline above the transcript, or portalled into a detached element and so
  // invisible. Follow whatever host the document currently holds.
  useEffect(() => {
    if (!shown) {
      setDockHost(null);
      return;
    }
    const sync = () => {
      const next = document.querySelector("[data-octant-environment-dock]");
      setDockHost((current) => (current === next ? current : next));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
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
  // The detail is the folder; when a Project is named after its folder the
  // line read "octant · octant", so the repeat is dropped.
  else if (summary.identity.detail !== summary.identity.label) facts.push(summary.identity.detail);
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

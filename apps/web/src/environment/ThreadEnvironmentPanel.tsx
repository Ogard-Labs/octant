import { DockModuleBoundary } from "../shell/DockModuleBoundary";
import type { EnvironmentCompactIdentity } from "@octant/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LocalServerGroupCounts } from "./localServerGroups";

export interface ThreadEnvironmentSummaryFacts {
  readonly identity: EnvironmentCompactIdentity;
  readonly branch?: string;
  readonly changes?: "clean" | "dirty";
  readonly workingLocation?: string;
  readonly runningServerCount?: number;
  readonly runningServerCounts?: LocalServerGroupCounts;
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
  const headline = headlineFacts(props.summary);
  const sentence = [props.summary.identity.label, ...facts].join(" · ");

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
      {/* The dock strip's tab already says Environment; the rail names what the
          thread works in and the heading stays for readers who navigate by
          heading. It was one dotted sentence of every fact, which a 320px dock
          cut off mid-word; the name leads now, then the branch and whether the
          checkout is clean, and the rest lives in its own section below. */}
      <header className="thread-environment-dock__header" title={sentence}>
        <h2 className="visually-hidden">Environment</h2>
        {/* The whole summary stays one sentence for assistive technology;
            the visible parts are its layout. */}
        <span className="visually-hidden">{sentence}</span>
        <span aria-hidden="true" className="thread-environment-dock__name">
          {props.summary.identity.label}
        </span>
        {headline.place === undefined ? null : (
          <span aria-hidden="true" className="thread-environment-dock__place">
            {headline.place}
          </span>
        )}
        {props.summary.changes === undefined ? null : (
          <span
            aria-hidden="true"
            className="thread-environment-dock__state"
            data-state={props.summary.changes}
          >
            {props.summary.changes === "dirty" ? "Changes" : "Clean"}
          </span>
        )}
      </header>
      <div className="thread-environment-dock__body">{props.children}</div>
    </section>
  );
  const isolated = <DockModuleBoundary>{content}</DockModuleBoundary>;
  return dockHost === null ? isolated : createPortal(isolated, dockHost);
}

/** The one place fact the header shows beside the name: the branch, or the folder. */
function headlineFacts(summary: ThreadEnvironmentSummaryFacts): { readonly place?: string } {
  if (summary.branch !== undefined) return { place: summary.branch };
  if (summary.identity.detail !== summary.identity.label) return { place: summary.identity.detail };
  return {};
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
  if (summary.runningServerCounts !== undefined) {
    facts.push(runningServerSummaryLabel(summary.runningServerCounts));
  } else if (summary.runningServerCount !== undefined) {
    facts.push(runningServerLabel(summary.runningServerCount));
  }
  return facts;
}

export function runningServerLabel(count: number): string {
  return count === 1 ? "1 server" : `${String(count)} servers`;
}

export function runningServerSummaryLabel(counts: LocalServerGroupCounts): string {
  const currentLabel = `${String(counts.currentCheckout)} ${
    counts.currentCheckout === 1 ? "server" : "servers"
  } in this checkout`;
  const otherLabel = `${String(counts.other)} ${counts.other === 1 ? "server" : "servers"} elsewhere`;
  return `${currentLabel} · ${otherLabel}`;
}

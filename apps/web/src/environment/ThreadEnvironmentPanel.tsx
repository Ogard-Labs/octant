import { GitBranch } from "lucide-react";
import { DockModuleBoundary } from "../shell/DockModuleBoundary";
import type { EnvironmentCompactIdentity } from "@octant/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LocalServerGroupCounts } from "./localServerGroups";

export interface ThreadEnvironmentSummaryFacts {
  readonly identity: EnvironmentCompactIdentity;
  readonly branch?: string;
  /** The checkout's folder on disk, shown under the name. */
  readonly path?: string;
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
      {/* The dock strip's tab already says Environment; the header names
          what the thread works in — the name on its own line, then where:
          the branch and the folder. It had carried the name, the branch and a
          Changes pill, and the section under it then listed the branch and
          the repository again. Whether the checkout has changes is the
          Changes card's to say. */}
      <header className="thread-environment-dock__header" title={sentence}>
        <h2 className="visually-hidden">Environment</h2>
        {/* The whole summary stays one sentence for assistive technology;
            the visible parts are its layout. */}
        <span className="visually-hidden">{sentence}</span>
        <span aria-hidden="true" className="thread-environment-dock__name">
          {props.summary.identity.label}
        </span>
        {headline.branch === undefined && headline.place === undefined ? null : (
          <span aria-hidden="true" className="thread-environment-dock__meta">
            {headline.branch === undefined ? null : (
              <span className="thread-environment-dock__branch">
                <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
                <span>{headline.branch}</span>
              </span>
            )}
            {headline.place === undefined ? null : (
              <span className="thread-environment-dock__place">{headline.place}</span>
            )}
          </span>
        )}
      </header>
      <div className="thread-environment-dock__body">{props.children}</div>
    </section>
  );
  const isolated = <DockModuleBoundary>{content}</DockModuleBoundary>;
  return dockHost === null ? isolated : createPortal(isolated, dockHost);
}

/** Where the thread works, under its name: the branch, then the folder. */
function headlineFacts(summary: ThreadEnvironmentSummaryFacts): {
  readonly branch?: string;
  readonly place?: string;
} {
  const folder =
    summary.path !== undefined
      ? homeRelative(summary.path)
      : summary.identity.detail !== summary.identity.label
        ? summary.identity.detail
        : undefined;
  return {
    ...(summary.branch === undefined ? {} : { branch: summary.branch }),
    ...(folder === undefined ? {} : { place: folder }),
  };
}

/**
 * A home-directory path read from its home: the account folder repeats on
 * every row and pushed the part that tells two checkouts apart out of a
 * 320px dock.
 */
function homeRelative(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
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

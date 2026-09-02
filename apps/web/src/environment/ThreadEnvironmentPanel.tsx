import type { EnvironmentCompactIdentity } from "@octant/contracts";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../shell/IconButton";

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
  readonly onOpen: (opener: HTMLElement) => void;
  readonly active?: boolean;
  readonly inlineFallback?: boolean;
  readonly children?: ReactNode;
}

/** Routes the active pane's authoritative Environment into the right dock. */
export function ThreadEnvironmentPanel(props: ThreadEnvironmentPanelProps) {
  const summaryId = useId();
  const [toolbarHost, setToolbarHost] = useState<Element | null>(null);
  const [dockHost, setDockHost] = useState<Element | null>(null);
  const active = props.active !== false;
  const facts = summaryFacts(props.summary);
  const summary = `${props.summary.identity.label} · ${facts.join(" · ")}`;

  useEffect(() => {
    setToolbarHost(document.querySelector("[data-octant-environment-action]"));
  }, []);

  useEffect(() => {
    setDockHost(
      active && props.open ? document.querySelector("[data-octant-environment-dock]") : null,
    );
  }, [active, props.open]);

  const trigger = (
    <div className="thread-environment-summary">
      <span className="sr-only" id={summaryId}>
        {summary}
      </span>
      <IconButton
        aria-describedby={summaryId}
        aria-pressed={props.open}
        className="thread-environment-summary__button"
        data-environment-status={props.summary.identity.status}
        icon={SlidersHorizontal}
        label="Open Environment"
        onClick={(event) => props.onOpen(event.currentTarget)}
      />
    </div>
  );
  const content = (
    <section aria-label="Environment details" className="thread-environment-dock">
      <header className="thread-environment-dock__header">
        <h2>Environment</h2>
        <span>{props.summary.identity.label}</span>
      </header>
      <div className="thread-environment-dock__body">{props.children}</div>
    </section>
  );

  return (
    <>
      {active ? (toolbarHost === null ? trigger : createPortal(trigger, toolbarHost)) : null}
      {dockHost === null && active && props.open && props.inlineFallback === true ? content : null}
      {dockHost === null ? null : createPortal(content, dockHost)}
    </>
  );
}

function summaryFacts(summary: ThreadEnvironmentSummaryFacts): ReadonlyArray<string> {
  const facts: string[] = [];
  if (summary.branch !== undefined) facts.push(summary.branch);
  else facts.push(summary.identity.detail);
  if (summary.changes !== undefined) facts.push(summary.changes === "dirty" ? "Dirty" : "Clean");
  if (summary.workingLocation !== undefined) facts.push(summary.workingLocation);
  if (summary.runningServerCount !== undefined)
    facts.push(runningServerLabel(summary.runningServerCount));
  return facts;
}

export function runningServerLabel(count: number): string {
  return count === 1 ? "1 server" : `${String(count)} servers`;
}

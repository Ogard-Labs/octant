import type { EnvironmentCompactIdentity } from "@octant/contracts";
import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";

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
  readonly onOpenChange: (open: boolean) => void;
  /**
   * False when another pane is in front. The disclosure is renderer state, so
   * activating a different pane must close it rather than leave a stale overlay.
   */
  readonly active?: boolean;
  readonly children?: ReactNode;
}

/**
 * Compact thread-header Environment summary with a transient disclosure.
 * Open or closed is renderer state: it is not persisted and is not a journaled
 * preference. Escape, an outside pointer, or losing the pane closes it.
 */
export function ThreadEnvironmentPanel(props: ThreadEnvironmentPanelProps) {
  const onOpenChangeRef = useRef(props.onOpenChange);
  onOpenChangeRef.current = props.onOpenChange;
  const panelTitleId = useId();
  const summaryId = useId();
  const [toolbarHost, setToolbarHost] = useState<Element | null>(() =>
    typeof document === "undefined"
      ? null
      : document.querySelector("[data-octant-environment-action]"),
  );
  const active = props.active !== false;
  const facts = summaryFacts(props.summary);
  const summary = `${props.summary.identity.label} · ${facts.join(" · ")}`;

  useEffect(() => {
    setToolbarHost(document.querySelector("[data-octant-environment-action]"));
  }, []);

  useEffect(() => {
    if (active || !props.open) return;
    onOpenChangeRef.current(false);
  }, [active, props.open]);

  const environment = (
    <div className="thread-environment-summary">
      <span className="sr-only" id={summaryId}>
        {summary}
      </span>
      <OctantPopover
        align="end"
        className="thread-environment-disclosure window-no-drag"
        onOpenChange={props.onOpenChange}
        open={props.open}
        side="bottom"
        titledBy={panelTitleId}
        trigger={<SlidersHorizontal aria-hidden="true" size={16} strokeWidth={1.7} />}
        triggerClassName="thread-environment-summary__button"
        triggerDataAttributes={{ "data-environment-status": props.summary.identity.status }}
        triggerDescribedBy={summaryId}
        triggerLabel="Toggle environment"
        triggerTooltip="Toggle environment"
        triggerVariant="ghost"
      >
        <header className="thread-environment-disclosure__header">
          <div className="thread-environment-disclosure__heading">
            <h2 id={panelTitleId}>Environment</h2>
            <span>{props.summary.identity.label}</span>
          </div>
          <OctantButton
            aria-label="Close environment"
            className="thread-environment-disclosure__close"
            onClick={() => props.onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" size={16} strokeWidth={1.7} />
          </OctantButton>
        </header>
        <div className="thread-environment-disclosure__body">{props.children}</div>
      </OctantPopover>
    </div>
  );
  return toolbarHost === null ? environment : createPortal(environment, toolbarHost);
}

function summaryFacts(summary: ThreadEnvironmentSummaryFacts): ReadonlyArray<string> {
  const facts: string[] = [];
  if (summary.branch !== undefined) facts.push(summary.branch);
  else facts.push(summary.identity.detail);
  if (summary.changes !== undefined) facts.push(summary.changes === "dirty" ? "Dirty" : "Clean");
  if (summary.workingLocation !== undefined) facts.push(summary.workingLocation);
  if (summary.runningServerCount !== undefined) {
    facts.push(runningServerLabel(summary.runningServerCount));
  }
  return facts;
}

export function runningServerLabel(count: number): string {
  return count === 1 ? "1 server" : `${String(count)} servers`;
}

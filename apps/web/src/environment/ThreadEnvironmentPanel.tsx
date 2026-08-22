import type { EnvironmentCompactIdentity } from "@octant/contracts";
import { PanelsTopLeft } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OctantButton } from "../ui/base/OctantButton";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(props.onOpenChange);
  onOpenChangeRef.current = props.onOpenChange;
  const panelId = useId();
  const [toolbarHost, setToolbarHost] = useState<Element | null>(() =>
    typeof document === "undefined"
      ? null
      : document.querySelector("[data-octant-environment-action]"),
  );
  const active = props.active !== false;
  const facts = summaryFacts(props.summary);
  const action = props.open ? "Hide" : "Show";
  const name = `${action} environment for ${props.summary.identity.label}. ${facts.join(" · ")}`;

  useEffect(() => {
    setToolbarHost(document.querySelector("[data-octant-environment-action]"));
  }, []);

  useEffect(() => {
    if (active || !props.open) return;
    onOpenChangeRef.current(false);
  }, [active, props.open]);

  useEffect(() => {
    if (!props.open) return;
    panelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (triggerRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) {
        return;
      }
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      onOpenChangeRef.current(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onOpenChangeRef.current(false);
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.open]);

  const environment = (
    <div className="thread-environment-summary">
      <OctantButton
        aria-controls={panelId}
        aria-expanded={props.open}
        aria-haspopup="dialog"
        aria-label={name}
        className="thread-environment-summary__button"
        data-environment-status={props.summary.identity.status}
        onClick={() => props.onOpenChange(!props.open)}
        ref={triggerRef}
        title={name}
        type="button"
        variant="ghost"
      >
        <PanelsTopLeft aria-hidden="true" size={15} strokeWidth={1.7} />
        <span className="sr-only">Environment</span>
      </OctantButton>
      {props.open ? (
        <div
          aria-label={`Environment for ${props.summary.identity.label}`}
          className="popover-panel thread-environment-disclosure window-no-drag"
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="thread-environment-disclosure__body">{props.children}</div>
        </div>
      ) : null}
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

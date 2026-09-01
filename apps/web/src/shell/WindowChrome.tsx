import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, PanelBottom, PanelLeftOpen, PanelRight, SquarePen } from "lucide-react";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "./hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { IconButton } from "./IconButton";

export interface WindowChromeProps {
  readonly activeSurface: string;
  readonly dockAvailable: boolean;
  readonly dockExpanded: boolean;
  readonly dockLabel: string;
  readonly bottomPanelAvailable?: boolean;
  readonly bottomPanelExpanded?: boolean;
  readonly hostBridge?: OctantHostBridge;
  readonly isNarrow: boolean;
  readonly material: ResolvedSidebarMaterial;
  readonly nativeTitlebarInset?: boolean;
  readonly onRecoverZen?: () => void;
  readonly onToggleDock: (opener: HTMLElement) => void;
  readonly onToggleBottomPanel?: (opener: HTMLElement) => void;
  /** Present only while the sidebar is hidden: the chrome takes over the leading edge. */
  readonly onExpandSidebar?: () => void;
  /** Keeps the primary creation action reachable while navigation is collapsed. */
  readonly onNewThread?: () => void;
  readonly zenRecoveryNeeded?: boolean;
}

/**
 * Publishes the trailing cluster's measured width so the pane header can end
 * its box — and its drag region — before the window controls start. The
 * cluster's width depends on which controls the active thread renders, so a
 * constant here goes stale the moment a control is added or hidden.
 */
/**
 * Publish a cluster's measured width so the pane header can reserve exactly the
 * band the rendered controls occupy.
 *
 * The node arrives through a callback ref rather than an object ref: the
 * leading cluster only mounts once the sidebar collapses, and an effect keyed
 * on the property name alone never re-ran for it, so it silently fell back to
 * the literal instead of measuring.
 */
function useMeasuredClusterWidth(property: string): (node: HTMLDivElement | null) => void {
  const [cluster, setCluster] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (cluster === null) return;
    const surface = (cluster.closest(".shell-frame") ?? document.documentElement) as HTMLElement;
    const publish = () => {
      const width = Math.ceil(cluster.getBoundingClientRect().width);
      if (width > 0) surface.style.setProperty(property, `${width}px`);
    };
    publish();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(publish);
    observer?.observe(cluster);
    // The reserve describes a cluster that is no longer there, so it goes with
    // it — including when there was no observer to disconnect.
    return () => {
      observer?.disconnect();
      surface.style.removeProperty(property);
    };
  }, [cluster, property]);
  return setCluster;
}

export function WindowChrome(props: WindowChromeProps) {
  const recoverZen = props.onRecoverZen;
  const trailing = useMeasuredClusterWidth("--octant-window-chrome-reserved-width");
  const leading = useMeasuredClusterWidth("--octant-window-chrome-leading-width");
  return (
    <header
      aria-label={`Workspace actions for ${props.activeSurface}`}
      className={`window-chrome window-chrome--material-${props.material}`}
    >
      {props.onExpandSidebar === undefined ? null : (
        <div
          className={`window-chrome__leading window-no-drag${
            props.nativeTitlebarInset === true ? "" : " window-chrome__leading--browser"
          }`}
          ref={leading}
        >
          {props.nativeTitlebarInset === true ? (
            <span aria-hidden="true" className="window-chrome__traffic-light-space" />
          ) : null}
          <IconButton
            className="window-chrome__button"
            icon={PanelLeftOpen}
            label="Show sidebar"
            onClick={props.onExpandSidebar}
          />
          {props.onNewThread === undefined ? null : (
            <IconButton
              className="window-chrome__button window-chrome__new-thread"
              icon={SquarePen}
              label="New thread"
              onClick={props.onNewThread}
            />
          )}
        </div>
      )}
      <span aria-hidden="true" className="window-chrome__drag-space" />
      {props.zenRecoveryNeeded ? (
        <div className="window-chrome__zen-recovery window-no-drag" role="status">
          <span>Zen needs recovery.</span>
          {recoverZen === undefined ? null : (
            <OctantButton
              className="window-chrome__text-button"
              onClick={recoverZen}
              type="button"
              variant="ghost"
            >
              Recover Zen
            </OctantButton>
          )}
        </div>
      ) : null}
      <div className="window-chrome__trailing window-no-drag" ref={trailing}>
        <span className="window-chrome__open-in-action" data-octant-open-in-action />
        <span className="window-chrome__environment-action" data-octant-environment-action />
        {props.isNarrow ? (
          <NarrowOverflow
            dockAvailable={props.dockAvailable}
            dockExpanded={props.dockExpanded}
            dockLabel={props.dockLabel}
            bottomPanelAvailable={props.bottomPanelAvailable === true}
            bottomPanelExpanded={props.bottomPanelExpanded === true}
            {...(props.onToggleBottomPanel === undefined
              ? {}
              : { onToggleBottomPanel: props.onToggleBottomPanel })}
            onToggleDock={props.onToggleDock}
            {...(recoverZen === undefined || !props.zenRecoveryNeeded
              ? {}
              : { onRecoverZen: recoverZen })}
          />
        ) : (
          <>
            {props.bottomPanelAvailable !== true ||
            props.onToggleBottomPanel === undefined ? null : (
              <IconButton
                aria-controls="bottom-utility-panel"
                aria-expanded={props.bottomPanelExpanded === true}
                className="window-chrome__button"
                data-bottom-panel-opener="true"
                icon={PanelBottom}
                label={`${props.bottomPanelExpanded === true ? "Close" : "Open"} bottom panel`}
                onClick={(event) => props.onToggleBottomPanel?.(event.currentTarget)}
              />
            )}
            {props.dockAvailable ? (
              <IconButton
                aria-controls="right-utility-dock"
                aria-expanded={props.dockExpanded}
                className="window-chrome__button"
                data-dock-opener="true"
                icon={PanelRight}
                label={`${props.dockExpanded ? "Close" : "Open"} ${props.dockLabel}`}
                onClick={(event) => props.onToggleDock(event.currentTarget)}
              />
            ) : null}
          </>
        )}
      </div>
    </header>
  );
}

function NarrowOverflow(props: {
  readonly bottomPanelAvailable: boolean;
  readonly bottomPanelExpanded: boolean;
  readonly dockAvailable: boolean;
  readonly dockExpanded: boolean;
  readonly dockLabel: string;
  readonly onRecoverZen?: () => void;
  readonly onToggleBottomPanel?: (opener: HTMLElement) => void;
  readonly onToggleDock: (opener: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const recoverZen = props.onRecoverZen;
  const disclosureId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const disclosure = useRef<HTMLDivElement>(null);

  // Every action here is conditional, so the menu focuses whichever one is
  // actually first rather than a named action that may not have rendered.
  useEffect(() => {
    if (open) disclosure.current?.querySelector("button")?.focus();
  }, [open]);

  function close(): void {
    setOpen(false);
    trigger.current?.focus();
  }

  function select(action: () => Promise<void> | void): void {
    close();
    void action();
  }

  return (
    <div className="window-chrome__overflow window-no-drag">
      <IconButton
        aria-controls={disclosureId}
        aria-expanded={open}
        className="window-chrome__button"
        data-dock-opener={props.dockAvailable ? "true" : undefined}
        icon={MoreHorizontal}
        label="More window actions"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
      />
      {open ? (
        <div
          className="window-chrome__disclosure"
          id={disclosureId}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
          ref={disclosure}
        >
          {recoverZen === undefined ? null : (
            <DisclosureAction label="Recover Zen" onClick={() => select(recoverZen)} />
          )}
          {props.bottomPanelAvailable && props.onToggleBottomPanel !== undefined ? (
            <DisclosureAction
              ariaControls="bottom-utility-panel"
              expanded={props.bottomPanelExpanded}
              label={`${props.bottomPanelExpanded ? "Close" : "Open"} bottom panel`}
              logicalTarget="bottom-panel"
              onClick={() =>
                select(() => {
                  if (trigger.current !== null) props.onToggleBottomPanel?.(trigger.current);
                })
              }
            />
          ) : null}
          {props.dockAvailable ? (
            <DisclosureAction
              ariaControls="right-utility-dock"
              expanded={props.dockExpanded}
              label={`${props.dockExpanded ? "Close" : "Open"} ${props.dockLabel}`}
              logicalTarget="dock"
              onClick={() =>
                select(() => {
                  if (trigger.current !== null) props.onToggleDock(trigger.current);
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DisclosureAction(props: {
  readonly ariaControls?: string;
  readonly expanded?: boolean;
  readonly label: string;
  readonly logicalTarget?: "bottom-panel" | "dock";
  readonly onClick: () => Promise<void> | void;
}) {
  return (
    <OctantButton
      {...(props.ariaControls === undefined ? {} : { "aria-controls": props.ariaControls })}
      {...(props.expanded === undefined ? {} : { "aria-expanded": props.expanded })}
      className="window-chrome__disclosure-action"
      data-bottom-panel-opener={props.logicalTarget === "bottom-panel" ? "true" : undefined}
      data-dock-opener={props.logicalTarget === "dock" ? "true" : undefined}
      onClick={props.onClick}
      type="button"
      variant="ghost"
    >
      {props.label}
    </OctantButton>
  );
}

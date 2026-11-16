import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, PanelLeftOpen, SquarePen } from "../ui/icons";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "./hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { useActionShortcut } from "../keybindings/useActionShortcut";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { IconButton } from "./IconButton";
import { TitleBandChanges, type TitleBandChangesFacts } from "./TitleBandChanges";
import { ApplicationIdentity } from "./ApplicationIdentity";
import type { WindowHistory } from "./windowHistory";
import { WindowHistoryButtons } from "./WindowHistoryButtons";

export interface WindowChromeProps {
  readonly activeSurface: string;
  readonly dockAvailable: boolean;
  readonly dockExpanded: boolean;
  readonly dockLabel: string;
  readonly hostBridge?: OctantHostBridge;
  readonly isNarrow: boolean;
  readonly material: ResolvedSidebarMaterial;
  readonly nativeTitlebarInset?: boolean;
  readonly onRecoverZen?: () => void;
  readonly onToggleDock: (opener: HTMLElement) => void;
  /** Present only while the sidebar is hidden: the chrome takes over the leading edge. */
  readonly onExpandSidebar?: () => void;
  /** Keeps the primary creation action reachable while navigation is collapsed. */
  readonly onNewThread?: () => void;
  readonly newThreadLabel?: string;
  readonly zenRecoveryNeeded?: boolean;
  /** The open Code thread's uncommitted changes; absent when it has no checkout to measure. */
  readonly changes?: TitleBandChangesFacts;
  /** Back and forward, shown beside Show sidebar while the sidebar is hidden. */
  readonly history?: WindowHistory;
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
  const newThreadShortcut = useActionShortcut("new-thread");
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
          {props.hostBridge?.applicationIdentity !== undefined ? (
            <ApplicationIdentity productName={props.hostBridge.applicationIdentity.productName} />
          ) : null}
          {props.history === undefined ? null : (
            <WindowHistoryButtons className="window-chrome__button" history={props.history} />
          )}
          {props.onNewThread === undefined ? null : (
            <OctantTooltip label={props.newThreadLabel ?? "New task"} shortcut={newThreadShortcut}>
              <IconButton
                className="window-chrome__button window-chrome__new-thread"
                icon={SquarePen}
                label={props.newThreadLabel ?? "New task"}
                onClick={props.onNewThread}
                // The tooltip names the button; a native title would say it twice.
                title=""
              />
            </OctantTooltip>
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
              variant="bare"
            >
              Recover Zen
            </OctantButton>
          )}
        </div>
      ) : null}
      <div className="window-chrome__trailing window-no-drag" ref={trailing}>
        <span className="window-chrome__open-in-action" data-octant-project-actions />
        <span className="window-chrome__open-in-action" data-octant-open-in-action />
        {props.isNarrow ? (
          <NarrowOverflow
            dockAvailable={props.dockAvailable}
            dockExpanded={props.dockExpanded}
            dockLabel={props.dockLabel}
            onToggleDock={props.onToggleDock}
            {...(recoverZen === undefined || !props.zenRecoveryNeeded
              ? {}
              : { onRecoverZen: recoverZen })}
          />
        ) : props.changes === undefined ? null : (
          <TitleBandChanges changes={props.changes} />
        )}
      </div>
    </header>
  );
}

function NarrowOverflow(props: {
  readonly dockAvailable: boolean;
  readonly dockExpanded: boolean;
  readonly dockLabel: string;
  readonly onRecoverZen?: () => void;
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
  readonly logicalTarget?: "dock";
  readonly onClick: () => Promise<void> | void;
}) {
  return (
    <OctantButton
      {...(props.ariaControls === undefined ? {} : { "aria-controls": props.ariaControls })}
      {...(props.expanded === undefined ? {} : { "aria-expanded": props.expanded })}
      className="window-chrome__disclosure-action"
      data-dock-opener={props.logicalTarget === "dock" ? "true" : undefined}
      onClick={props.onClick}
      type="button"
      variant="bare"
    >
      {props.label}
    </OctantButton>
  );
}

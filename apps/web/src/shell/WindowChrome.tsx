import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, PanelLeftOpen, PanelRight, Sparkles } from "lucide-react";
import type { OctantHostBridge, ResolvedSidebarMaterial } from "./hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { IconButton } from "./IconButton";

export interface WindowChromeProps {
  readonly activeSurface: string;
  readonly dockAvailable: boolean;
  readonly dockExpanded: boolean;
  readonly dockLabel: string;
  readonly developmentAuthentication?: boolean;
  readonly hostBridge?: OctantHostBridge;
  readonly isNarrow: boolean;
  readonly material: ResolvedSidebarMaterial;
  readonly onOpenZen?: () => void;
  readonly onRecoverZen?: () => void;
  readonly onToggleDock: (opener: HTMLElement) => void;
  /** Present only while the sidebar is hidden: the chrome takes over the leading edge. */
  readonly onExpandSidebar?: () => void;
  readonly zenRecoveryNeeded?: boolean;
}

export function WindowChrome(props: WindowChromeProps) {
  const openZen = props.onOpenZen;
  const recoverZen = props.onRecoverZen;
  return (
    <header
      aria-label={`Workspace actions for ${props.activeSurface}`}
      className={`window-chrome window-chrome--material-${props.material} window-drag-region`}
    >
      {props.onExpandSidebar === undefined ? null : (
        <div className="window-chrome__leading">
          <span aria-hidden="true" className="window-chrome__traffic-light-space" />
          <IconButton
            className="window-chrome__button"
            icon={PanelLeftOpen}
            label="Show sidebar"
            onClick={props.onExpandSidebar}
          />
        </div>
      )}
      <span aria-hidden="true" className="window-chrome__drag-space" />
      {props.developmentAuthentication ? (
        <span
          className="badge badge-warn window-chrome__development-auth window-no-drag"
          role="status"
        >
          Development authentication
        </span>
      ) : null}
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
      <div className="window-chrome__trailing window-no-drag">
        {props.isNarrow ? (
          <NarrowOverflow
            dockAvailable={props.dockAvailable}
            dockExpanded={props.dockExpanded}
            dockLabel={props.dockLabel}
            onToggleDock={props.onToggleDock}
            {...(openZen === undefined ? {} : { onOpenZen: openZen })}
            {...(recoverZen === undefined || !props.zenRecoveryNeeded
              ? {}
              : { onRecoverZen: recoverZen })}
          />
        ) : (
          <>
            {openZen === undefined ? null : (
              <IconButton
                className="window-chrome__button"
                icon={Sparkles}
                label="Open Zen"
                onClick={openZen}
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
  readonly dockAvailable: boolean;
  readonly dockExpanded: boolean;
  readonly dockLabel: string;
  readonly onOpenZen?: () => void;
  readonly onRecoverZen?: () => void;
  readonly onToggleDock: (opener: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const openZen = props.onOpenZen;
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
          {openZen === undefined ? null : (
            <DisclosureAction label="Open Zen" onClick={() => select(openZen)} />
          )}
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
      variant="ghost"
    >
      {props.label}
    </OctantButton>
  );
}

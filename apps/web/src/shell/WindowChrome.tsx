import { useEffect, useId, useRef, useState, type Ref } from "react";
import { Frame, MoreHorizontal, PanelRight, RotateCcw, Sparkles } from "lucide-react";
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
  readonly onResetLayout: () => void;
  readonly onResetWindowBounds?: () => Promise<void> | void;
  readonly onToggleDock: () => void;
  readonly zenRecoveryNeeded?: boolean;
}

export function WindowChrome(props: WindowChromeProps) {
  const resetWindowBounds = props.onResetWindowBounds;
  const openZen = props.onOpenZen;
  const recoverZen = props.onRecoverZen;
  return (
    <header
      aria-label={`Workspace actions for ${props.activeSurface}`}
      className={`window-chrome window-chrome--material-${props.material}`}
    >
      <span aria-hidden="true" className="window-chrome__drag-space window-drag-region" />
      {props.developmentAuthentication ? (
        <span className="window-chrome__development-auth window-no-drag" role="status">
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
      <div className="window-chrome__trailing">
        {props.isNarrow ? (
          <NarrowOverflow
            dockAvailable={props.dockAvailable}
            dockExpanded={props.dockExpanded}
            dockLabel={props.dockLabel}
            onResetLayout={props.onResetLayout}
            onToggleDock={props.onToggleDock}
            {...(openZen === undefined ? {} : { onOpenZen: openZen })}
            {...(recoverZen === undefined || !props.zenRecoveryNeeded
              ? {}
              : { onRecoverZen: recoverZen })}
            {...(resetWindowBounds === undefined ? {} : { onResetWindowBounds: resetWindowBounds })}
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
                onClick={props.onToggleDock}
              />
            ) : null}
            <IconButton
              className="window-chrome__button"
              icon={RotateCcw}
              label="Reset layout"
              onClick={props.onResetLayout}
            />
            {resetWindowBounds === undefined ? null : (
              <IconButton
                className="window-chrome__button"
                icon={Frame}
                label="Reset window bounds"
                onClick={resetWindowBounds}
              />
            )}
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
  readonly onResetLayout: () => void;
  readonly onResetWindowBounds?: () => Promise<void> | void;
  readonly onToggleDock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const resetWindowBounds = props.onResetWindowBounds;
  const openZen = props.onOpenZen;
  const recoverZen = props.onRecoverZen;
  const disclosureId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) firstAction.current?.focus();
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
        >
          <DisclosureAction
            buttonRef={firstAction}
            label="Reset layout"
            onClick={() => select(props.onResetLayout)}
          />
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
              onClick={() => select(props.onToggleDock)}
            />
          ) : null}
          {resetWindowBounds === undefined ? null : (
            <DisclosureAction
              label="Reset window bounds"
              onClick={() => select(resetWindowBounds)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function DisclosureAction(props: {
  readonly ariaControls?: string;
  readonly buttonRef?: Ref<HTMLButtonElement>;
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
      ref={props.buttonRef}
      type="button"
      variant="ghost"
    >
      {props.label}
    </OctantButton>
  );
}

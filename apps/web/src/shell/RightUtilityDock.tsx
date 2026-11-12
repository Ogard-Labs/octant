import { MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { OctantDialog } from "../ui/base/OctantDialog";
import {
  RightUtilityDockSurface,
  type DockTileControls,
  type RightUtilityDockSurfaceProps,
} from "./RightUtilityDockSurface";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import type { DockToolButtonsProps } from "./DockToolButtons";
import { ShellResizeHandle } from "./ShellResizeHandle";
import {
  dockWidthCeiling,
  type RightUtilityDockResolution,
  type RightUtilityDockSurfaceDescriptor,
  type RightUtilityDockSurfaceId,
  type RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";

export interface RightUtilityDockProps {
  readonly activeTabId?: string;
  readonly agents?: ReactNode;
  readonly browser?: ReactNode;
  readonly canvas?: ReactNode;
  readonly review?: ReactNode;
  readonly delivery?: ReactNode;
  readonly document?: ReactNode;
  readonly files?: ReactNode;
  readonly iosSimulator?: ReactNode;
  readonly androidEmulator?: ReactNode;
  readonly desktop?: ReactNode;
  readonly debug?: ReactNode;
  readonly vitals?: ReactNode;
  readonly isNarrow: boolean;
  readonly onClose: () => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onCommitWidth: (width: number) => void;
  /** A drag was abandoned: drop the preview rather than keep the width it started from. */
  readonly onCancelWidthPreview?: () => void;
  readonly onOpenTab: (surface: RightUtilityDockSurfaceId) => void;
  readonly onPreviewWidth: (width: number) => void;
  readonly onSelectSurface: (tabId: string) => void;
  readonly open: boolean;
  readonly overview?: ReactNode;
  readonly plan?: ReactNode;
  readonly resolution: RightUtilityDockResolution;
  readonly shelf?: RightUtilityDockSurfaceProps["shelf"];
  readonly renderTab?: (tab: RightUtilityDockTabDescriptor) => ReactNode;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
  readonly sideChat?: ReactNode;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor>;
  readonly terminal?: ReactNode;
  readonly tests?: ReactNode;
  readonly tiles?: DockTileControls;
  /** The row of tool buttons the drawer's header carries; absent when docked. */
  readonly toolRow?: DockToolButtonsProps;
  readonly toolsAwaitingThread?: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly width: number;
}

export function RightUtilityDock(props: RightUtilityDockProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dock = useRef<HTMLElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState<number>();
  // What is drawn, not what is stored: the stylesheet clamps the stored width
  // to the room the thread leaves, and the separator announced the stored one.
  const [drawnWidth, setDrawnWidth] = useState<number>();
  const ceiling = dockWidthCeiling(workspaceWidth, {
    tileColumns: props.isNarrow ? 1 : (props.tiles?.layout?.columns.length ?? 1),
    viewportWidth: typeof window === "undefined" ? undefined : window.innerWidth,
  });

  useLayoutEffect(() => {
    const workspace = dock.current?.parentElement;
    if (workspace === null || workspace === undefined) return;
    const measure = () => {
      const style = getComputedStyle(workspace);
      const width =
        workspace.clientWidth -
        (Number.parseFloat(style.paddingInlineStart) || 0) -
        (Number.parseFloat(style.paddingInlineEnd) || 0);
      setWorkspaceWidth(width > 0 ? width : undefined);
      const drawn = dock.current?.getBoundingClientRect().width ?? 0;
      setDrawnWidth(drawn > 0 ? Math.round(drawn) : undefined);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    if (dock.current !== null) observer.observe(dock.current);
    return () => observer.disconnect();
  }, [props.isNarrow, props.open]);

  if (!props.open && !props.isNarrow) return null;

  // Only the narrow dock is a modal that nothing else can dismiss. Docked, the
  // window chrome's disclosure closes it, so the header carries no second
  // close of its own.
  const dismiss = props.isNarrow ? { closeButtonRef: closeButton, onClose: props.onClose } : {};
  const surface = (
    <RightUtilityDockSurface
      {...(props.activeTabId === undefined ? {} : { activeTabId: props.activeTabId })}
      {...(props.agents === undefined ? {} : { agents: props.agents })}
      {...(props.browser === undefined ? {} : { browser: props.browser })}
      {...(props.canvas === undefined ? {} : { canvas: props.canvas })}
      {...(props.review === undefined ? {} : { review: props.review })}
      {...(props.delivery === undefined ? {} : { delivery: props.delivery })}
      {...(props.document === undefined ? {} : { document: props.document })}
      {...(props.files === undefined ? {} : { files: props.files })}
      {...(props.iosSimulator === undefined ? {} : { iosSimulator: props.iosSimulator })}
      {...(props.androidEmulator === undefined ? {} : { androidEmulator: props.androidEmulator })}
      {...(props.desktop === undefined ? {} : { desktop: props.desktop })}
      {...(props.debug === undefined ? {} : { debug: props.debug })}
      {...(props.vitals === undefined ? {} : { vitals: props.vitals })}
      onCloseTab={props.onCloseTab}
      onOpenTab={props.onOpenTab}
      onSelectSurface={props.onSelectSurface}
      {...(props.overview === undefined ? {} : { overview: props.overview })}
      {...(props.plan === undefined ? {} : { plan: props.plan })}
      resolution={props.resolution}
      {...(props.renderTab === undefined ? {} : { renderTab: props.renderTab })}
      {...(props.shelf === undefined ? {} : { shelf: props.shelf })}
      {...(props.sideChat === undefined ? {} : { sideChat: props.sideChat })}
      tabs={props.tabs}
      {...(props.terminal === undefined ? {} : { terminal: props.terminal })}
      {...(props.tests === undefined ? {} : { tests: props.tests })}
      {...(props.tiles === undefined ? {} : { tiles: props.tiles })}
      {...(props.toolRow === undefined ? {} : { toolRow: props.toolRow })}
      {...(props.toolsAwaitingThread === undefined
        ? {}
        : { toolsAwaitingThread: props.toolsAwaitingThread })}
      {...dismiss}
    />
  );

  if (props.isNarrow) {
    return (
      <OctantDialogPresence>
        {props.open ? (
          <OctantDialog
            initialFocus={closeButton}
            label={
              props.resolution.kind === "closed" ? "Right sidebar" : props.resolution.surface.label
            }
            onClose={props.onClose}
            open
            popupId="right-utility-dock"
            {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
          >
            {surface}
          </OctantDialog>
        ) : null}
      </OctantDialogPresence>
    );
  }

  return (
    <aside
      aria-label="Right Utility Dock"
      className="right-utility-dock window-no-drag"
      id="right-utility-dock"
      ref={dock}
    >
      <ShellResizeHandle
        accessibleName="Resize utility dock"
        className="right-utility-dock__resize"
        edge="leading"
        maximum={ceiling}
        minimum={MIN_CONTEXT_SIDEBAR_WIDTH}
        {...(props.onCancelWidthPreview === undefined
          ? {}
          : { onCancel: props.onCancelWidthPreview })}
        onCommit={props.onCommitWidth}
        onPreview={props.onPreviewWidth}
        value={Math.min(drawnWidth ?? props.width, ceiling)}
      />
      {surface}
    </aside>
  );
}

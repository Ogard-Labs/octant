import { X } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { DockUtilityLauncher } from "./DockUtilityLauncher";
import { IconButton } from "./IconButton";
import { ShellResizeHandle } from "./ShellResizeHandle";
import { MAX_BOTTOM_PANEL_HEIGHT, MIN_BOTTOM_PANEL_HEIGHT } from "./useShellPresentation";
import type {
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";
import { DockToolStrip } from "./DockToolStrip";
import { DockBarRow, useFoldedControls } from "./DockBarRow";
import { DockBarContext, useDockBarSlot } from "./dockBarControls";

export interface BottomUtilityPanelProps {
  readonly height: number;
  readonly onClose: (surface?: RightUtilityDockSurfaceId) => void;
  readonly onCommitHeight: (height: number) => void;
  readonly onPreviewHeight: (height: number) => void;
  readonly onOpenTool: (surface: RightUtilityDockSurfaceId) => void;
  readonly activeSurface: RightUtilityDockSurfaceDescriptor;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly launchableSurfaces: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
  readonly content: ReactNode;
}

/**
 * Horizontal utility region owned by the active pane. Terminal is the first
 * supported tab; the tab strip is deliberate so future horizontal tools do
 * not require another panel model.
 */
export function BottomUtilityPanel(props: BottomUtilityPanelProps) {
  // The shown tool's controls stand in this bar, between the tabs and Hide,
  // under the rules a tile's bar follows: 24px controls with 14px glyphs, 4px
  // apart, folded into one menu before anything is cut. The bar itself stays
  // the 44px band the tabs stand in.
  const { host, items } = useDockBarSlot("bottom");
  const controls = useRef<HTMLDivElement>(null);
  const fold = useFoldedControls(controls, items ?? [], 0);
  return (
    <section
      aria-label="Bottom panel"
      className="bottom-utility-panel window-no-drag"
      id="bottom-utility-panel"
      style={{ "--octant-bottom-panel-height": `${props.height}px` } as CSSProperties}
    >
      <ShellResizeHandle
        accessibleName="Resize bottom panel"
        className="bottom-utility-panel__resize"
        edge="top"
        maximum={MAX_BOTTOM_PANEL_HEIGHT}
        minimum={MIN_BOTTOM_PANEL_HEIGHT}
        onCommit={props.onCommitHeight}
        onPreview={props.onPreviewHeight}
        value={props.height}
      />
      <header className="bottom-utility-panel__toolbar">
        {/* DockToolStrip owns the tablist and its arrow-key movement. Naming
            this wrapper a second one nested the widget and swept the launcher,
            which is a button and not a tab, inside it. */}
        <div className="bottom-utility-panel__tabs">
          <DockToolStrip
            active={props.activeSurface.id}
            onClose={(tabId) => {
              const surface = props.tabs.find((tab) => tab.id === tabId);
              if (surface !== undefined) props.onClose(surface.id);
            }}
            onSelect={(tabId) => {
              const surface = props.tabs.find((tab) => tab.id === tabId);
              if (surface !== undefined) props.onOpenTool(surface.id);
            }}
            tabs={props.tabs}
          />
          <DockUtilityLauncher
            onOpen={props.onOpenTool}
            surfaces={props.launchableSurfaces.filter(
              (surface) => !props.tabs.some((tab) => tab.id === surface.id),
            )}
          />
        </div>
        <div className="bottom-utility-panel__controls" ref={controls}>
          <DockBarRow
            fold={fold === "row" ? "menu" : fold}
            items={items ?? []}
            scrollCues
            toolLabel={props.activeSurface.label}
          />
        </div>
        <IconButton icon={X} label="Hide bottom panel" onClick={() => props.onClose()} />
      </header>
      <DockBarContext.Provider value={host}>
        <div className="bottom-utility-panel__content">{props.content}</div>
      </DockBarContext.Provider>
    </section>
  );
}

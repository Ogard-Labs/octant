import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { DockUtilityLauncher } from "./DockUtilityLauncher";
import { IconButton } from "./IconButton";
import { ShellResizeHandle } from "./ShellResizeHandle";
import { MAX_BOTTOM_PANEL_HEIGHT, MIN_BOTTOM_PANEL_HEIGHT } from "./useShellPresentation";
import type {
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";
import { DockToolStrip } from "./DockToolStrip";

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
        <div aria-label="Bottom panel tools" className="bottom-utility-panel__tabs" role="tablist">
          <DockToolStrip
            active={props.activeSurface.id}
            onClose={props.onClose}
            onSelect={props.onOpenTool}
            tabs={props.tabs}
          />
          <DockUtilityLauncher
            onOpen={props.onOpenTool}
            surfaces={props.launchableSurfaces.filter(
              (surface) => !props.tabs.some((tab) => tab.id === surface.id),
            )}
          />
        </div>
        <IconButton icon={X} label="Hide bottom panel" onClick={() => props.onClose()} />
      </header>
      <div className="bottom-utility-panel__content">{props.content}</div>
    </section>
  );
}

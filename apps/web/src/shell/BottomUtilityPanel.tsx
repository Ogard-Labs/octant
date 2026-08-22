import { X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { DockToolIcon } from "./dockToolIcons";
import { IconButton } from "./IconButton";
import { ShellResizeHandle } from "./ShellResizeHandle";
import { MAX_BOTTOM_PANEL_HEIGHT, MIN_BOTTOM_PANEL_HEIGHT } from "./useShellPresentation";

export interface BottomUtilityPanelProps {
  readonly height: number;
  readonly onClose: () => void;
  readonly onCommitHeight: (height: number) => void;
  readonly onPreviewHeight: (height: number) => void;
  readonly terminal: ReactNode;
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
          <span aria-selected="true" className="bottom-utility-panel__tab" role="tab" tabIndex={0}>
            <DockToolIcon surface="terminal" />
            <span>Terminal</span>
          </span>
        </div>
        <IconButton icon={X} label="Hide bottom panel" onClick={props.onClose} />
      </header>
      <div className="bottom-utility-panel__content">{props.terminal}</div>
    </section>
  );
}

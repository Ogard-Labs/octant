import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
  NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH,
} from "@octant/contracts/shell";
import type { SidebarVibrancyMode, ThemeSettings, ThemeTypography } from "@octant/contracts/theme";
import type { ResolvedSidebarMaterial } from "./hostBridge";
import type { TranscriptTextSize, TranscriptWidth } from "@octant/contracts/shell";
import { ShellResizeHandle } from "./ShellResizeHandle";
import { ThemeTypographyProvider } from "../theme/TypographyProvider";
import { ThemeSettingsProvider } from "../theme/ThemeSettingsProvider";

export interface ShellFrameProps {
  readonly children?: ReactNode;
  readonly chrome: ReactNode;
  readonly contextSidebarWidth: number;
  readonly material: ResolvedSidebarMaterial;
  readonly onCommitSidebarWidth: (width: number) => void;
  readonly onPreviewSidebarWidth: (width: number) => void;
  readonly sidebar: ReactNode;
  readonly sidebarCollapsed?: boolean;
  readonly projectsSidebarOpen?: boolean;
  readonly sidebarResizable: boolean;
  readonly sidebarVibrancyMode?: SidebarVibrancyMode;
  readonly sidebarWidth: number;
  readonly standaloneSurface?: ReactNode;
  readonly workspaceMaterial?: ResolvedSidebarMaterial;
  /**
   * The application ground drawn under the whole shell when its scope is
   * everywhere. The workspace and its panes go transparent over it; the
   * sidebar does too only when `backdropCoversSidebar` says so.
   */
  readonly backdrop?: ReactNode;
  readonly backdropCoversSidebar?: boolean;
  readonly typography?: ThemeTypography;
  readonly theme?: ThemeSettings;
  readonly availableFonts?: ReadonlyArray<string>;
  readonly wideContextOpen: boolean;
  readonly bottomPanelOpen?: boolean;
  readonly bottomPanelHeight?: number;
  readonly workspace: ReactNode;
  readonly transcriptTextSize?: TranscriptTextSize;
  readonly transcriptWidth?: TranscriptWidth;
  readonly showThreadProviderIcons?: boolean;
}

export interface ShellThemeRootProps {
  readonly availableFonts?: ReadonlyArray<string>;
  readonly children: ReactNode;
  readonly theme?: ThemeSettings;
  readonly typography?: ThemeTypography;
}

export function ShellThemeRoot(props: ShellThemeRootProps) {
  return (
    <ThemeSettingsProvider {...(props.theme === undefined ? {} : { settings: props.theme })}>
      <ThemeTypographyProvider
        {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
        {...(props.typography === undefined ? {} : { typography: props.typography })}
      >
        {props.children}
      </ThemeTypographyProvider>
    </ThemeSettingsProvider>
  );
}

/**
 * Over an application ground the frosted back must not lie under the primary
 * card, which shows the ground clear. The card's rectangle depends on the
 * dock and bottom panel tracks (clamped, resizable), so it is measured rather
 * than re-derived in CSS, and handed to the mask as custom properties on the
 * layer. Only the rectangle is written: no React state, no re-render.
 */
function usePrimaryCardHole(layer: HTMLDivElement | null, active: boolean): void {
  useEffect(() => {
    if (!active || layer === null || typeof ResizeObserver === "undefined") return;
    const card = layer.querySelector<HTMLElement>(":scope > .primary-workspace-layer");
    if (card === null) return;
    const write = () => {
      const outer = layer.getBoundingClientRect();
      const inner = card.getBoundingClientRect();
      layer.style.setProperty("--octant-primary-card-x", `${String(inner.left - outer.left)}px`);
      layer.style.setProperty("--octant-primary-card-y", `${String(inner.top - outer.top)}px`);
      layer.style.setProperty("--octant-primary-card-w", `${String(inner.width)}px`);
      layer.style.setProperty("--octant-primary-card-h", `${String(inner.height)}px`);
    };
    write();
    const observer = new ResizeObserver(write);
    observer.observe(layer);
    observer.observe(card);
    return () => observer.disconnect();
  }, [active, layer]);
}

export function ShellFrame(props: ShellFrameProps) {
  const [workspaceLayer, setWorkspaceLayer] = useState<HTMLDivElement | null>(null);
  usePrimaryCardHole(workspaceLayer, props.backdrop !== undefined);
  if (props.standaloneSurface !== undefined) {
    return (
      <ShellThemeRoot
        {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
        {...(props.typography === undefined ? {} : { typography: props.typography })}
        {...(props.theme === undefined ? {} : { theme: props.theme })}
      >
        <div
          className={`shell shell-frame--standalone shell--material-${props.material}`}
          data-octant-sidebar-vibrancy={props.sidebarVibrancyMode ?? "off"}
          style={{ "--octant-sidebar-width": `${props.sidebarWidth}px` } as CSSProperties}
        >
          {props.standaloneSurface}
        </div>
      </ShellThemeRoot>
    );
  }

  return (
    <ThemeSettingsProvider {...(props.theme === undefined ? {} : { settings: props.theme })}>
      <ThemeTypographyProvider
        {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
        {...(props.typography === undefined ? {} : { typography: props.typography })}
      >
        <div
          className={`shell shell-frame shell--material-${props.material}${
            props.workspaceMaterial === "translucent"
              ? " shell--workspace-material-translucent"
              : ""
          }${props.wideContextOpen ? " shell--wide-context-open" : ""}${
            props.sidebarCollapsed ? " shell--sidebar-collapsed" : ""
          }${props.projectsSidebarOpen ? " shell--projects-sidebar-open" : ""}${
            props.backdrop === undefined ? "" : " shell--app-backdrop"
          }${
            props.backdrop !== undefined && props.backdropCoversSidebar === true
              ? " shell--app-backdrop-sidebar"
              : ""
          }`}
          data-octant-sidebar-vibrancy={props.sidebarVibrancyMode ?? "off"}
          data-thread-provider-icons={props.showThreadProviderIcons === false ? "false" : "true"}
          data-transcript-text-size={props.transcriptTextSize ?? "small"}
          data-transcript-width={props.transcriptWidth ?? "narrow"}
          style={
            {
              ...(props.bottomPanelHeight === undefined
                ? {}
                : { "--octant-bottom-panel-height": `${props.bottomPanelHeight}px` }),
              "--octant-context-sidebar-width": `${props.contextSidebarWidth}px`,
              "--octant-native-hidden-inset-titlebar-height": `${NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT}px`,
              "--octant-native-traffic-light-leading-width": `${NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH}px`,
              "--octant-sidebar-width": `${props.sidebarWidth}px`,
            } as CSSProperties
          }
        >
          {props.backdrop}
          {props.chrome}
          {props.sidebarCollapsed ? null : props.sidebar}
          {props.sidebarResizable && !props.sidebarCollapsed ? (
            <ShellResizeHandle
              accessibleName="Resize navigation sidebar"
              className="shell-frame__sidebar-resize window-no-drag"
              edge="trailing"
              maximum={MAX_SIDEBAR_WIDTH}
              minimum={MIN_SIDEBAR_WIDTH}
              onCommit={props.onCommitSidebarWidth}
              onPreview={props.onPreviewSidebarWidth}
              value={props.sidebarWidth}
            />
          ) : null}
          <div
            ref={setWorkspaceLayer}
            className={`workspace-layer${
              props.wideContextOpen ? " workspace-layer--wide-context-open" : ""
            }${props.bottomPanelOpen ? " workspace-layer--bottom-panel-open" : ""}`}
          >
            {props.workspace}
          </div>
          <div
            aria-hidden="true"
            className="shell-frame__native-drag-strip window-drag-region"
            data-native-window-drag-strip
          />
          {props.children}
        </div>
      </ThemeTypographyProvider>
    </ThemeSettingsProvider>
  );
}

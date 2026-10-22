import type { CSSProperties, ReactNode } from "react";
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
  /** A collapsed sidebar stays as its icon rail rather than leaving nothing. */
  readonly sidebarRail?: boolean;
  /** The icon rail stands beside the open sidebar, in its own column. */
  readonly sidebarRailBeside?: boolean;
  readonly projectsSidebarOpen?: boolean;
  readonly sidebarResizable: boolean;
  readonly sidebarVibrancyMode?: SidebarVibrancyMode;
  readonly sidebarWidth: number;
  readonly standaloneSurface?: ReactNode;
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

export function ShellFrame(props: ShellFrameProps) {
  return (
    <ShellThemeRoot
      {...(props.theme === undefined ? {} : { theme: props.theme })}
      {...(props.typography === undefined ? {} : { typography: props.typography })}
      {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
    >
      <div
        className={
          props.standaloneSurface !== undefined
            ? `shell shell-frame--standalone shell--material-${props.material}`
            : `shell shell-frame shell--material-${props.material}${props.wideContextOpen ? " shell--wide-context-open" : ""}${
                props.sidebarCollapsed ? " shell--sidebar-collapsed" : ""
              }${
                props.sidebarCollapsed && props.sidebarRail === true ? " shell--sidebar-rail" : ""
              }${props.sidebarRailBeside === true ? " shell--rail-beside" : ""}${props.projectsSidebarOpen ? " shell--projects-sidebar-open" : ""}${
                props.backdrop === undefined ? "" : " shell--app-backdrop"
              }${
                props.backdrop !== undefined && props.backdropCoversSidebar === true
                  ? " shell--app-backdrop-sidebar"
                  : ""
              }`
        }
        data-octant-sidebar-vibrancy={props.sidebarVibrancyMode ?? "off"}
        data-thread-provider-icons={props.showThreadProviderIcons === false ? "false" : "true"}
        data-transcript-text-size={props.transcriptTextSize ?? "small"}
        data-transcript-width={props.transcriptWidth ?? "narrow"}
        style={
          {
            ...(props.standaloneSurface === undefined
              ? {
                  ...(props.bottomPanelHeight === undefined
                    ? {}
                    : { "--octant-bottom-panel-height": `${props.bottomPanelHeight}px` }),
                  "--octant-context-sidebar-width": `${props.contextSidebarWidth}px`,
                  "--octant-native-hidden-inset-titlebar-height": `${NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT}px`,
                  "--octant-native-traffic-light-leading-width": `${NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH}px`,
                }
              : {}),
            "--octant-sidebar-width": `${props.sidebarWidth}px`,
          } as CSSProperties
        }
      >
        {props.standaloneSurface !== undefined ? (
          <>{props.standaloneSurface}</>
        ) : (
          <>
            {props.backdrop}
            {props.sidebarCollapsed && props.sidebarRail !== true ? null : props.sidebar}
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
            {/*
              The chrome is placed by the grid and stacked by z-index, so where
              it sits in the document only decides tab order. After the sidebar,
              the first Tab stop on load is the left-hand navigation rather than
              the window controls at the right edge.
            */}
            {props.chrome}
            <div
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
          </>
        )}
        {props.children}
      </div>
    </ShellThemeRoot>
  );
}

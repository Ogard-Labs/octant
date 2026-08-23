import type { CSSProperties, ReactNode } from "react";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@octant/contracts/shell";
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
  readonly sidebarResizable: boolean;
  readonly sidebarVibrancyMode?: SidebarVibrancyMode;
  readonly sidebarWidth: number;
  readonly standaloneSurface?: ReactNode;
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
  if (props.standaloneSurface !== undefined) {
    return (
      <div
        className={`shell shell-frame--standalone shell--material-${props.material}`}
        data-octant-sidebar-vibrancy={props.sidebarVibrancyMode ?? "off"}
      >
        {props.standaloneSurface}
      </div>
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
            props.wideContextOpen ? " shell--wide-context-open" : ""
          }${props.sidebarCollapsed ? " shell--sidebar-collapsed" : ""}`}
          data-octant-sidebar-vibrancy={props.sidebarVibrancyMode ?? "off"}
          data-thread-provider-icons={props.showThreadProviderIcons === false ? "false" : "true"}
          data-transcript-text-size={props.transcriptTextSize ?? "medium"}
          data-transcript-width={props.transcriptWidth ?? "narrow"}
          style={
            {
              ...(props.bottomPanelHeight === undefined
                ? {}
                : { "--octant-bottom-panel-height": `${props.bottomPanelHeight}px` }),
              "--octant-context-sidebar-width": `${props.contextSidebarWidth}px`,
              "--octant-sidebar-width": `${props.sidebarWidth}px`,
            } as CSSProperties
          }
        >
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
            className={`workspace-layer${
              props.wideContextOpen ? " workspace-layer--wide-context-open" : ""
            }${props.bottomPanelOpen ? " workspace-layer--bottom-panel-open" : ""}`}
          >
            {props.workspace}
          </div>
          {props.children}
        </div>
      </ThemeTypographyProvider>
    </ThemeSettingsProvider>
  );
}

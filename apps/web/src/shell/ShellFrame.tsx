import type { CSSProperties, ReactNode } from "react";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@octant/contracts/shell";
import type { SidebarVibrancyMode, ThemeSettings, ThemeTypography } from "@octant/contracts/theme";
import type { ResolvedSidebarMaterial } from "./hostBridge";
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
  readonly sidebarResizable: boolean;
  readonly sidebarVibrancyMode?: SidebarVibrancyMode;
  readonly sidebarWidth: number;
  readonly standaloneSurface?: ReactNode;
  readonly typography?: ThemeTypography;
  readonly theme?: ThemeSettings;
  readonly availableFonts?: ReadonlyArray<string>;
  readonly wideContextOpen: boolean;
  readonly workspace: ReactNode;
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
          }`}
          data-octant-sidebar-vibrancy={props.sidebarVibrancyMode ?? "off"}
          style={
            {
              "--octant-context-sidebar-width": `${props.contextSidebarWidth}px`,
              "--octant-sidebar-width": `${props.sidebarWidth}px`,
            } as CSSProperties
          }
        >
          {props.chrome}
          {props.sidebar}
          {props.sidebarResizable ? (
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
            }`}
          >
            {props.workspace}
          </div>
          {props.children}
        </div>
      </ThemeTypographyProvider>
    </ThemeSettingsProvider>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT,
  NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH,
} from "@octant/contracts/shell";
import type { SidebarVibrancyMode, ThemeSettings, ThemeTypography } from "@octant/contracts/theme";
import type { ResolvedSidebarMaterial } from "./hostBridge";
import {
  MIN_CONTEXT_SIDEBAR_WIDTH,
  type TranscriptTextSize,
  type TranscriptWidth,
} from "@octant/contracts/shell";
import { ENVIRONMENT_STRIP_WIDTH } from "./rightUtilityDockModel";
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
  /**
   * The workspace's width (everything right of the sidebar), told on mount and
   * whenever it changes. The caller decides what fits in it; it should keep
   * only the answer, since this runs on every frame of a window resize.
   */
  readonly onWorkspaceWidth?: (width: number) => void;
  /** What the panes of a split keep between them beside the dock; absent for one pane. */
  readonly splitPrimaryMinimum?: number | undefined;
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
   * A surface that floats over the shell instead of replacing it (Settings in
   * a wide window). The shell stays mounted and drawn behind it.
   */
  readonly sheet?: ReactNode;
  /**
   * The application ground drawn under the whole shell when its scope is
   * everywhere. The workspace and its panes go transparent over it; the
   * sidebar does too only when `backdropCoversSidebar` says so.
   */
  readonly backdrop?: ReactNode;
  readonly backdropCoversSidebar?: boolean;
  /**
   * The theme's ground for the start screens: one layer in the frame, shown
   * only while a start screen is open, running under the sidebar too.
   */
  readonly welcomeGround?: ReactNode;
  readonly typography?: ThemeTypography;
  readonly theme?: ThemeSettings;
  readonly availableFonts?: ReadonlyArray<string>;
  readonly wideContextOpen: boolean;
  /** Columns of tool tiles the dock shows; two stand side by side only where the window has the room. */
  readonly dockTileColumns?: number;
  /**
   * The dock's width with two columns of tools side by side. The grid takes it
   * only where the thread's minimum leaves it, and `contextSidebarWidth` (one
   * column, stacked) otherwise.
   */
  readonly contextSidebarTwoColumnWidth?: number;
  /**
   * The Environment strip's width while it is open in the dock, so the grid
   * keeps it out of what the tool columns may shrink to. Absent otherwise.
   */
  readonly dockEnvironmentWidth?: number;
  /** A tool is shown beside the strip, so the dock may not shrink past one tool column too. */
  readonly dockToolsShown?: boolean;
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

/** How long a slide may run before the shell stops waiting for its transition to end. */
const SIDEBAR_SLIDE_LIMIT_MS = 400;

/**
 * A slide is only for a wide window that has not asked for less motion. A
 * drawer at phone width and a reduced-motion window change at once.
 */
function sidebarMaySlide(): boolean {
  if (typeof globalThis.matchMedia !== "function") return false;
  if (document.documentElement.getAttribute("data-octant-reduced-motion") === "true") return false;
  return (
    globalThis.matchMedia("(min-width: 681px)").matches &&
    !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Says the sidebar is sliding open or shut, from the moment `collapsed` flips
 * until its width has settled. Only the open or shut flip sets it: a drag of
 * the sidebar's edge or a window resize changes widths without it, so they stay
 * glued to the pointer.
 */
function useSidebarSliding(collapsed: boolean): {
  readonly sliding: boolean;
  readonly settle: () => void;
} {
  const [sliding, setSliding] = useState(false);
  const [seenCollapsed, setSeenCollapsed] = useState(collapsed);
  if (seenCollapsed !== collapsed) {
    setSeenCollapsed(collapsed);
    if (sidebarMaySlide()) setSliding(true);
  }
  useEffect(() => {
    if (!sliding) return undefined;
    const timer = setTimeout(() => setSliding(false), SIDEBAR_SLIDE_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [sliding, seenCollapsed]);
  return { sliding, settle: () => setSliding(false) };
}

/**
 * Keeps a still copy of the open sidebar through a closing slide. The live one
 * unmounts the moment the shell is collapsed, which would leave the stage
 * sliding over an empty strip; the copy travels out with the column's edge.
 */
function useClosingSidebarCopy(
  shell: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  sliding: boolean,
): void {
  const lastOpen = useRef<{
    readonly node: HTMLElement;
    readonly left: number;
    readonly width: number;
  } | null>(null);
  // Every commit while the sidebar is open and still, so a dragged width is the
  // width the copy keeps.
  useLayoutEffect(() => {
    if (collapsed || sliding) return;
    const node = shell.current?.querySelector<HTMLElement>(
      ":scope > .sidebar[data-octant-sidebar]",
    );
    lastOpen.current =
      node === null || node === undefined
        ? null
        : {
            node,
            left: Number.parseFloat(getComputedStyle(node).marginLeft) || 0,
            width: node.getBoundingClientRect().width,
          };
  });
  useLayoutEffect(() => {
    const frame = shell.current;
    const open = lastOpen.current;
    if (frame === null || !collapsed || !sliding || open === null) return undefined;
    const copy = open.node.cloneNode(true) as HTMLElement;
    copy.removeAttribute("data-octant-sidebar");
    copy.setAttribute("data-octant-sidebar-ghost", "");
    copy.setAttribute("aria-hidden", "true");
    copy.setAttribute("inert", "");
    copy.style.setProperty("--ghost-left", `${open.left}px`);
    copy.style.setProperty("--ghost-width", `${open.width}px`);
    frame.appendChild(copy);
    return () => copy.remove();
  }, [shell, collapsed, sliding]);
}

/**
 * Publishes the workspace's width to the stylesheet as
 * `--octant-workspace-width`. The thread box's minimum is worked out from it
 * (`--octant-thread-box-min`), and a pane's header, whose own width changes
 * with whatever opens beside it, cannot measure the workspace in CSS. Written
 * straight to the element: a window resize must not render the shell.
 */
function useWorkspaceWidthVariable(
  layer: RefObject<HTMLDivElement | null>,
  present: boolean,
  onWidth: ((width: number) => void) | undefined,
) {
  const report = useRef(onWidth);
  report.current = onWidth;
  useLayoutEffect(() => {
    const node = layer.current;
    if (!present || node === null) return undefined;
    const publish = () => {
      const width = node.clientWidth;
      if (width <= 0) return;
      node.style.setProperty("--octant-workspace-width", `${width}px`);
      report.current?.(width);
    };
    publish();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layer, present]);
}

export function ShellFrame(props: ShellFrameProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const workspaceLayerRef = useRef<HTMLDivElement | null>(null);
  useWorkspaceWidthVariable(
    workspaceLayerRef,
    props.standaloneSurface === undefined,
    props.onWorkspaceWidth,
  );
  const { sliding, settle } = useSidebarSliding(props.sidebarCollapsed === true);
  useClosingSidebarCopy(shellRef, props.sidebarCollapsed === true, sliding);
  return (
    <ShellThemeRoot
      {...(props.theme === undefined ? {} : { theme: props.theme })}
      {...(props.typography === undefined ? {} : { typography: props.typography })}
      {...(props.availableFonts === undefined ? {} : { availableFonts: props.availableFonts })}
    >
      <div
        ref={shellRef}
        data-octant-sidebar-sliding={sliding ? "true" : undefined}
        onTransitionEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.propertyName === "--octant-rendered-sidebar-width"
          ) {
            settle();
          }
        }}
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
        data-dock-tile-columns={
          props.standaloneSurface === undefined && props.dockTileColumns === 2 ? "2" : undefined
        }
        // The Environment section is open beside the thread: alone, or with
        // tool panes after it. A single pane's header then runs on over it.
        data-thread-environment={
          props.standaloneSurface !== undefined || props.dockEnvironmentWidth === undefined
            ? undefined
            : props.dockToolsShown === true
              ? "tools"
              : "alone"
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
                  "--octant-context-sidebar-width": `${Math.round(props.contextSidebarWidth)}px`,
                  "--octant-env-strip-width": `${ENVIRONMENT_STRIP_WIDTH}px`,
                  ...(props.splitPrimaryMinimum === undefined
                    ? {}
                    : { "--octant-split-primary-min": `${props.splitPrimaryMinimum}px` }),
                  ...(props.contextSidebarTwoColumnWidth === undefined
                    ? {}
                    : {
                        "--octant-context-two-column-width": `${Math.round(props.contextSidebarTwoColumnWidth)}px`,
                      }),
                  ...(props.dockEnvironmentWidth === undefined
                    ? {}
                    : {
                        "--octant-dock-env-width": `${props.dockEnvironmentWidth}px`,
                        "--octant-context-sidebar-min": `${
                          props.dockEnvironmentWidth +
                          (props.dockToolsShown === true ? MIN_CONTEXT_SIDEBAR_WIDTH : 0)
                        }px`,
                      }),
                  "--octant-native-hidden-inset-titlebar-height": `${NATIVE_HIDDEN_INSET_TITLEBAR_HEIGHT}px`,
                  "--octant-native-traffic-light-leading-width": `${NATIVE_TRAFFIC_LIGHT_LEADING_WIDTH}px`,
                }
              : {}),
            // A dragged width can be saved with a fraction; a pane on one lands
            // its hairline and every row's text between device pixels.
            "--octant-sidebar-width": `${Math.round(props.sidebarWidth)}px`,
          } as CSSProperties
        }
      >
        {props.standaloneSurface !== undefined ? (
          <>{props.standaloneSurface}</>
        ) : (
          <>
            {/* First in the shell, so every control after it can subtract itself. */}
            <div
              aria-hidden="true"
              className="shell-frame__title-band-drag window-drag-region"
              data-window-drag-band
            />
            {props.backdrop}
            {props.welcomeGround}
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
              data-dock-tile-columns={props.dockTileColumns === 2 ? "2" : undefined}
              ref={workspaceLayerRef}
            >
              {props.workspace}
            </div>
          </>
        )}
        {props.children}
        {props.sheet}
      </div>
    </ShellThemeRoot>
  );
}

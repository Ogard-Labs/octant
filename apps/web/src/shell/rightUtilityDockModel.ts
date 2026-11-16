import type { OctantMode } from "@octant/contracts/modes";
import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";

export type RightUtilityDockSurfaceId =
  | "environment"
  | "side-chat"
  | "browser"
  | "files"
  | "document"
  | "canvas"
  | "artifacts"
  | "plan"
  | "delivery"
  | "agents"
  | "review"
  | "pull-requests"
  | "terminal"
  | "tests"
  | "ios-simulator"
  | "android-emulator"
  | "desktop"
  | "debug"
  | "vitals";

/**
 * What a panel answers for, and therefore what makes it truthful.
 *
 * Dock tools are thread-owned. A pane holding no thread is what makes a
 * selected tool unavailable. Retired category ids (Context, Project memory,
 * Navigator, Thread tools) stay decodeable in persisted settings and resolve
 * to a closed dock rather than a panel the dock no longer hosts.
 */
export type RightUtilityDockSurfaceScope = "thread";

export interface RightUtilityDockSurfaceDescriptor {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly scope: RightUtilityDockSurfaceScope;
}

export interface RightUtilityDockTabDescriptor {
  readonly id: string;
  readonly label: string;
  readonly surface: RightUtilityDockSurfaceDescriptor;
}

export type RightUtilityDockSurfaceAvailability =
  | "available"
  | "unknown"
  | "unavailable"
  | "unauthorized";

export type RightUtilityDockConnectionState = "connected" | "disconnected";

export interface RightUtilityDockResolutionInput {
  readonly activeMode: OctantMode;
  /**
   * The thread the active pane holds, absent when it holds something else — a
   * welcome surface, a Project overview, a utility surface. A thread-scoped
   * panel has nothing to describe without it.
   */
  readonly activeThreadId?: string;
  /**
   * The Project pull-request list is central and a row is selected. Review may
   * show that read-only detail without an active thread.
   */
  readonly projectPullRequestReviewOpen?: boolean;
  readonly connectionState: RightUtilityDockConnectionState;
  readonly presentationAvailability: RightUtilityDockSurfaceAvailability;
  readonly savedSurface: unknown;
}

export type RightUtilityDockClosedReason =
  | "disconnected"
  | "mode-invalid"
  | "no-surface"
  | "unauthorized"
  | "unavailable"
  | "unknown"
  | "unknown-surface";

export type RightUtilityDockUnavailableReason = "thread-required";

export type RightUtilityDockResolution =
  | {
      readonly kind: "surface";
      readonly surface: RightUtilityDockSurfaceDescriptor;
    }
  | {
      /**
       * The selected panel is known but the active pane gives it nothing
       * truthful to describe. This is a value rather than "closed" because the
       * user's panel selection must survive activating another pane: the dock
       * stays open and presents this state instead of the previous target's
       * content. Opening and restoring still require `kind: "surface"`, so
       * this state can only be reached from a dock that was already open.
       */
      readonly kind: "unavailable";
      readonly reason: RightUtilityDockUnavailableReason;
      readonly surface: RightUtilityDockSurfaceDescriptor;
    }
  | {
      readonly kind: "closed";
      readonly reason: RightUtilityDockClosedReason;
    };

/*
 * Direct thread-owned tools restore independently for each active thread.
 * Generic category tabs are gone: Context lives on the composer meter, Project
 * memory in Overview, Navigator on the profile control. Plan and Delivery are
 * still mode-valid here; presence is gated by the thread's current artifact or
 * enabled target, not by this catalog. Agents is conditional: it appears when
 * subagents exist or a composer tray row asks for one. Review is the local-diff tool.
 * Chat admits only Agents, so completed helpers remain inspectable without
 * exposing workspace tools or a bottom panel.
 */
/**
 * Surfaces a reader can hold several of at once. A second browser is a second
 * page and a second terminal is a second shell, so neither is satisfied by
 * revealing the one already open — every other surface shows one thread's one
 * view of a thing and a duplicate tab would say nothing new.
 */
export const MULTI_INSTANCE_DOCK_SURFACES: ReadonlySet<string> = new Set(["browser", "terminal"]);

/**
 * The width a tool needs to be usable. At the 420px default (and at the
 * narrower widths people had dragged it to) a Browser showed a phone layout of
 * every site, a Review had no room for a diff and the tab strip had room for
 * one name; opening any tool widens a narrower tool column to this for as long
 * as one stays open. It is not saved: when it was, one Browser left every later
 * tool column half a window wide.
 */
export const WORKBENCH_DOCK_WIDTH = 640;

/**
 * Every tool has one of two size classes, and this is the one place they are
 * told apart.
 *
 * - **Flexible** tools draw a page, a diff, a device, a shell or a file tree,
 *   and use whatever room there is: they open at the workbench width and are
 *   resized between a minimum and the dock's ceiling.
 * - **Fixed** tools are panels of rows and figures (Vitals, Plan, Agents,
 *   Delivery and the rest). They always have the compact width and no resize
 *   handle, whatever opens or closes beside them. Environment is fixed too, as
 *   its own strip.
 */
export const FLEXIBLE_DOCK_SURFACES: ReadonlySet<string> = new Set([
  "browser",
  "terminal",
  "review",
  "canvas",
  "document",
  "files",
  "ios-simulator",
  "android-emulator",
  "desktop",
]);

/** The width every fixed panel-like tool has. */
export const COMPACT_DOCK_WIDTH = 360;

/** The narrowest a flexible tool column is resized to. */
export const FLEXIBLE_DOCK_MIN_WIDTH = 480;

/**
 * Whether the tool column is fixed: tools are open and every one is a panel.
 * A flexible tool beside a fixed one gives the column the flexible rules.
 * Environment is its own strip and does not count.
 */
export function dockColumnIsFixed(tabSurfaces: ReadonlyArray<string>): boolean {
  const tools = tabSurfaces.filter((surface) => surface !== "environment");
  return tools.length > 0 && !tools.some((surface) => FLEXIBLE_DOCK_SURFACES.has(surface));
}

/** The smallest a flexible column may be dragged to where the window has room for it. */
export function flexibleDockMinimum(ceiling: number): number {
  return Math.min(FLEXIBLE_DOCK_MIN_WIDTH, ceiling);
}

/**
 * Two columns of tools side by side need two usable widths: each column the
 * narrowest a flexible tool is resized to. Tool columns narrower than this
 * stack, and a layout with two columns widens to it only where the window
 * holds the thread's minimum and Environment beside it (the stylesheet decides,
 * since it knows the room). At 840px two columns of 420px squeezed the thread
 * to 440px and then stacked anyway whenever the window was under 1700px.
 */
export const TILED_DOCK_WIDTH = 960;

/**
 * The Environment strip: a thin, static column at the dock's leading edge. It
 * has one width, with no handle, so nothing a tool does beside it moves it.
 * The stylesheet reads it as `--octant-dock-env-width`, set by the shell.
 */
export const ENVIRONMENT_STRIP_WIDTH = 300;

/**
 * One width for the tool columns whatever the dock is showing, so a click inside
 * it moves nothing. A column holding only fixed tools is the compact width, and
 * a person's dragged width never changes it. Otherwise any open tool holds the
 * workbench width at least, even while another tab is in front, and it is worked out from the
 * open tabs so a tab restored after a restart gets it too. Environment is its
 * own strip and never asks for tool width.
 */
export function resolveDockPresentationWidth(input: {
  readonly storedWidth: number;
  /** The person sized the dock since a tool last opened, so it stays as they left it. */
  readonly widthChosen: boolean;
  readonly tabSurfaces: ReadonlyArray<string>;
}): number {
  if (dockColumnIsFixed(input.tabSurfaces)) return COMPACT_DOCK_WIDTH;
  if (input.widthChosen) return Math.max(input.storedWidth, FLEXIBLE_DOCK_MIN_WIDTH);
  const holdsTool = input.tabSurfaces.some((surface) => surface !== "environment");
  return Math.max(input.storedWidth, holdsTool ? WORKBENCH_DOCK_WIDTH : 0);
}

/**
 * The width two columns of tools ask for where the window has the room for it:
 * the side-by-side width, or a wider one the person dragged to. Where the room
 * is missing the tool columns keep `resolveDockPresentationWidth` and stack, so
 * a second column never takes width from the thread or moves Environment.
 */
export function resolveTwoColumnDockWidth(input: {
  readonly storedWidth: number;
  readonly widthChosen: boolean;
}): number {
  return Math.max(input.widthChosen ? input.storedWidth : 0, TILED_DOCK_WIDTH);
}

/**
 * The dock's whole width: the Environment strip when it is open, plus the tool
 * columns when any tool is shown. Environment alone is exactly the strip.
 */
export function dockTotalWidth(input: {
  readonly toolsWidth: number;
  readonly environmentOpen: boolean;
  readonly toolsShown: boolean;
}): number {
  if (!input.environmentOpen) return input.toolsWidth;
  return ENVIRONMENT_STRIP_WIDTH + (input.toolsShown ? input.toolsWidth : 0);
}

/**
 * The most of the workspace the dock may take. Half keeps the thread readable
 * beside any tool. With only the thread's own minimum as a ceiling, a stored
 * 960px squeezed the transcript to a sliver as soon as anything opened in the
 * dock. The resize handle stops here too, so a drag never moves a stored width
 * that the screen would not show.
 */
export function dockWidthCeiling(
  workspaceWidth: number | undefined,
  options: {
    readonly tileColumns?: number;
    /** What stands beside the tool columns and is not theirs to take: the Environment strip. */
    readonly reservedWidth?: number;
    readonly viewportWidth?: number | undefined;
  } = {},
): number {
  if (workspaceWidth === undefined) return MAX_CONTEXT_SIDEBAR_WIDTH;
  // What the thread's minimum and Environment leave, the same for one column
  // and two: the primary minimum is the one the stylesheet's grid uses (560px
  // from 1100px up, 360px below), so the handle stops where the layout would.
  // One column also stops at half the workspace.
  // The thread box (the thread and its Environment section) never gets
  // narrower than `threadBoxMinimum`, whether or not the section is open.
  const left =
    workspaceWidth -
    Math.max(
      threadBoxMinimum(workspaceWidth, options.viewportWidth),
      (options.reservedWidth ?? 0) +
        ((options.viewportWidth ?? Number.POSITIVE_INFINITY) >= WIDE_VIEWPORT
          ? WIDE_PRIMARY_MIN
          : NARROW_PRIMARY_MIN),
    );
  const room = (options.tileColumns ?? 1) >= 2 ? left : Math.min(left, workspaceWidth / 2);
  return Math.min(MAX_CONTEXT_SIDEBAR_WIDTH, Math.max(MIN_CONTEXT_SIDEBAR_WIDTH, Math.floor(room)));
}

/**
 * The thread column's minimum from 1100px up, whatever stands beside it: one
 * tool, several, or two columns of them. The stylesheet mirrors it as
 * `--octant-wide-primary-min`. A smaller minimum beside two columns (440px)
 * let a second tool squeeze the thread and move Environment.
 */
export const WIDE_PRIMARY_MIN = 560;
const NARROW_PRIMARY_MIN = 360;
const WIDE_VIEWPORT = 1100;

/**
 * The narrowest the thread box (the thread and its Environment section, open
 * or not) is in a workspace of this width, whatever stands in the tool region.
 * The thread header's tool row ends on this line, 8px in, so nothing that
 * opens, closes, stacks or moves beside the thread moves the row: the tool
 * region takes only the room past it. It is the thread's own minimum, or what
 * a tool region at its asked width (640px) leaves where that is more, up to
 * the thread's minimum and the section together. The stylesheet mirrors it as
 * `--octant-thread-box-min`. Measured before (1800px window, 2026-11-16): the
 * row stood at x 1532 with nothing open, 960 with one tool and 996 once
 * Environment joined it.
 */
export function threadBoxMinimum(
  workspaceWidth: number,
  viewportWidth: number | undefined = undefined,
): number {
  const primaryMinimum =
    (viewportWidth ?? Number.POSITIVE_INFINITY) >= WIDE_VIEWPORT
      ? WIDE_PRIMARY_MIN
      : NARROW_PRIMARY_MIN;
  // What the grid gives the thread at least: its minimum, less only where a
  // 280px tool column would not fit beside it, never under 360px.
  const threadMinimum = Math.max(
    NARROW_PRIMARY_MIN,
    Math.min(primaryMinimum, workspaceWidth - MIN_CONTEXT_SIDEBAR_WIDTH),
  );
  return Math.min(
    primaryMinimum + ENVIRONMENT_STRIP_WIDTH,
    Math.max(workspaceWidth - WORKBENCH_DOCK_WIDTH, threadMinimum),
  );
}

export const RIGHT_UTILITY_DOCK_SURFACES = [
  {
    id: "environment",
    label: "Environment",
    modes: ["work", "code"],
    scope: "thread",
  },
  {
    id: "side-chat",
    label: "Side Chat",
    modes: ["work", "code"],
    scope: "thread",
  },
  {
    id: "browser",
    label: "Browser",
    modes: ["work", "code"],
    scope: "thread",
  },
  {
    id: "files",
    label: "Files",
    modes: ["work", "code"],
    scope: "thread",
  },
  {
    id: "document",
    label: "Document",
    modes: ["code"],
    scope: "thread",
  },
  {
    id: "canvas",
    label: "Canvas",
    modes: ["work", "code"],
    scope: "thread",
  },
  {
    id: "plan",
    label: "Plan",
    modes: ["work", "code"],
    scope: "thread",
  },
  {
    id: "delivery",
    label: "Delivery",
    modes: ["code"],
    scope: "thread",
  },
  {
    id: "agents",
    label: "Agents",
    modes: ["chat", "work", "code"],
    scope: "thread",
  },
  {
    id: "review",
    label: "Review",
    modes: ["code"],
    scope: "thread",
  },
  {
    id: "pull-requests",
    label: "Pull requests",
    // The resolved list is a Code Project read: a Work Project has no
    // pull-request source, so offering the tool there promises a list the
    // host can never fill.
    modes: ["code"],
    scope: "thread",
  },
  {
    id: "terminal",
    label: "Terminal",
    modes: ["code"],
    scope: "thread",
  },
  {
    id: "tests",
    label: "Tests",
    modes: ["code"],
    scope: "thread",
  },
  {
    id: "ios-simulator",
    label: "iOS Simulator",
    modes: ["code"],
    scope: "thread",
  },
  {
    id: "android-emulator",
    label: "Android emulator",
    modes: ["code"],
    scope: "thread",
  },
  {
    // A thread's disposable desktops. Code is delivered first; Work threads
    // do not lease yet.
    id: "desktop",
    label: "Desktop",
    modes: ["code"],
    scope: "thread",
  },
  {
    // A Code thread's debug sessions; the host refuses every other mode.
    id: "debug",
    label: "Run and debug",
    modes: ["code"],
    scope: "thread",
  },
  {
    // Load on the host the thread works on; the host answers for itself.
    id: "vitals",
    label: "Vitals",
    modes: ["work", "code"],
    scope: "thread",
  },
  {
    // The thread's Project's artifacts, read from the host-wide library
    // clamped to that one Project; Chat has no Project to list.
    id: "artifacts",
    label: "Artifacts",
    modes: ["work", "code"],
    scope: "thread",
  },
] as const satisfies ReadonlyArray<RightUtilityDockSurfaceDescriptor>;

const descriptors: Readonly<Record<RightUtilityDockSurfaceId, RightUtilityDockSurfaceDescriptor>> =
  {
    environment: RIGHT_UTILITY_DOCK_SURFACES[0],
    "side-chat": RIGHT_UTILITY_DOCK_SURFACES[1],
    browser: RIGHT_UTILITY_DOCK_SURFACES[2],
    files: RIGHT_UTILITY_DOCK_SURFACES[3],
    document: RIGHT_UTILITY_DOCK_SURFACES[4],
    canvas: RIGHT_UTILITY_DOCK_SURFACES[5],
    plan: RIGHT_UTILITY_DOCK_SURFACES[6],
    delivery: RIGHT_UTILITY_DOCK_SURFACES[7],
    agents: RIGHT_UTILITY_DOCK_SURFACES[8],
    review: RIGHT_UTILITY_DOCK_SURFACES[9],
    "pull-requests": RIGHT_UTILITY_DOCK_SURFACES[10],
    terminal: RIGHT_UTILITY_DOCK_SURFACES[11],
    tests: RIGHT_UTILITY_DOCK_SURFACES[12],
    "ios-simulator": RIGHT_UTILITY_DOCK_SURFACES[13],
    "android-emulator": RIGHT_UTILITY_DOCK_SURFACES[14],
    desktop: RIGHT_UTILITY_DOCK_SURFACES[15],
    debug: RIGHT_UTILITY_DOCK_SURFACES[16],
    vitals: RIGHT_UTILITY_DOCK_SURFACES[17],
    artifacts: RIGHT_UTILITY_DOCK_SURFACES[18],
  };

export function resolveRightUtilityDockSurface(
  input: RightUtilityDockResolutionInput,
): RightUtilityDockResolution {
  if (input.savedSurface === null || input.savedSurface === undefined) {
    return closed("no-surface");
  }
  const savedSurface = canonicalizeDockSurface(input.savedSurface);
  if (!isRightUtilityDockSurfaceId(savedSurface)) {
    return closed("unknown-surface");
  }
  if (input.connectionState !== "connected") {
    return closed("disconnected");
  }
  if (input.presentationAvailability !== "available") {
    return closed(input.presentationAvailability);
  }

  const surface = descriptors[savedSurface];
  if (!surface.modes.includes(input.activeMode)) {
    return closed("mode-invalid");
  }

  if (
    input.activeThreadId === undefined &&
    !(input.projectPullRequestReviewOpen === true && savedSurface === "review")
  ) {
    return { kind: "unavailable", reason: "thread-required", surface };
  }
  return { kind: "surface", surface };
}

function closed(reason: RightUtilityDockClosedReason): RightUtilityDockResolution {
  return { kind: "closed", reason };
}

function isRightUtilityDockSurfaceId(value: unknown): value is RightUtilityDockSurfaceId {
  return Object.hasOwn(descriptors, String(canonicalizeDockSurface(value)));
}

/**
 * A dock that still names the retired Changes id is asking for Review: that
 * tool is the same local-diff destination, renamed.
 */
function canonicalizeDockSurface(value: unknown): unknown {
  return value === "changes" ? "review" : value;
}

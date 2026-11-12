import type { OctantMode } from "@octant/contracts/modes";
import { MAX_CONTEXT_SIDEBAR_WIDTH, MIN_CONTEXT_SIDEBAR_WIDTH } from "@octant/contracts/shell";

export type RightUtilityDockSurfaceId =
  | "environment"
  | "side-chat"
  | "browser"
  | "files"
  | "document"
  | "canvas"
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
 * The width a page or a shell needs to be usable. At the 420px default (and
 * at the narrower widths people had dragged it to) a Browser showed a phone
 * layout of every site and the tab strip had room for one name; opening a
 * Browser or a Terminal widens a narrower dock to this for as long as such a
 * tab stays open. It is not saved: when it was, one Browser left every later
 * Environment and Plan half a window wide.
 */
export const WORKBENCH_DOCK_WIDTH = 640;

/**
 * Two columns of tools side by side need two usable widths. At 640px each got
 * about 300px, too narrow for a simulator's device or a page's layout, so a
 * dock showing two columns widens to this until the person sizes it. Not saved,
 * for the reason the workbench width is not.
 */
export const TILED_DOCK_WIDTH = 840;

/**
 * One width whatever the dock is showing, so a click inside it moves nothing.
 * The empty launcher used to take the 280px minimum while every tool took the
 * stored width, so opening Environment from it threw the dock from 280px to the
 * stored 960px and squeezed the thread beside it. A Browser or Terminal tab that
 * needs more holds that width even while another tab is in front. It is worked
 * out from the open tabs, so a tab restored after a restart gets it too.
 */
export function resolveDockPresentationWidth(input: {
  readonly storedWidth: number;
  /** The person sized the dock since a Browser or Terminal last opened, so it stays as they left it. */
  readonly widthChosen: boolean;
  readonly tabSurfaces: ReadonlyArray<string>;
  /** How many columns of tool tiles the dock shows; one when it shows a single tool. */
  readonly tileColumns?: number;
}): number {
  if (input.widthChosen) return input.storedWidth;
  const holdsWorkbench = input.tabSurfaces.some(
    (surface) => surface === "browser" || surface === "terminal",
  );
  const wanted = Math.max(
    holdsWorkbench ? WORKBENCH_DOCK_WIDTH : 0,
    (input.tileColumns ?? 1) >= 2 ? TILED_DOCK_WIDTH : 0,
  );
  return Math.max(input.storedWidth, wanted);
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
    readonly viewportWidth?: number | undefined;
  } = {},
): number {
  if (workspaceWidth === undefined) return MAX_CONTEXT_SIDEBAR_WIDTH;
  // Two columns of tools need what the thread's own minimum leaves, not half:
  // at 1440px with the sidebar open, half gave two columns of 243px, under
  // what a tool is built for. The primary minimum is the one the stylesheet's
  // grid uses (560px from 1100px up, 360px below), so the handle stops where
  // the layout would.
  const room =
    (options.tileColumns ?? 1) >= 2
      ? workspaceWidth -
        ((options.viewportWidth ?? Number.POSITIVE_INFINITY) >= WIDE_VIEWPORT
          ? TILED_PRIMARY_MIN
          : NARROW_PRIMARY_MIN)
      : workspaceWidth / 2;
  return Math.min(MAX_CONTEXT_SIDEBAR_WIDTH, Math.max(MIN_CONTEXT_SIDEBAR_WIDTH, Math.floor(room)));
}

/**
 * The thread column's minimum beside two columns of tools, from 1100px up. One
 * column keeps `--octant-wide-primary-min` (560px); at 560px, two tools could
 * never stand side by side in a 1440px window with the sidebar open, so a
 * second column asks the thread for 440px instead. The stylesheet mirrors it
 * as `--octant-tiled-primary-min`.
 */
export const TILED_PRIMARY_MIN = 440;
const NARROW_PRIMARY_MIN = 360;
const WIDE_VIEWPORT = 1100;

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

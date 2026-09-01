import type { OctantMode } from "@octant/contracts/modes";

export type RightUtilityDockSurfaceId =
  | "side-chat"
  | "browser"
  | "files"
  | "canvas"
  | "plan"
  | "delivery"
  | "agents"
  | "review"
  | "terminal"
  | "tests"
  | "ios-simulator";

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
 * children exist or the user invokes Add agent. Review is the local-diff tool.
 */
export const RIGHT_UTILITY_DOCK_SURFACES = [
  {
    id: "side-chat",
    label: "Side Chat",
    modes: ["chat", "work", "code"],
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
    id: "canvas",
    label: "Canvas",
    modes: ["chat", "work", "code"],
    scope: "thread",
  },
  {
    id: "plan",
    label: "Plan",
    modes: ["chat", "work", "code"],
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
] as const satisfies ReadonlyArray<RightUtilityDockSurfaceDescriptor>;

const descriptors: Readonly<Record<RightUtilityDockSurfaceId, RightUtilityDockSurfaceDescriptor>> =
  {
    "side-chat": RIGHT_UTILITY_DOCK_SURFACES[0],
    browser: RIGHT_UTILITY_DOCK_SURFACES[1],
    files: RIGHT_UTILITY_DOCK_SURFACES[2],
    canvas: RIGHT_UTILITY_DOCK_SURFACES[3],
    plan: RIGHT_UTILITY_DOCK_SURFACES[4],
    delivery: RIGHT_UTILITY_DOCK_SURFACES[5],
    agents: RIGHT_UTILITY_DOCK_SURFACES[6],
    review: RIGHT_UTILITY_DOCK_SURFACES[7],
    terminal: RIGHT_UTILITY_DOCK_SURFACES[8],
    tests: RIGHT_UTILITY_DOCK_SURFACES[9],
    "ios-simulator": RIGHT_UTILITY_DOCK_SURFACES[10],
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

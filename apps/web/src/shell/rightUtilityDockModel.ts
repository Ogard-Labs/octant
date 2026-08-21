import type { OctantMode } from "@octant/contracts/modes";
import type {
  CanonicalProjectBinding,
  ProjectId,
  ProjectLifecycle,
  ProjectType,
} from "@octant/contracts/projects";

export type RightUtilityDockSurfaceId =
  | "context"
  | "project-memory"
  | "navigator"
  | "side-chat"
  | "browser"
  | "files"
  | "changes"
  | "terminal"
  | "tests"
  | "ios-simulator"
  | "thread";

/**
 * What a panel answers for, and therefore what makes it truthful.
 *
 * A `project` panel is only truthful next to the Project it describes, so a
 * missing, incompatible, or stale Project makes it unavailable. A `host` panel
 * has no Project to be stale against — asking it for one would close it
 * forever. A `thread` panel answers for the thread in the active pane, so a
 * pane holding no thread is what makes it unavailable.
 */
export type RightUtilityDockSurfaceScope = "host" | "project" | "thread";

export interface RightUtilityDockSurfaceDescriptor {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly scope: RightUtilityDockSurfaceScope;
}

export interface RightUtilityDockProject {
  readonly id: ProjectId;
  readonly type: ProjectType;
  readonly lifecycle: ProjectLifecycle;
  readonly binding?: CanonicalProjectBinding;
}

export type RightUtilityDockSurfaceAvailability =
  | "available"
  | "unknown"
  | "unavailable"
  | "unauthorized";

export type RightUtilityDockConnectionState = "connected" | "disconnected";

export interface RightUtilityDockResolutionInput {
  readonly activeMode: OctantMode;
  readonly activeProject?: RightUtilityDockProject;
  /**
   * The thread the active pane holds, absent when it holds something else — a
   * welcome surface, a Project overview, a utility surface. A thread-scoped
   * panel has nothing to describe without it.
   */
  readonly activeThreadId?: string;
  readonly connectionState: RightUtilityDockConnectionState;
  readonly presentationAvailability: RightUtilityDockSurfaceAvailability;
  readonly savedSurface: unknown;
  readonly surfaceProjectId?: ProjectId;
}

export type RightUtilityDockClosedReason =
  | "disconnected"
  | "mode-invalid"
  | "no-surface"
  | "unauthorized"
  | "unavailable"
  | "unknown"
  | "unknown-surface";

export type RightUtilityDockUnavailableReason =
  | "project-incompatible"
  | "project-required"
  | "project-stale"
  | "thread-required";

export type RightUtilityDockResolution =
  | {
      readonly kind: "surface";
      /**
       * The Project this surface describes, present only when the surface is
       * about one. A host-owned surface reports no Project rather than a
       * placeholder id, so a consumer cannot read an identity the dock never
       * resolved.
       */
      readonly projectId?: ProjectId;
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
 * What the dock holds is decided by scope, not by convenience.
 *
 * A thread-scoped panel used to be a panel that lies: a leaf held a strip of
 * tabs, so with two threads visible the window-scoped dock could only ever
 * answer for one of them, and `code-environment` and `plan` were removed for
 * it. 0041 changed that premise — a pane holds exactly one surface and the
 * dock follows the active pane — so the active pane now names the dock's
 * thread unambiguously, and a thread-scoped panel can be truthful here. The
 * direct utilities restore independently for each active thread; the legacy
 * Thread panel keeps only the secondary Plan, Publish, and Agents tools that
 * were never workspace-launcher entries.
 */
export const RIGHT_UTILITY_DOCK_SURFACES = [
  {
    id: "context",
    label: "Context",
    modes: ["chat", "work", "code"],
    scope: "project",
  },
  {
    id: "project-memory",
    label: "Project memory",
    modes: ["chat", "work", "code"],
    scope: "project",
  },
  // Host-owned: Navigator answers for the host across every mode, so it is the
  // one surface here that is not about a Project.
  {
    id: "navigator",
    label: "Navigator",
    modes: ["chat", "work", "code"],
    scope: "host",
  },
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
    id: "changes",
    label: "Changes",
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
    id: "thread",
    label: "Thread tools",
    modes: ["code"],
    scope: "thread",
  },
] as const satisfies ReadonlyArray<RightUtilityDockSurfaceDescriptor>;

const descriptors: Readonly<Record<RightUtilityDockSurfaceId, RightUtilityDockSurfaceDescriptor>> =
  {
    context: RIGHT_UTILITY_DOCK_SURFACES[0],
    "project-memory": RIGHT_UTILITY_DOCK_SURFACES[1],
    navigator: RIGHT_UTILITY_DOCK_SURFACES[2],
    "side-chat": RIGHT_UTILITY_DOCK_SURFACES[3],
    browser: RIGHT_UTILITY_DOCK_SURFACES[4],
    files: RIGHT_UTILITY_DOCK_SURFACES[5],
    changes: RIGHT_UTILITY_DOCK_SURFACES[6],
    terminal: RIGHT_UTILITY_DOCK_SURFACES[7],
    tests: RIGHT_UTILITY_DOCK_SURFACES[8],
    "ios-simulator": RIGHT_UTILITY_DOCK_SURFACES[9],
    thread: RIGHT_UTILITY_DOCK_SURFACES[10],
  };

export function resolveRightUtilityDockSurface(
  input: RightUtilityDockResolutionInput,
): RightUtilityDockResolution {
  if (input.savedSurface === null || input.savedSurface === undefined) {
    return closed("no-surface");
  }
  if (!isRightUtilityDockSurfaceId(input.savedSurface)) {
    return closed("unknown-surface");
  }
  if (input.connectionState !== "connected") {
    return closed("disconnected");
  }
  if (input.presentationAvailability !== "available") {
    return closed(input.presentationAvailability);
  }

  const surface = descriptors[input.savedSurface];
  if (!surface.modes.includes(input.activeMode)) {
    return closed("mode-invalid");
  }

  // A host-owned surface answers for the host, not for a Project, so the
  // presence, compatibility, and staleness checks below have nothing to read.
  // Running them anyway would close it permanently.
  if (surface.scope === "host") {
    return { kind: "surface", surface };
  }

  if (surface.scope === "thread") {
    return input.activeThreadId === undefined
      ? { kind: "unavailable", reason: "thread-required", surface }
      : { kind: "surface", surface };
  }

  const project = input.activeProject;
  if (project === undefined) {
    return { kind: "unavailable", reason: "project-required", surface };
  }
  if (
    project.lifecycle !== "active" ||
    project.type !== input.activeMode ||
    (project.type !== "chat" && !hasBinding(project.binding))
  ) {
    return { kind: "unavailable", reason: "project-incompatible", surface };
  }
  if (input.surfaceProjectId === undefined || input.surfaceProjectId !== project.id) {
    return { kind: "unavailable", reason: "project-stale", surface };
  }

  return { kind: "surface", projectId: project.id, surface };
}

function closed(reason: RightUtilityDockClosedReason): RightUtilityDockResolution {
  return { kind: "closed", reason };
}

function hasBinding(binding: CanonicalProjectBinding | undefined): boolean {
  return binding !== undefined && binding.canonicalRoot.trim().length > 0;
}

function isRightUtilityDockSurfaceId(value: unknown): value is RightUtilityDockSurfaceId {
  return [
    "context",
    "project-memory",
    "navigator",
    "side-chat",
    "browser",
    "files",
    "changes",
    "terminal",
    "tests",
    "ios-simulator",
    "thread",
  ].includes(String(value));
}

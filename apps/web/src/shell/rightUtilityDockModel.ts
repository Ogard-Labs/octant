import type { OctantMode } from "@octant/contracts/modes";
import type {
  CanonicalProjectBinding,
  ProjectId,
  ProjectLifecycle,
  ProjectType,
} from "@octant/contracts/projects";

export type RightUtilityDockSurfaceId = "context" | "project-memory" | "navigator";

export interface RightUtilityDockSurfaceDescriptor {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
  readonly modes: ReadonlyArray<OctantMode>;
  /**
   * Whether this surface is about one Project. A Project-required surface is
   * only truthful next to the Project it describes, so it must close when no
   * compatible, current Project is active. A host-owned surface has no Project
   * to be stale against, and asking it for one would close it forever.
   */
  readonly projectRequired: boolean;
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
  readonly connectionState: RightUtilityDockConnectionState;
  readonly presentationAvailability: RightUtilityDockSurfaceAvailability;
  readonly savedSurface: unknown;
  readonly surfaceProjectId?: ProjectId;
}

export type RightUtilityDockClosedReason =
  | "disconnected"
  | "mode-invalid"
  | "no-surface"
  | "project-incompatible"
  | "project-required"
  | "project-stale"
  | "unauthorized"
  | "unavailable"
  | "unknown"
  | "unknown-surface";

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
      readonly kind: "closed";
      readonly reason: RightUtilityDockClosedReason;
    };

/*
 * What the dock holds is decided by scope, not by convenience.
 *
 * Every surface here answers for a Project or for the host. The dock is scoped
 * to the window, so with two threads open side by side it can only ever answer
 * for one of them — which makes a thread-scoped surface here a surface that
 * lies. `code-environment` was the plainest case: it rendered the very same git
 * group the thread's own panel already showed under Changes. `plan` was the
 * same mistake one step less obvious. Both now live in the thread panel that
 * sits beside the thread they describe.
 */
export const RIGHT_UTILITY_DOCK_SURFACES = [
  {
    id: "context",
    label: "Context",
    modes: ["chat", "work", "code"],
    projectRequired: true,
  },
  {
    id: "project-memory",
    label: "Project memory",
    modes: ["chat", "work", "code"],
    projectRequired: true,
  },
  // Host-owned: Navigator answers for the host across every mode, so it is the
  // one surface here that is not about a Project.
  {
    id: "navigator",
    label: "Navigator",
    modes: ["chat", "work", "code"],
    projectRequired: false,
  },
] as const satisfies ReadonlyArray<RightUtilityDockSurfaceDescriptor>;

const descriptors: Readonly<Record<RightUtilityDockSurfaceId, RightUtilityDockSurfaceDescriptor>> =
  {
    context: RIGHT_UTILITY_DOCK_SURFACES[0],
    "project-memory": RIGHT_UTILITY_DOCK_SURFACES[1],
    navigator: RIGHT_UTILITY_DOCK_SURFACES[2],
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
  if (!surface.projectRequired) {
    return { kind: "surface", surface };
  }

  const project = input.activeProject;
  if (project === undefined) {
    return closed("project-required");
  }
  if (
    project.lifecycle !== "active" ||
    project.type !== input.activeMode ||
    (project.type !== "chat" && !hasBinding(project.binding))
  ) {
    return closed("project-incompatible");
  }
  if (input.surfaceProjectId === undefined || input.surfaceProjectId !== project.id) {
    return closed("project-stale");
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
  return value === "context" || value === "project-memory" || value === "navigator";
}

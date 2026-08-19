import {
  decodeWorkArtifactRef,
  type WorkArtifactRef,
  type CodeDeliveryTarget,
  type ProjectId,
} from "@octant/contracts";
import type { PersistenceService } from "../persistence/persistenceService";
import type { ProjectService } from "../projectService";
import type { WorkArtifactProjection } from "./workArtifactProjection";
import type { WorkPromotionProjectPort } from "./workPromotionService";
import { GitObservationPort } from "../code/gitObservationPort";
import { Schema } from "effect";
import { UtcTimestamp } from "@octant/contracts";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface CreateWorkPromotionProjectPortOptions {
  readonly persistence: Pick<PersistenceService, "readProject"> &
    Partial<Pick<PersistenceService, "readCodeThreads">>;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly artifacts: WorkArtifactProjection;
  readonly gitObservation?: Pick<GitObservationPort, "observe">;
  readonly clock?: () => string;
}

/**
 * Production Work promotion Project port. Resolves project types and Work
 * canonical roots from authoritative persistence only on the server; none of
 * this data crosses into promotion list or command responses. Artifact refs
 * must resolve to a non-deleted artifact in the origin Work Project.
 */
export function createWorkPromotionProjectPort(
  options: CreateWorkPromotionProjectPortOptions,
): WorkPromotionProjectPort {
  return {
    projectType(projectId) {
      const project = options.persistence.readProject(projectId);
      if (project === undefined) return "unknown";
      return project.type;
    },
    workCanonicalRoot(originProjectId) {
      const project = options.persistence.readProject(originProjectId);
      if (project === undefined || project.type !== "work") return undefined;
      const root = project.binding.canonicalRoot;
      return root.length > 0 ? root : undefined;
    },
    resolveArtifactRefs(originProjectId, artifactRefs) {
      const known = liveArtifactRefsForProject(options.artifacts, originProjectId);
      const resolved: Array<WorkArtifactRef> = [];
      for (const ref of artifactRefs) {
        try {
          const decoded = decodeWorkArtifactRef(ref);
          if (!known.has(String(decoded))) continue;
          resolved.push(decoded);
        } catch {
          continue;
        }
      }
      return resolved;
    },
    listArtifactRefs(originProjectId) {
      return [...liveArtifactRefsForProject(options.artifacts, originProjectId)]
        .map((ref) => decodeWorkArtifactRef(ref))
        .slice(0, 32);
    },
    async resolveDeliveryTarget(targetCodeProjectId) {
      const project = options.persistence.readProject(targetCodeProjectId);
      if (project === undefined || project.type !== "code" || project.lifecycle !== "active") {
        return undefined;
      }

      const existing = options.persistence
        .readCodeThreads?.()
        .filter(
          (thread) =>
            String(thread.projectId) === String(targetCodeProjectId) &&
            thread.lifecycle !== "archived",
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (existing !== undefined) return existing.deliveryTarget;
      if (options.gitObservation === undefined) return undefined;

      const observation = await options.gitObservation.observe(project.binding.canonicalRoot);
      // Only a branch with a commit can be proposed as a base; a detached or
      // unborn head has nothing a pull request could target.
      if (observation.status !== "ready" || observation.head.kind !== "branch") return undefined;
      const remote =
        observation.remotes.find((candidate) => candidate.name === "origin") ??
        observation.remotes[0];
      if (remote === undefined) return undefined;
      const proposedBaseRepository = repositoryFromRemote(remote.fetchUrl);
      if (proposedBaseRepository === undefined) return undefined;
      return {
        branchIntent: observation.head.name,
        remoteName: remote.name,
        proposedBaseRepository,
        proposedBaseBranch: observation.head.name,
        outcomeKind: "opened-pr",
        confirmedAt: decodeTimestamp((options.clock ?? (() => new Date().toISOString()))()),
      } satisfies CodeDeliveryTarget;
    },
  };
}

function repositoryFromRemote(remote: string): string | undefined {
  const ssh = /^git@github\.com:([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (ssh?.[1] !== undefined) return ssh[1];
  try {
    const url = new URL(remote);
    if (url.hostname !== "github.com" || url.username !== "" || url.password !== "") {
      return undefined;
    }
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export async function accessibleWorkProjectIds(
  projects: Pick<ProjectService, "bootstrap">,
  windowId: Parameters<ProjectService["bootstrap"]>[0],
): Promise<ReadonlySet<string>> {
  const bootstrap = await projects.bootstrap(windowId);
  return new Set(
    bootstrap.active
      .filter((project) => project.type === "work" && project.lifecycle === "active")
      .map((project) => String(project.id)),
  );
}

export async function accessibleCodeProjectIds(
  projects: Pick<ProjectService, "bootstrap">,
  windowId: Parameters<ProjectService["bootstrap"]>[0],
): Promise<ReadonlySet<string>> {
  const bootstrap = await projects.bootstrap(windowId);
  return new Set(
    bootstrap.active
      .filter((project) => project.type === "code" && project.lifecycle === "active")
      .map((project) => String(project.id)),
  );
}

function liveArtifactRefsForProject(
  projection: WorkArtifactProjection,
  originProjectId: ProjectId,
): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const entry of projection.snapshot().values()) {
    if (entry.deleted) continue;
    if (String(entry.projectId) !== String(originProjectId)) continue;
    refs.add(String(entry.artifactRef));
  }
  return refs;
}

export { hydrateWorkArtifactProjectionFromJournal } from "./workArtifactProjection";

export type WorkPromotionAccessibleProjects = {
  readonly work: ReadonlySet<string>;
  readonly code: ReadonlySet<string>;
};

export async function loadAccessiblePromotionProjects(
  projects: Pick<ProjectService, "bootstrap">,
  windowId: Parameters<ProjectService["bootstrap"]>[0],
): Promise<WorkPromotionAccessibleProjects> {
  const [work, code] = await Promise.all([
    accessibleWorkProjectIds(projects, windowId),
    accessibleCodeProjectIds(projects, windowId),
  ]);
  return { work, code };
}

export function projectIsAccessible(
  accessible: ReadonlySet<string>,
  projectId: ProjectId,
): boolean {
  return accessible.has(String(projectId));
}

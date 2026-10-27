import type { DesktopLeaseOwner, DesktopRecipe, Project, ProjectId } from "@octant/contracts";

/**
 * The recipe a lease owner's thread leases from: the one its Code Project
 * stores, read afresh on every call so a person's save or removal applies to
 * the next lease command and the next sweep. Only a Code Project holds a
 * recipe, and an archived one leases nothing, so its running leases end as
 * `recipe-removed` at the next sweep.
 */
export function readProjectDesktopRecipe(input: {
  readonly owner: DesktopLeaseOwner;
  readonly codeThreadProject: (threadId: string) => ProjectId | undefined;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
}): DesktopRecipe | undefined {
  if (input.owner.mode !== "code") return undefined;
  const projectId = input.codeThreadProject(input.owner.threadId);
  if (projectId === undefined) return undefined;
  const project = input.readProject(projectId);
  if (project?.type !== "code" || project.lifecycle !== "active") return undefined;
  return project.desktopRecipe;
}

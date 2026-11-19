import type { ProjectId } from "@octant/contracts/projects";

/**
 * The one key a Project pull-request row and the shell's selected pull request
 * share, so a row can mark itself selected wherever the selection was made.
 */
export function projectPullRequestKey(identity: {
  readonly projectId: ProjectId;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
}): string {
  return `${String(identity.projectId)}:${identity.repositoryOwner}/${identity.repositoryName}#${identity.number}`;
}

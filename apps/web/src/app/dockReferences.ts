import type { ProjectId } from "@octant/contracts/projects";
import { useMemo } from "react";
import {
  parseRepository,
  type useRepositoryPullRequests,
} from "../environment/useRepositoryPullRequests";
import type { DockUtilityLauncherReference } from "../shell/DockUtilityLauncher";
import type { ShellActions } from "./shellActions";

const NO_DOCK_REFERENCES: ReadonlyArray<DockUtilityLauncherReference> = [];

/**
 * The pull requests the active Code thread is already about, offered in More
 * tools beside the tools themselves. Read from the same catalogue the
 * Environment panel uses, so the two never disagree.
 */
export function useDockReferences(input: {
  readonly actions: Pick<ShellActions, "selectProjectPullRequestIdentity">;
  readonly pullRequests: ReturnType<typeof useRepositoryPullRequests>;
  readonly projectId: ProjectId | undefined;
  readonly repository: string | undefined;
}): ReadonlyArray<DockUtilityLauncherReference> {
  const { actions, pullRequests, projectId, repository } = input;
  return useMemo(() => {
    const dockRepository = parseRepository(repository);
    if (
      pullRequests.status !== "ready" ||
      dockRepository === undefined ||
      projectId === undefined
    ) {
      return NO_DOCK_REFERENCES;
    }
    return pullRequests.rows.slice(0, 5).map((row) => ({
      id: String(row.url),
      label: `#${String(row.number)} ${row.title}`,
      detail: `${dockRepository.owner}/${dockRepository.name}`,
      onOpen: () =>
        actions.selectProjectPullRequestIdentity({
          projectId,
          repositoryOwner: dockRepository.owner,
          repositoryName: dockRepository.name,
          number: row.number,
        }),
    }));
  }, [actions, pullRequests, projectId, repository]);
}

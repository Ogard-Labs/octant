import type { ProjectBootstrap, WindowId } from "@octant/contracts";
import { resolveConnectedGitHubRepository } from "../code/connectedRepository";
import type { TrackerMentionSearchSources } from "./trackerMentionSearch";

/** A Work Project's remotes are asked once a minute, not on every keystroke. */
const REMOTES_MAX_AGE_MS = 60_000;

type Remotes = Parameters<typeof resolveConnectedGitHubRepository>[0];

/**
 * The repository and Linear team of a Project the window holds. A Code Project
 * carries the repository the host already observed; a Work Project's folder is
 * asked, and one with no single GitHub remote simply has none.
 */
export function createTrackerMentionProjects(input: {
  readonly projects: { bootstrap(windowId: WindowId): Promise<ProjectBootstrap> };
  readonly remotes: (root: string) => Promise<Remotes | undefined>;
  readonly now?: () => number;
}): TrackerMentionSearchSources["windowProject"] {
  const now = input.now ?? Date.now;
  const observed = new Map<string, { readonly at: number; readonly remotes: Remotes }>();

  async function folderRepository(root: string) {
    const held = observed.get(root);
    let remotes = held !== undefined && now() - held.at < REMOTES_MAX_AGE_MS ? held.remotes : null;
    if (remotes === null) {
      try {
        remotes = (await input.remotes(root)) ?? [];
      } catch {
        remotes = [];
      }
      observed.set(root, { at: now(), remotes });
    }
    return resolveConnectedGitHubRepository(remotes);
  }

  return async (windowId, projectId) => {
    const project = (await input.projects.bootstrap(windowId)).active.find(
      (candidate) => String(candidate.id) === String(projectId),
    );
    if (project === undefined) return undefined;
    const connected =
      project.type === "code"
        ? project.connectedRepository
        : project.type === "work"
          ? await folderRepository(project.binding.canonicalRoot)
          : undefined;
    return {
      ...(connected === undefined
        ? {}
        : { repository: { owner: connected.owner, name: connected.repository } }),
      ...("linearTarget" in project && project.linearTarget !== undefined
        ? { linearTeamId: project.linearTarget.teamId }
        : {}),
    };
  };
}

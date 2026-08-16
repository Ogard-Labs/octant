import type { BindingRevisionId, ProjectId, ThreadWorkingDirectory } from "@octant/contracts";
import type { SkillDiscoveryRootProvider, SkillDiscoveryRootSet } from "./skillDiscoveryService";

interface DiscoveryProject {
  readonly id: ProjectId;
  readonly mode: "work" | "code";
  readonly root: string;
  readonly bindingRevisionId: BindingRevisionId;
}

interface DiscoveryThread {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly mode: "work" | "code";
  readonly lifecycle: string;
  readonly bindingRevisionId?: BindingRevisionId | undefined;
  readonly workingDirectory?: ThreadWorkingDirectory | undefined;
}

export function createThreadSkillDiscoveryRootProvider(options: {
  readonly readProjects: () => ReadonlyArray<DiscoveryProject>;
  readonly readThreads: () => ReadonlyArray<DiscoveryThread>;
  readonly resolveWorkingDirectory: (
    root: string,
    workingDirectory: ThreadWorkingDirectory,
  ) => Promise<string>;
  readonly userGlobalSkillsRoot: string;
}): SkillDiscoveryRootProvider {
  return {
    resolve: async () => {
      const roots: SkillDiscoveryRootSet[] = [];
      const projects = [...options.readProjects()].sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      );
      const threads = [...options.readThreads()].sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      );
      for (const project of projects) {
        for (const thread of threads) {
          if (
            thread.lifecycle !== "active" ||
            thread.projectId !== project.id ||
            thread.mode !== project.mode ||
            thread.bindingRevisionId !== project.bindingRevisionId ||
            thread.workingDirectory === undefined ||
            thread.workingDirectory === "."
          ) {
            continue;
          }
          try {
            roots.push({
              workingDirectory: await options.resolveWorkingDirectory(
                project.root,
                thread.workingDirectory,
              ),
              projectRoot: project.root,
              projectRef: String(project.id),
              userGlobalSkillsRoot: options.userGlobalSkillsRoot,
              scope: {
                mode: thread.mode,
                projectId: project.id,
                threadRef: String(thread.id) as never,
              },
            });
          } catch {
            // Stale, missing, or escaped thread directories contribute no skill context.
          }
        }
        roots.push({
          workingDirectory: project.root,
          projectRoot: project.root,
          projectRef: String(project.id),
          userGlobalSkillsRoot: options.userGlobalSkillsRoot,
        });
      }
      return roots;
    },
  };
}

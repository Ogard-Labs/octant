import { realpath, stat } from "node:fs/promises";
import type { CanonicalProjectBinding, ProjectType } from "@octant/contracts";

type BoundProjectType = Exclude<ProjectType, "chat">;
interface DirectoryStat {
  isDirectory(): boolean;
}

export interface ProjectRootDependencies {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<DirectoryStat>;
}

export class ProjectRootError extends Error {
  readonly category = "unavailable" as const;

  constructor() {
    super("The selected Project root is unavailable.");
    this.name = "ProjectRootError";
  }
}

const liveDependencies: ProjectRootDependencies = { realpath, stat };

export class ProjectRootPort {
  readonly #dependencies: ProjectRootDependencies;

  constructor(dependencies: ProjectRootDependencies = liveDependencies) {
    this.#dependencies = dependencies;
  }

  async validate(
    _projectType: BoundProjectType,
    candidate: string,
  ): Promise<CanonicalProjectBinding> {
    try {
      const canonicalRoot = await this.#dependencies.realpath(candidate);
      const details = await this.#dependencies.stat(canonicalRoot);
      if (!details.isDirectory()) throw new ProjectRootError();
      return { canonicalRoot };
    } catch {
      throw new ProjectRootError();
    }
  }
}

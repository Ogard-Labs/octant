import { execFile as nodeExecFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { CanonicalProjectBinding, ProjectType } from "@octant/contracts";
import { childProcessEnvironment } from "./childProcessEnvironment";

type BoundProjectType = Exclude<ProjectType, "chat">;
interface DirectoryStat {
  isDirectory(): boolean;
}

export interface ProjectRootDependencies {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<DirectoryStat>;
  readonly execFile: (
    file: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ readonly stdout: string }>;
}

export class ProjectRootError extends Error {
  readonly category = "unavailable" as const;

  constructor() {
    super("The selected Project root is unavailable.");
    this.name = "ProjectRootError";
  }
}

const executeFile = promisify(nodeExecFile);
const liveDependencies: ProjectRootDependencies = {
  realpath,
  stat,
  execFile: async (file, args, environment) => {
    const result = await executeFile(file, [...args], {
      encoding: "utf8",
      env: environment,
      shell: false,
    });
    return { stdout: result.stdout };
  },
};

export class ProjectRootPort {
  readonly #dependencies: ProjectRootDependencies;

  constructor(dependencies: ProjectRootDependencies = liveDependencies) {
    this.#dependencies = dependencies;
  }

  async validate(
    projectType: BoundProjectType,
    candidate: string,
  ): Promise<CanonicalProjectBinding> {
    try {
      const canonicalRoot = await this.#dependencies.realpath(candidate);
      const details = await this.#dependencies.stat(canonicalRoot);
      if (!details.isDirectory()) throw new ProjectRootError();
      if (projectType === "code") {
        const { stdout } = await this.#dependencies.execFile(
          "git",
          ["-C", canonicalRoot, "rev-parse", "--show-toplevel"],
          childProcessEnvironment(process.env),
        );
        const reportedRoot = await this.#dependencies.realpath(stdout.trim());
        if (reportedRoot !== canonicalRoot) throw new ProjectRootError();
      }
      return { canonicalRoot };
    } catch {
      throw new ProjectRootError();
    }
  }
}

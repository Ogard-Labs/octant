import type {
  AggregateVersion,
  ImageGenerationOffer,
  Project,
  ProjectId,
  ProjectImageGenerationChoice,
} from "@octant/contracts";
import type { ImageGenerationOfferService } from "./imageGenerationOfferService";

type ThreadScope = Pick<ImageGenerationOffer, "threadKind" | "scopeId">;

/**
 * The profile and model a person said to keep generating with ("Don't ask
 * again" on the image card). A thread in a Project keeps it on the Project,
 * journaled, so it outlives the host, covers the Project's other threads, and
 * a routine's turn there can generate with it. A Chat thread outside a Project
 * has no Project to hold it and keeps it for that thread in host memory, as
 * every thread did before the choice was journaled.
 */
export interface KeptImageGenerationChoices {
  remember(scope: ThreadScope, choice: ProjectImageGenerationChoice): Promise<void>;
  remembered(scope: ThreadScope): ProjectImageGenerationChoice | undefined;
  forget(scope: ThreadScope): Promise<void>;
}

export function createKeptImageGenerationChoices(options: {
  /** Where a thread outside a Project keeps its choice. */
  readonly threadChoices: Pick<ImageGenerationOfferService, "remember" | "remembered" | "forget">;
  /** The Project a thread stands in, read when asked; undefined outside one. */
  readonly projectOf: (scope: ThreadScope) => ProjectId | undefined;
  readonly readProject: (
    projectId: ProjectId,
  ) => Pick<Project, "version" | "imageGenerationChoice"> | undefined;
  /** Journals the Project's choice through the Project command path. */
  readonly changeProject: (command: {
    readonly kind: "change-project-image-generation-choice";
    readonly projectId: ProjectId;
    readonly expectedVersion: AggregateVersion;
    readonly imageGenerationChoice?: ProjectImageGenerationChoice;
  }) => Promise<void>;
}): KeptImageGenerationChoices {
  const sameChoice = (
    left: ProjectImageGenerationChoice | undefined,
    right: ProjectImageGenerationChoice | undefined,
  ): boolean =>
    left === undefined || right === undefined
      ? left === right
      : String(left.profileInstanceId) === String(right.profileInstanceId) &&
        String(left.modelId) === String(right.modelId);

  // The Project command refuses a change that changes nothing, so an answer
  // that repeats the kept choice, or a drop of nothing, journals no event.
  const change = async (
    projectId: ProjectId,
    choice: ProjectImageGenerationChoice | undefined,
  ): Promise<void> => {
    const project = options.readProject(projectId);
    if (project === undefined || sameChoice(project.imageGenerationChoice, choice)) return;
    await options.changeProject({
      kind: "change-project-image-generation-choice",
      projectId,
      expectedVersion: project.version,
      ...(choice === undefined ? {} : { imageGenerationChoice: choice }),
    });
  };

  return {
    async remember(scope, choice) {
      const projectId = options.projectOf(scope);
      if (projectId === undefined) options.threadChoices.remember(scope, choice);
      else await change(projectId, choice);
    },
    remembered(scope) {
      const projectId = options.projectOf(scope);
      return projectId === undefined
        ? options.threadChoices.remembered(scope)
        : options.readProject(projectId)?.imageGenerationChoice;
    },
    async forget(scope) {
      const projectId = options.projectOf(scope);
      if (projectId === undefined) options.threadChoices.forget(scope);
      else await change(projectId, undefined);
    },
  };
}

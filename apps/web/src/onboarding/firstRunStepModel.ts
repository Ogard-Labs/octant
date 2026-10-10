/**
 * The shape of first run.
 *
 * Three steps, in the order a first task needs them: what this Mac can reach,
 * the folder the task works in, and the model it starts with. Providers come
 * first because the model is picked from what the provider step found —
 * offering a model list before the host has looked would offer an empty one.
 * Profile, appearance, and Navigator are not prerequisites for a task, so
 * they live in Settings rather than in front of it.
 *
 * Every step is skippable. The readiness view after them does not invent a
 * provider, Project, or model they did not give: skip leaves first run
 * answered as skipped, and a missing fact opens that setup surface.
 */
export const FIRST_RUN_STEP_IDS = ["providers", "project", "model"] as const;
export type FirstRunStepId = (typeof FIRST_RUN_STEP_IDS)[number];

export interface FirstRunStepDescriptor {
  readonly id: FirstRunStepId;
  readonly title: string;
  readonly summary: string;
  /**
   * Whether the host holds a real answer for this step. Not "visited": walking
   * past a step without choosing anything leaves it unconfigured, and the rail
   * says so.
   */
  readonly configured: boolean;
  readonly current: boolean;
}

export interface FirstRunStepInputs {
  readonly current: FirstRunStepId;
  readonly providersReady: boolean;
  readonly projectReady: boolean;
  readonly modelChosen: boolean;
}

const TITLES: Record<FirstRunStepId, string> = {
  providers: "Providers",
  project: "Project",
  model: "Model",
};

const SUMMARIES: Record<FirstRunStepId, string> = {
  providers: "What this Mac can actually reach.",
  project: "The folder your first task works in.",
  model: "The model your first task starts with.",
};

export function buildFirstRunSteps(
  inputs: FirstRunStepInputs,
): ReadonlyArray<FirstRunStepDescriptor> {
  const configured: Record<FirstRunStepId, boolean> = {
    providers: inputs.providersReady,
    project: inputs.projectReady,
    model: inputs.modelChosen,
  };
  return FIRST_RUN_STEP_IDS.map((id) => ({
    id,
    title: TITLES[id],
    summary: SUMMARIES[id],
    configured: configured[id],
    current: id === inputs.current,
  }));
}

export function nextFirstRunStep(current: FirstRunStepId): FirstRunStepId | undefined {
  return FIRST_RUN_STEP_IDS[FIRST_RUN_STEP_IDS.indexOf(current) + 1];
}

export function previousFirstRunStep(current: FirstRunStepId): FirstRunStepId | undefined {
  const index = FIRST_RUN_STEP_IDS.indexOf(current);
  return index <= 0 ? undefined : FIRST_RUN_STEP_IDS[index - 1];
}

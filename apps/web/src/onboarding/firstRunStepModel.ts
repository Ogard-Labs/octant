/**
 * The shape of first run (`BOOT-01`).
 *
 * Five steps, in the order a new host actually needs them: who you are, how the
 * workspace looks and which modes you use, what this Mac can reach, which model
 * Chat starts with, and whether Navigator is turned on. Providers come before
 * the two model choices because both of those are picked from what the provider
 * step found — offering a model list before the host has looked would offer an
 * empty one.
 *
 * Every step is skippable. None of them gates the composer: a user who wants
 * none of this can leave first run at any point, and the surface says what
 * that costs rather than refusing to let them.
 */
export const FIRST_RUN_STEP_IDS = [
  "profile",
  "workspace",
  "providers",
  "default-model",
  "navigator",
] as const;
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
  readonly profileConfigured: boolean;
  readonly workspaceConfigured: boolean;
  readonly providersReady: boolean;
  readonly chatDefaultConfigured: boolean;
  readonly navigatorConfigured: boolean;
}

const TITLES: Record<FirstRunStepId, string> = {
  profile: "About you",
  workspace: "Workspace",
  providers: "Providers",
  "default-model": "Default model",
  navigator: "Navigator",
};

const SUMMARIES: Record<FirstRunStepId, string> = {
  profile: "Your name and avatar, kept on this Mac.",
  workspace: "Appearance, and which modes you use.",
  providers: "What this Mac can actually reach.",
  "default-model": "The model new Chat threads start with.",
  navigator: "The optional assistant in the sidebar.",
};

/**
 * The workspace choices, as first run presents them together.
 *
 * They come from two different stores — theme settings and shell settings —
 * but they answer one question for the user, so the step reads them as one
 * value. `colorScheme` is `undefined` while theme settings are still loading,
 * which is not the same fact as having chosen "system".
 */
export interface WorkspaceChoices {
  readonly colorScheme: "system" | "light" | "dark" | undefined;
  readonly chatEnabled: boolean;
  readonly workEnabled: boolean;
  readonly modeSwitcher: "buttons" | "dropdown";
}

/**
 * Whether the user has actually chosen anything on the workspace step.
 *
 * Unlike a profile or a model, every one of these settings always holds a
 * value, so "has an answer" would be true before the user had seen the step.
 * The honest reading of the rail's checkmark here is therefore "you changed
 * something from what Octant ships with", which is the only fact that
 * distinguishes a decision from a default nobody looked at.
 */
export function isWorkspaceConfigured(choices: WorkspaceChoices): boolean {
  if (choices.colorScheme !== undefined && choices.colorScheme !== "system") return true;
  if (!choices.chatEnabled || !choices.workEnabled) return true;
  return choices.modeSwitcher !== "buttons";
}

export function buildFirstRunSteps(
  inputs: FirstRunStepInputs,
): ReadonlyArray<FirstRunStepDescriptor> {
  const configured: Record<FirstRunStepId, boolean> = {
    profile: inputs.profileConfigured,
    workspace: inputs.workspaceConfigured,
    providers: inputs.providersReady,
    "default-model": inputs.chatDefaultConfigured,
    navigator: inputs.navigatorConfigured,
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

export function isLastFirstRunStep(current: FirstRunStepId): boolean {
  return nextFirstRunStep(current) === undefined;
}

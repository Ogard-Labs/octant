import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { findPickerModel } from "@octant/domain";
import type { FirstRunReadinessOverall } from "./firstRunReadinessModel";

/**
 * The three facts the end of first run has to report, and the one next action
 * they produce.
 *
 * This model is the handoff after the setup steps: whether a real task can
 * start in the selected mode, and if not, which exact surface still has to be
 * opened. Skipping is not modelled here — skip records skip and does not
 * invent any of these facts.
 */

/**
 * The modes a first task can start in. First run asks for a folder, and a
 * Chat Project has none, so Chat is reached from the shell rather than here.
 */
export type FirstRunTaskMode = Extract<OctantMode, "work" | "code">;

export type FirstRunHandoffSetupTarget = "providers" | "project" | "model";

export interface FirstRunHandoffProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly type: OctantMode;
  readonly lifecycle: "active" | "archived";
}

export interface FirstRunHandoffModelChoice {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly label: string;
}

export interface FirstRunHandoffFact {
  readonly id: "provider" | "project" | "model";
  readonly label: string;
  readonly ready: boolean;
  readonly detail: string;
}

export type FirstRunHandoffPrimary =
  | {
      readonly kind: "start-thread";
      readonly label: string;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: "setup";
      readonly target: FirstRunHandoffSetupTarget;
      readonly label: string;
    };

export interface FirstRunHandoff {
  readonly mode: FirstRunTaskMode;
  readonly facts: readonly [FirstRunHandoffFact, FirstRunHandoffFact, FirstRunHandoffFact];
  readonly ready: boolean;
  readonly primary: FirstRunHandoffPrimary;
  readonly project: FirstRunHandoffProject | undefined;
  readonly model: FirstRunHandoffModelChoice | undefined;
}

export interface FirstRunHandoffInput {
  readonly mode: FirstRunTaskMode;
  readonly providerOverall: FirstRunReadinessOverall;
  readonly providerHeadline: string;
  readonly projects: ReadonlyArray<FirstRunHandoffProject>;
  /** The Project picked on the Project step, when there was more than one. */
  readonly preferredProjectId?: ProjectId | undefined;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly preferredDefault?: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  };
}

const MODE_LABEL: Record<FirstRunTaskMode, string> = {
  work: "Work",
  code: "Code",
};

/**
 * The first model this mode can actually start a thread with.
 *
 * Groups still list models the picker itself marks unusable, so presence in a
 * section is not enough: a Code group that only offered chat-only models would
 * otherwise look ready and fail after the thread existed.
 */
export function firstSelectableModel(
  groups: ReadonlyArray<PickerGroup>,
): FirstRunHandoffModelChoice | undefined {
  for (const group of groups) {
    for (const section of group.sections) {
      for (const picker of section.models) {
        if (picker.unavailableReason !== undefined) continue;
        return {
          providerInstanceId: group.instance.id,
          modelId: picker.model.id,
          label: `${picker.model.displayName} on ${group.instance.displayName}`,
        };
      }
    }
  }
  return undefined;
}

function resolveModeModel(
  groups: ReadonlyArray<PickerGroup>,
  preferred: FirstRunHandoffInput["preferredDefault"],
): FirstRunHandoffModelChoice | undefined {
  if (preferred !== undefined) {
    const picker = findPickerModel(groups, preferred);
    if (picker !== undefined && picker.unavailableReason === undefined) {
      const group = groups.find(
        (candidate) => String(candidate.instance.id) === String(preferred.providerInstanceId),
      );
      return {
        providerInstanceId: preferred.providerInstanceId,
        modelId: preferred.modelId,
        label: `${picker.model.displayName} on ${group?.instance.displayName ?? "this provider"}`,
      };
    }
  }
  return firstSelectableModel(groups);
}

export function projectsForMode(
  projects: ReadonlyArray<FirstRunHandoffProject>,
  mode: FirstRunTaskMode,
): ReadonlyArray<FirstRunHandoffProject> {
  return projects.filter((project) => project.type === mode && project.lifecycle === "active");
}

/**
 * The Project a first task starts in: the one the user picked, while it is
 * still an active Project of this mode, otherwise the first one that is.
 */
export function projectForMode(
  projects: ReadonlyArray<FirstRunHandoffProject>,
  mode: FirstRunTaskMode,
  preferredProjectId?: ProjectId,
): FirstRunHandoffProject | undefined {
  const candidates = projectsForMode(projects, mode);
  return (
    candidates.find((project) => String(project.id) === String(preferredProjectId)) ?? candidates[0]
  );
}

function providerFact(input: FirstRunHandoffInput): FirstRunHandoffFact {
  if (input.providerOverall === "checking") {
    return {
      id: "provider",
      label: "Provider",
      ready: false,
      detail: "Octant is still checking this host, so it cannot say a provider is ready.",
    };
  }
  if (input.providerOverall === "authority-unavailable") {
    return {
      id: "provider",
      label: "Provider",
      ready: false,
      detail:
        "Octant cannot reach its own provider registry, so it cannot say a provider is ready.",
    };
  }
  if (input.providerOverall === "ready") {
    return {
      id: "provider",
      label: "Provider",
      ready: true,
      detail: input.providerHeadline,
    };
  }
  return {
    id: "provider",
    label: "Provider",
    ready: false,
    detail: input.providerHeadline,
  };
}

function projectFact(
  mode: FirstRunTaskMode,
  project: FirstRunHandoffProject | undefined,
): FirstRunHandoffFact {
  if (project !== undefined) {
    return {
      id: "project",
      label: "Project",
      ready: true,
      detail: project.name,
    };
  }
  return {
    id: "project",
    label: "Project",
    ready: false,
    detail: `No ${MODE_LABEL[mode]} folder yet. A task starts in a Project.`,
  };
}

function modelFact(
  mode: FirstRunTaskMode,
  model: FirstRunHandoffModelChoice | undefined,
): FirstRunHandoffFact {
  if (model !== undefined) {
    return {
      id: "model",
      label: "Model",
      ready: true,
      detail: model.label,
    };
  }
  return {
    id: "model",
    label: "Model",
    ready: false,
    detail: `No model this host can use in ${MODE_LABEL[mode]} yet.`,
  };
}

function primaryAction(
  providerReady: boolean,
  project: FirstRunHandoffProject | undefined,
  model: FirstRunHandoffModelChoice | undefined,
): FirstRunHandoffPrimary {
  if (!providerReady) {
    return { kind: "setup", target: "providers", label: "Set up a provider" };
  }
  if (project === undefined) {
    // The same words, and the same create surface, as the empty Work and Code
    // pages, so the folder chosen here is chosen the way it is chosen later.
    return { kind: "setup", target: "project", label: "Choose a folder…" };
  }
  if (model === undefined) {
    // Any usable model would already have been taken as the fallback, so none
    // being there is a provider-setup problem the model step cannot answer.
    return { kind: "setup", target: "providers", label: "Set up a provider" };
  }
  return { kind: "start-thread", label: "Start a task", projectId: project.id };
}

export function resolveFirstRunHandoff(input: FirstRunHandoffInput): FirstRunHandoff {
  const project = projectForMode(input.projects, input.mode, input.preferredProjectId);
  const model = resolveModeModel(input.groups, input.preferredDefault);
  const provider = providerFact(input);
  const facts = [provider, projectFact(input.mode, project), modelFact(input.mode, model)] as const;
  const ready = facts.every((fact) => fact.ready);
  return {
    mode: input.mode,
    facts,
    ready,
    primary: primaryAction(provider.ready, project, model),
    project,
    model,
  };
}

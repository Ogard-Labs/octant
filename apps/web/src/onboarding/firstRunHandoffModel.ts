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
 * Setup stays the five steps 0019 named. This model is the handoff after them:
 * whether a real thread can start in the selected mode, and if not, which
 * exact surface still has to be opened. Skipping is not modelled here — skip
 * records skip and does not invent any of these facts.
 */

export type FirstRunHandoffSetupTarget = "providers" | "project" | "default-model";

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
  readonly mode: OctantMode;
  readonly facts: readonly [FirstRunHandoffFact, FirstRunHandoffFact, FirstRunHandoffFact];
  readonly ready: boolean;
  readonly primary: FirstRunHandoffPrimary;
  readonly project: FirstRunHandoffProject | undefined;
  readonly model: FirstRunHandoffModelChoice | undefined;
}

export interface FirstRunHandoffInput {
  readonly mode: OctantMode;
  readonly providerOverall: FirstRunReadinessOverall;
  readonly providerHeadline: string;
  readonly projects: ReadonlyArray<FirstRunHandoffProject>;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly preferredDefault?: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  };
}

const MODE_LABEL: Record<OctantMode, string> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};

const PROJECT_NOUN: Record<OctantMode, string> = {
  chat: "Chat Project",
  work: "Work folder",
  code: "Code folder",
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

export function projectForMode(
  projects: ReadonlyArray<FirstRunHandoffProject>,
  mode: OctantMode,
): FirstRunHandoffProject | undefined {
  return projects.find((project) => project.type === mode && project.lifecycle === "active");
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
  mode: OctantMode,
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
    detail: `No ${PROJECT_NOUN[mode]} yet. A thread starts in a Project.`,
  };
}

function modelFact(
  mode: OctantMode,
  model: FirstRunHandoffModelChoice | undefined,
): FirstRunHandoffFact {
  if (model !== undefined) {
    return {
      id: "model",
      label: "Default model",
      ready: true,
      detail: model.label,
    };
  }
  return {
    id: "model",
    label: "Default model",
    ready: false,
    detail: `No model this host can use in ${MODE_LABEL[mode]} yet.`,
  };
}

function primaryAction(
  mode: OctantMode,
  providerReady: boolean,
  project: FirstRunHandoffProject | undefined,
  model: FirstRunHandoffModelChoice | undefined,
): FirstRunHandoffPrimary {
  if (!providerReady) {
    return { kind: "setup", target: "providers", label: "Set up a provider" };
  }
  if (project === undefined) {
    return {
      kind: "setup",
      target: "project",
      label: mode === "chat" ? "Create a Chat Project" : `Add a ${MODE_LABEL[mode]} folder`,
    };
  }
  if (model === undefined) {
    // Chat's default-model step is the picker for that mode. Work and Code
    // have no first-run model step of their own: a missing mode-valid model
    // is a provider-setup problem, not a Chat default to reuse.
    return mode === "chat"
      ? { kind: "setup", target: "default-model", label: "Choose a default model" }
      : { kind: "setup", target: "providers", label: "Set up a provider" };
  }
  return {
    kind: "start-thread",
    label: `Start a ${MODE_LABEL[mode]} thread`,
    projectId: project.id,
  };
}

export function resolveFirstRunHandoff(input: FirstRunHandoffInput): FirstRunHandoff {
  const project = projectForMode(input.projects, input.mode);
  const model = resolveModeModel(input.groups, input.preferredDefault);
  const provider = providerFact(input);
  const facts = [provider, projectFact(input.mode, project), modelFact(input.mode, model)] as const;
  const ready = facts.every((fact) => fact.ready);
  return {
    mode: input.mode,
    facts,
    ready,
    primary: primaryAction(input.mode, provider.ready, project, model),
    project,
    model,
  };
}

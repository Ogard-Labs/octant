import type { OctantMode } from "@octant/contracts/modes";
import type { ProviderDriverKind } from "@octant/contracts/providers";
import type { ProviderInstance } from "@octant/contracts/providers";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type { ProviderModel } from "@octant/contracts/providers";
import type { ProviderObservedState } from "@octant/contracts/providers";
import type { ProviderReadiness } from "@octant/contracts/providers";
import {
  hasVerifiedToolAuthority,
  hasWorkToolAuthority,
  orderProviderInstances,
  orderProviderModels,
  resolveCapabilitySupport,
} from "./modelCatalogPolicy";
import { isImageProfileDriverKind } from "./providerPolicy";

const driverLabels: Readonly<Record<ProviderDriverKind, string>> = {
  codex: "Codex CLI",
  claude: "Claude Agent SDK",
  opencode: "OpenCode CLI",
  kilo: "Kilo ACP",
  pi: "Pi RPC",
  "oh-my-pi": "Oh My Pi",
  devin: "Devin ACP",
  "mistral-vibe": "Mistral Vibe ACP",
  ollama: "Ollama",
  "kimi-code": "Kimi Code ACP",
  grok: "Grok Build ACP",
  "openai-compatible": "OpenAI-compatible HTTP",
  "anthropic-compatible": "Anthropic-compatible HTTP",
  "azure-foundry": "Azure AI Foundry",
  "openai-image": "OpenAI Image",
  "gemini-native-image": "Gemini Image",
};

export function driverLabel(driverKind: ProviderDriverKind): string {
  return driverLabels[driverKind];
}

export function endpointHostOf(instance: ProviderInstance): string | undefined {
  switch (instance.configuration.kind) {
    case "openai-compatible-http":
    case "anthropic-compatible-http":
    case "azure-foundry-openai-http":
    case "ollama-native-http":
      try {
        return new URL(instance.configuration.baseUrl).host;
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}

const localExecutionHost = "Local host";

export interface ModelBadge {
  readonly kind: "tools" | "vision" | "reasoning" | "local" | "context-limit";
  readonly label: string;
}

export function modelBadges(
  model: ProviderModel,
  driverKind?: ProviderDriverKind | undefined,
  verifiedToolModelIds: ReadonlyArray<ProviderModelId> = [],
): ReadonlyArray<ModelBadge> {
  const badges: ModelBadge[] = [];
  const toolSupport = resolveCapabilitySupport(
    (model.capabilityEvidence ?? []).filter(({ capability }) => capability === "tool-calling"),
  );
  const providerVerified =
    driverKind === "azure-foundry" &&
    verifiedToolModelIds.some((id) => String(id) === String(model.id));
  if (
    (toolSupport === "supported" || providerVerified) &&
    (driverKind === undefined
      ? hasVerifiedToolAuthority(model)
      : hasWorkToolAuthority(driverKind, model, verifiedToolModelIds))
  ) {
    badges.push({ kind: "tools", label: "Tools" });
  }
  if (model.inputModalities.includes("image")) {
    badges.push({ kind: "vision", label: "Vision" });
  }
  if (model.reasoning === "supported") {
    badges.push({ kind: "reasoning", label: "Reasoning" });
  }
  if (model.contextLimit !== undefined) {
    badges.push({ kind: "context-limit", label: formatContextLimit(model.contextLimit) });
  }
  return badges;
}

function formatContextLimit(contextLimit: number): string {
  if (contextLimit >= 1_000_000) {
    return `${(contextLimit / 1_000_000).toFixed(contextLimit % 1_000_000 === 0 ? 0 : 1)}M context`;
  }
  if (contextLimit >= 1_000) {
    return `${Math.round(contextLimit / 1_000)}K context`;
  }
  return `${contextLimit} context`;
}

export interface PickerModel {
  readonly model: ProviderModel;
  readonly badges: ReadonlyArray<ModelBadge>;
  readonly toolCapable: boolean;
  readonly unavailableReason?: string;
}

export type PickerSectionId = "tool-capable" | "chat-and-analysis-only" | "all-models";

export interface PickerSection {
  readonly id: PickerSectionId;
  readonly label: string;
  readonly models: ReadonlyArray<PickerModel>;
}

export interface PickerGroup {
  readonly instance: ProviderInstance;
  readonly readiness: ProviderReadiness;
  readonly driverLabel: string;
  readonly endpointHost: string | undefined;
  readonly executionHost: string;
  readonly sections: ReadonlyArray<PickerSection>;
  readonly unavailableCurrent?: PickerModel;
}

export interface ModelPickerSelection {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

export function findPickerModel(
  groups: ReadonlyArray<PickerGroup>,
  selection: ModelPickerSelection | undefined,
): PickerModel | undefined {
  if (selection === undefined) return undefined;
  const group = groups.find((candidate) => candidate.instance.id === selection.providerInstanceId);
  if (group === undefined) return undefined;
  for (const section of group.sections) {
    const model = section.models.find((candidate) => candidate.model.id === selection.modelId);
    if (model !== undefined) return model;
  }
  return undefined;
}

export function isDraftSelectionSelectable(
  groups: ReadonlyArray<PickerGroup>,
  selection: ModelPickerSelection | undefined,
): boolean {
  if (selection === undefined) return true;
  const model = findPickerModel(groups, selection);
  return model !== undefined && model.unavailableReason === undefined;
}

// A retained draft pair may become stale while the draft stays open (provider
// disabled, unready, or no longer reporting the model). Re-validate it against
// the current picker groups before it is submitted so the server never rejects
// a selection the UI could no longer offer.
export function resolveDraftProviderSelection(
  groups: ReadonlyArray<PickerGroup>,
  selection: ModelPickerSelection | undefined,
): ModelPickerSelection | undefined {
  return isDraftSelectionSelectable(groups, selection) ? selection : undefined;
}

export interface ModelPickerInput {
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly observedByInstance: ReadonlyMap<ProviderInstanceId, ProviderObservedState>;
  readonly providerOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly mode: OctantMode;
  readonly currentSelection?: ModelPickerSelection | undefined;
  readonly hostId?: string | undefined;
}

const readyReadiness: ReadonlySet<ProviderReadiness> = new Set(["ready", "degraded"]);

/**
 * Can this provider answer with `modelId` right now?
 *
 * `degraded` is not a refusal: a provider whose discovery or streaming is
 * partial still answers with the models it did report (a Foundry profile whose
 * `/models` call confirmed no deployment, for example, still serves its
 * manually configured deployments). Chat therefore accepts a degraded provider
 * whenever the selected model is still in the probed catalog, and every surface
 * that tells the user whether Chat can answer must decide it the same way, so
 * onboarding never calls a provider unusable that Chat would happily use.
 */
export function providerCanServeModel(
  observed: Pick<ProviderObservedState, "readiness" | "models">,
  modelId: ProviderModelId,
): boolean {
  return (
    readyReadiness.has(observed.readiness) &&
    observed.models.some((model) => String(model.id) === String(modelId))
  );
}

/**
 * Can this provider answer with any model it reported? The user has not picked
 * a model yet during first run, so the question is whether some choice exists
 * that {@link providerCanServeModel} would accept.
 */
export function providerCanServeAnyModel(
  observed: Pick<ProviderObservedState, "readiness" | "models">,
): boolean {
  return observed.models.some((model) => providerCanServeModel(observed, model.id));
}

export function buildModelPickerGroups(input: ModelPickerInput): ReadonlyArray<PickerGroup> {
  const ordered = orderProviderInstances(input.instances, input.providerOrder ?? []);
  const groups: PickerGroup[] = [];
  for (const instance of ordered) {
    if (isImageProfileDriverKind(instance.driverKind)) continue;
    const observed = input.observedByInstance.get(instance.id);
    if (observed === undefined) {
      maybeAppendUnavailableCurrent(groups, instance, input, observed);
      continue;
    }
    if (!instance.enabled || !readyReadiness.has(observed.readiness)) {
      maybeAppendUnavailableCurrent(groups, instance, input, observed);
      continue;
    }
    const orderedModels = orderProviderModels(observed.models, manualModelOrderOf(instance));
    const sections = sectionModels(
      orderedModels,
      input.mode,
      instance.driverKind,
      observed.verifiedToolModelIds ?? [],
    );
    const currentSelection = input.currentSelection;
    const unavailableCurrent =
      currentSelection !== undefined &&
      currentSelection.providerInstanceId === instance.id &&
      !orderedModels.some((m) => m.id === currentSelection.modelId)
        ? unavailableCurrentModel(
            currentSelection.modelId,
            observed,
            instance.driverKind,
            observed.verifiedToolModelIds ?? [],
          )
        : undefined;
    groups.push({
      instance,
      readiness: observed.readiness,
      driverLabel: driverLabel(instance.driverKind),
      endpointHost: endpointHostOf(instance),
      executionHost: input.hostId ?? localExecutionHost,
      sections,
      ...(unavailableCurrent === undefined ? {} : { unavailableCurrent }),
    });
  }
  return groups;
}

function manualModelOrderOf(instance: ProviderInstance): ReadonlyArray<ProviderModelId> {
  switch (instance.configuration.kind) {
    case "openai-compatible-http":
    case "anthropic-compatible-http":
    case "azure-foundry-openai-http":
      return instance.configuration.manualModelIds;
    default:
      return [];
  }
}

function sectionModels(
  models: ReadonlyArray<ProviderModel>,
  mode: OctantMode,
  driverKind: ProviderDriverKind,
  verifiedToolModelIds: ReadonlyArray<ProviderModelId>,
): ReadonlyArray<PickerSection> {
  if (mode === "chat") {
    return [
      {
        id: "all-models",
        label: "Models",
        models: models.map((model) => toPickerModel(model, driverKind, verifiedToolModelIds)),
      },
    ];
  }
  const toolCapable: PickerModel[] = [];
  const chatOnly: PickerModel[] = [];
  for (const model of models) {
    const picker = toPickerModel(model, driverKind, verifiedToolModelIds);
    if (picker.toolCapable) {
      toolCapable.push(picker);
    } else {
      chatOnly.push({
        ...picker,
        unavailableReason: chatOnlyReason(model),
      });
    }
  }
  const sections: PickerSection[] = [];
  if (toolCapable.length > 0) {
    sections.push({ id: "tool-capable", label: "Tool-capable", models: toolCapable });
  }
  if (chatOnly.length > 0) {
    sections.push({
      id: "chat-and-analysis-only",
      label: "Chat and analysis only",
      models: chatOnly,
    });
  }
  return sections;
}

function toPickerModel(
  model: ProviderModel,
  driverKind: ProviderDriverKind,
  verifiedToolModelIds: ReadonlyArray<ProviderModelId>,
): PickerModel {
  return {
    model,
    badges: modelBadges(model, driverKind, verifiedToolModelIds),
    toolCapable: hasWorkToolAuthority(driverKind, model, verifiedToolModelIds),
  };
}

function chatOnlyReason(model: ProviderModel): string {
  const toolSupport = resolveCapabilitySupport(
    (model.capabilityEvidence ?? []).filter(({ capability }) => capability === "tool-calling"),
  );
  if (toolSupport === "unsupported") {
    return "This model does not support tool calling. It can chat and analyze, but cannot execute Code or Work tools.";
  }
  if (toolSupport === "unavailable") {
    return "Tool calling has not been verified for this model. Run a capability check before using it for tool work.";
  }
  return "Tool calling is not verified for this provider instance. It can chat and analyze only.";
}

function unavailableCurrentModel(
  modelId: ProviderModelId,
  observed: ProviderObservedState | undefined,
  driverKind: ProviderDriverKind,
  verifiedToolModelIds: ReadonlyArray<ProviderModelId>,
): PickerModel {
  const existing = observed?.models.find((m) => m.id === modelId);
  if (existing !== undefined) {
    return {
      model: existing,
      badges: modelBadges(existing, driverKind, verifiedToolModelIds),
      toolCapable: hasWorkToolAuthority(driverKind, existing, verifiedToolModelIds),
      unavailableReason: "This selection is not available from the provider right now.",
    };
  }
  const placeholder = placeholderModel(modelId);
  return {
    model: placeholder,
    badges: [],
    toolCapable: false,
    unavailableReason: "This model is no longer listed by the provider. Choose a current model.",
  };
}

function placeholderModel(modelId: ProviderModelId): ProviderModel {
  return {
    id: modelId,
    displayName: String(modelId),
    orderHint: undefined,
    contextLimit: undefined,
    maxOutputTokens: undefined,
    reasoning: "unavailable",
    toolCalling: undefined,
    parallelTools: undefined,
    structuredOutput: undefined,
    streaming: undefined,
    inputModalities: ["text"],
    options: [],
    capabilityEvidence: undefined,
    source: "manual",
    verification: "unverified",
  } as unknown as ProviderModel;
}

function maybeAppendUnavailableCurrent(
  groups: PickerGroup[],
  instance: ProviderInstance,
  input: ModelPickerInput,
  observed: ProviderObservedState | undefined,
): void {
  if (
    input.currentSelection === undefined ||
    input.currentSelection.providerInstanceId !== instance.id
  ) {
    return;
  }
  groups.push({
    instance,
    readiness: observed?.readiness ?? "unavailable",
    driverLabel: driverLabel(instance.driverKind),
    endpointHost: endpointHostOf(instance),
    executionHost: input.hostId ?? localExecutionHost,
    sections: [],
    unavailableCurrent: unavailableCurrentModel(
      input.currentSelection.modelId,
      observed,
      instance.driverKind,
      observed?.verifiedToolModelIds ?? [],
    ),
  });
}

export function filterModelPickerGroups(
  groups: ReadonlyArray<PickerGroup>,
  query: string,
): ReadonlyArray<PickerGroup> {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return groups;
  const filtered: PickerGroup[] = [];
  for (const group of groups) {
    const groupText = [
      group.instance.displayName,
      group.driverLabel,
      group.endpointHost ?? "",
      group.executionHost,
    ]
      .join(" ")
      .toLowerCase();
    const providerMatch = groupText.includes(trimmed);
    const matchingSections = group.sections
      .map((section) => ({
        ...section,
        models: section.models.filter((picker) => {
          const modelText = `${picker.model.displayName} ${String(picker.model.id)}`.toLowerCase();
          return providerMatch || modelText.includes(trimmed);
        }),
      }))
      .filter((section) => section.models.length > 0);
    if (matchingSections.length > 0) {
      filtered.push({ ...group, sections: matchingSections });
    } else if (
      providerMatch &&
      group.sections.length === 0 &&
      group.unavailableCurrent !== undefined
    ) {
      filtered.push(group);
    }
  }
  return filtered;
}

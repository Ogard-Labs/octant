import type {
  ProviderFailure,
  ProviderInstanceId,
  ProviderModel,
  ProviderModelId,
} from "@octant/contracts";
import {
  learnContextWindow,
  resolveModelInputModalities,
} from "@octant/domain/model-context-window";
import { contextWindowFromRefusal, isContextOverflowFailure } from "./endpointRetry";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * The model facts a probe never reports — the window a person set, the one
 * the endpoint's refusals taught, and the model it said it served. A probe
 * rebuilds each model from the provider's listing, so these are carried over
 * from the previous observation or the persisted catalogue by model id;
 * without that, every Chat turn's probe would forget them.
 */
export function carryModelContextWindowFacts<Model extends ProviderModel>(
  models: ReadonlyArray<Model>,
  from: ReadonlyArray<ProviderModel> | undefined,
): ReadonlyArray<Model> {
  if (from === undefined || from.length === 0) return models;
  const prior = new Map(from.map((model) => [String(model.id), model]));
  return models.map((model) => {
    const previous = prior.get(String(model.id));
    if (previous === undefined) return model;
    const contextWindowOverride = model.contextWindowOverride ?? previous.contextWindowOverride;
    const learnedContextWindow = model.learnedContextWindow ?? previous.learnedContextWindow;
    const servedModelId = model.servedModelId ?? previous.servedModelId;
    return withServedModelInputs({
      ...model,
      ...(contextWindowOverride === undefined ? {} : { contextWindowOverride }),
      ...(learnedContextWindow === undefined ? {} : { learnedContextWindow }),
      ...(servedModelId === undefined ? {} : { servedModelId }),
    });
  });
}

/**
 * A model whose listing and id named no inputs (`imageInput` absent) takes
 * them from the profile of the model the endpoint said it served. A probe
 * resolves inputs before the served model is carried back, so without this a
 * deployment with a name of its own would stay text-only. A listing that
 * reported its inputs, or an id with a profile, already set `imageInput` and
 * is left alone.
 */
function withServedModelInputs<Model extends ProviderModel>(model: Model): Model {
  if (model.imageInput !== undefined || model.servedModelId === undefined) return model;
  const resolved = resolveModelInputModalities({
    id: String(model.id),
    servedModelId: model.servedModelId,
  });
  return resolved.imageInput === undefined ? model : { ...model, ...resolved };
}

/** What a request on a direct endpoint taught about one of its models. */
export interface ModelContextWindowLesson {
  readonly learnedContextWindow?: number;
  readonly servedModelId?: string;
}

/**
 * Where a direct endpoint keeps what its requests teach about a model's
 * window, so it outlives the session and a restart. The server persists it
 * with the provider's model catalogue.
 */
export interface ModelContextWindowMemory {
  readonly remember: (
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    lesson: ModelContextWindowLesson,
  ) => void;
}

/** How one request on a direct endpoint ended, as far as its model's window is concerned. */
export type EndpointRequestOutcome =
  | { readonly kind: "refused"; readonly failure: ProviderFailure }
  | {
      readonly kind: "completed";
      readonly servedModelId?: string | undefined;
      readonly usedTokens?: number | undefined;
    };

/**
 * Learns what one request showed about its model's window and keeps it in the
 * live observation, where the next size check reads it, and in `memory`. An
 * overflow refusal that names its limit lowers the learned window before the
 * harness shrinks and resends; one that names none teaches nothing, and the
 * harness's own shrink-once recovery still runs. A completed request records
 * the model the endpoint served and raises a learned window it went past.
 */
export function learnFromEndpointRequest(input: {
  readonly runtimeRegistry: Pick<ProviderRuntimeRegistry, "observedState" | "setObservedState">;
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly outcome: EndpointRequestOutcome;
  readonly memory?: ModelContextWindowMemory | undefined;
}): void {
  const observed = input.runtimeRegistry.observedState(input.instanceId);
  const model = observed?.models.find(
    (candidate) => String(candidate.id) === String(input.modelId),
  );
  if (observed === undefined || model === undefined) return;
  let lesson: ModelContextWindowLesson = {};
  if (input.outcome.kind === "refused") {
    if (!isContextOverflowFailure(input.outcome.failure)) return;
    const contextWindow = contextWindowFromRefusal(input.outcome.failure.message);
    if (contextWindow === undefined) return;
    lesson = {
      learnedContextWindow:
        learnContextWindow(model.learnedContextWindow, { kind: "refused", contextWindow }) ??
        contextWindow,
    };
  } else {
    const { servedModelId, usedTokens } = input.outcome;
    const raised =
      usedTokens === undefined
        ? undefined
        : learnContextWindow(model.learnedContextWindow, { kind: "completed", usedTokens });
    lesson = {
      ...(servedModelId === undefined || servedModelId === model.servedModelId
        ? {}
        : { servedModelId }),
      ...(raised === undefined || raised === model.learnedContextWindow
        ? {}
        : { learnedContextWindow: raised }),
    };
  }
  if (
    (lesson.learnedContextWindow === undefined ||
      lesson.learnedContextWindow === model.learnedContextWindow) &&
    lesson.servedModelId === undefined
  ) {
    return;
  }
  input.runtimeRegistry.setObservedState({
    ...observed,
    models: observed.models.map((candidate) =>
      candidate === model ? withServedModelInputs({ ...candidate, ...lesson }) : candidate,
    ),
  });
  try {
    input.memory?.remember(input.instanceId, input.modelId, lesson);
  } catch {
    // The live observation keeps the lesson; persisting it is best effort.
  }
}

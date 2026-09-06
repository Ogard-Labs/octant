import type {
  ImageGenerationCustomSource,
  OpenAiCompatibleProviderInstance,
  ProviderInstance,
  ProviderModelId,
} from "@octant/contracts";

/**
 * Custom image sources ride an OpenAI-compatible HTTP instance, the same base
 * URL, credential, and endpoint policy that instance already has for chat
 * (`docs/decisions/0085`). Only that family exposes the `images/*` routes the
 * adapter speaks, so an instance of any other kind is never offered and never
 * resolves.
 */
export function isImageSourceEligibleInstance(
  instance: ProviderInstance,
): instance is OpenAiCompatibleProviderInstance {
  return instance.driverKind === "openai-compatible";
}

/** Enabled instances Settings may name as a custom image source. */
export function listImageSourceEligibleInstances(
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<OpenAiCompatibleProviderInstance> {
  return instances.filter(
    (instance): instance is OpenAiCompatibleProviderInstance =>
      instance.enabled && isImageSourceEligibleInstance(instance),
  );
}

export type ImageCustomSourceResolution =
  | {
      readonly status: "ready";
      readonly instance: OpenAiCompatibleProviderInstance;
      readonly modelId: ProviderModelId;
      readonly label: string;
    }
  | { readonly status: "unavailable"; readonly label: string; readonly reason: string };

/**
 * Resolve a configured custom image source against the live registry.
 *
 * Settings can outlive the instance it names: the instance may be removed,
 * disabled, or of a kind that never served images. Each of those is
 * `unavailable` with a reason a person can act on, never a silent
 * substitution of some other instance.
 */
export function resolveImageCustomSource(
  source: ImageGenerationCustomSource,
  instances: ReadonlyArray<ProviderInstance>,
): ImageCustomSourceResolution {
  const instance = instances.find(
    (candidate) => String(candidate.id) === String(source.providerInstanceId),
  );
  if (instance === undefined) {
    return {
      status: "unavailable",
      label: source.label,
      reason: "The chosen provider no longer exists.",
    };
  }
  if (!isImageSourceEligibleInstance(instance)) {
    return {
      status: "unavailable",
      label: source.label,
      reason: "Image generation needs an OpenAI-compatible HTTP provider.",
    };
  }
  if (!instance.enabled) {
    return {
      status: "unavailable",
      label: source.label,
      reason: "The chosen provider is disabled.",
    };
  }
  return { status: "ready", instance, modelId: source.modelId, label: source.label };
}

/** Every configured custom source, resolved against the live registry. */
export function resolveImageCustomSources(
  sources: ReadonlyArray<ImageGenerationCustomSource>,
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ImageCustomSourceResolution> {
  return sources.map((source) => resolveImageCustomSource(source, instances));
}

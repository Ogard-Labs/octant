import type {
  OpenAiCompatibleProviderInstance,
  ProviderInstance,
  ProviderModelId,
  SettingsDeepLink,
  SpeechCapabilityStatus,
  SpeechEndpointRef,
  SpeechSynthesisEndpointRef,
  SpeechSynthesisVoice,
  VoiceSettings,
} from "@octant/contracts";

/** Deep link to the Voice transcription setting. */
export const VOICE_TRANSCRIPTION_TARGET: SettingsDeepLink = {
  section: "voice",
  setting: "transcription",
};

/** Deep link to the Voice synthesis setting. */
export const VOICE_SYNTHESIS_TARGET: SettingsDeepLink = {
  section: "voice",
  setting: "synthesis",
};

/**
 * Speech rides an OpenAI-compatible HTTP instance: the same base URL,
 * credential, and endpoint policy that instance already has for chat. Only
 * that family exposes the `/audio/*` routes the adapter speaks, so an
 * instance of any other kind is never offered and never resolves.
 */
export function isSpeechEligibleInstance(
  instance: ProviderInstance,
): instance is OpenAiCompatibleProviderInstance {
  return instance.driverKind === "openai-compatible";
}

/** Enabled instances Settings may name for a speech direction. */
export function listSpeechEligibleInstances(
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<OpenAiCompatibleProviderInstance> {
  return instances.filter(
    (instance): instance is OpenAiCompatibleProviderInstance =>
      instance.enabled && isSpeechEligibleInstance(instance),
  );
}

export type SpeechEndpointResolution =
  | {
      readonly status: "ready";
      readonly instance: OpenAiCompatibleProviderInstance;
      readonly modelId: ProviderModelId;
      readonly voice?: SpeechSynthesisVoice;
    }
  | { readonly status: "unconfigured" }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Resolve a configured speech endpoint against the live registry.
 *
 * Settings can outlive the instance they name: the instance may be removed,
 * disabled, or — after an import — of a kind that never served speech. Each
 * of those is `unavailable` with a reason a person can act on, never a silent
 * substitution of some other instance.
 */
export function resolveSpeechEndpoint(
  ref: SpeechEndpointRef | SpeechSynthesisEndpointRef | undefined,
  instances: ReadonlyArray<ProviderInstance>,
): SpeechEndpointResolution {
  if (ref === undefined) return { status: "unconfigured" };
  const instance = instances.find(
    (candidate) => String(candidate.id) === String(ref.providerInstanceId),
  );
  if (instance === undefined) {
    return { status: "unavailable", reason: "The chosen provider no longer exists." };
  }
  if (!isSpeechEligibleInstance(instance)) {
    return {
      status: "unavailable",
      reason: "Voice needs an OpenAI-compatible HTTP provider.",
    };
  }
  if (!instance.enabled) {
    return { status: "unavailable", reason: "The chosen provider is disabled." };
  }
  // Synthesis needs a voice as much as it needs a model. Reporting ready
  // without one would promise a call the routes already refuse.
  if ("voice" in ref && ref.voice === undefined) {
    return { status: "unavailable", reason: "No voice is chosen." };
  }
  return {
    status: "ready",
    instance,
    modelId: ref.modelId,
    ...("voice" in ref ? { voice: ref.voice } : {}),
  };
}

/** The wire status for one speech direction, with the Settings link that fixes it. */
export function speechCapabilityStatus(
  resolution: SpeechEndpointResolution,
  settingsTarget: SettingsDeepLink,
): SpeechCapabilityStatus {
  switch (resolution.status) {
    case "ready":
      return {
        status: "ready",
        providerInstanceId: resolution.instance.id,
        modelId: resolution.modelId,
        ...(resolution.voice === undefined ? {} : { voice: resolution.voice }),
      };
    case "unconfigured":
      return { status: "unconfigured", settingsTarget };
    case "unavailable":
      return { status: "unavailable", reason: resolution.reason, settingsTarget };
  }
}

/** Both directions at once, as the status endpoint reports them. */
export function speechStatusOf(
  settings: VoiceSettings,
  instances: ReadonlyArray<ProviderInstance>,
): { readonly transcription: SpeechCapabilityStatus; readonly synthesis: SpeechCapabilityStatus } {
  return {
    transcription: speechCapabilityStatus(
      resolveSpeechEndpoint(settings.transcription, instances),
      VOICE_TRANSCRIPTION_TARGET,
    ),
    synthesis: speechCapabilityStatus(
      resolveSpeechEndpoint(settings.synthesis, instances),
      VOICE_SYNTHESIS_TARGET,
    ),
  };
}

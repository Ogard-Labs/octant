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

/**
 * What a paired device is told. Transcription is the host's own answer; read
 * aloud stays with the computer, so synthesis is always `unavailable` there,
 * whatever Settings holds, and the phone never offers a control the host
 * refuses.
 */
export function pairedDeviceSpeechStatusOf(
  settings: VoiceSettings,
  instances: ReadonlyArray<ProviderInstance>,
): { readonly transcription: SpeechCapabilityStatus; readonly synthesis: SpeechCapabilityStatus } {
  return {
    transcription: speechStatusOf(settings, instances).transcription,
    synthesis: {
      status: "unavailable",
      reason: "Read-aloud is available only on the computer itself.",
      settingsTarget: VOICE_SYNTHESIS_TARGET,
    },
  };
}

/**
 * A paired device's share of the host owner's transcription endpoint: thirty
 * clips in any rolling hour. A phone clip is at most a minute, so a device can
 * spend at most half an hour of audio an hour, and a lost or misbehaving phone
 * cannot run up the owner's bill faster than that before it is revoked.
 */
export const REMOTE_TRANSCRIPTION_BUDGET = { maximum: 30, windowMs: 60 * 60_000 } as const;

/** The longest clip a phone records before it stops on its own. */
export const REMOTE_TRANSCRIPTION_MAX_CLIP_MS = 60_000;

/**
 * The most audio one paired-device clip may carry. The private listener reads
 * at most 1 MiB of any request body, and the multipart framing around the clip
 * needs the rest. A minute of mono AAC at 64 kbit/s is about 480 kB.
 */
export const REMOTE_TRANSCRIPTION_MAX_AUDIO_BYTES = 1_000_000;

export type RemoteTranscriptionAdmission =
  | { readonly kind: "admit"; readonly recent: ReadonlyArray<number> }
  | {
      readonly kind: "over-budget";
      readonly recent: ReadonlyArray<number>;
      readonly retryAfterMs: number;
    };

/** `recent` holds the device's admitted clip times (ms) still inside the window. */
export function admitRemoteTranscription(input: {
  readonly recent: ReadonlyArray<number>;
  readonly now: number;
}): RemoteTranscriptionAdmission {
  const windowStart = input.now - REMOTE_TRANSCRIPTION_BUDGET.windowMs;
  const recent = input.recent.filter((admittedAt) => admittedAt > windowStart);
  const oldest = recent[0];
  if (oldest !== undefined && recent.length >= REMOTE_TRANSCRIPTION_BUDGET.maximum) {
    return {
      kind: "over-budget",
      recent,
      retryAfterMs: Math.max(1, oldest + REMOTE_TRANSCRIPTION_BUDGET.windowMs - input.now),
    };
  }
  return { kind: "admit", recent: [...recent, input.now] };
}

import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderModel,
  ProviderModelId,
  ProviderObservedState,
} from "@octant/contracts";
import { isSpeechEligibleInstance } from "@octant/domain";
import { endpointPresetForUrl } from "./addEndpointSteps";

/** The voice models a preset knows its service serves, by model id. */
export interface VoiceModelHint {
  readonly transcription?: string;
  readonly speech?: string;
}

export interface VoiceModels {
  readonly transcription?: string;
  readonly speech?: string;
}

const TRANSCRIPTION_ID = /whisper|transcri|voxtral(?!.*tts)|speech-to-text|stt/i;
const SPEECH_ID = /tts|text-to-speech|(^|[-_/])speech/i;

/**
 * The voice models an endpoint offers, if any. A preset's hint wins when the
 * endpoint lists that model, or when it lists nothing yet; otherwise the model
 * ids themselves are read, the way a person would scan them. A match is an
 * offer to try, never a promise: Voice settings still check the route.
 */
export function voiceModelsOf(
  models: ReadonlyArray<Pick<ProviderModel, "id">> | undefined,
  hint?: VoiceModelHint,
): VoiceModels {
  const ids = (models ?? []).map((model) => String(model.id));
  const pick = (hinted: string | undefined, pattern: RegExp): string | undefined => {
    if (hinted !== undefined && (ids.length === 0 || ids.includes(hinted))) return hinted;
    return ids.find((id) => pattern.test(id));
  };
  const transcription = pick(hint?.transcription, TRANSCRIPTION_ID);
  const speech = pick(hint?.speech, SPEECH_ID);
  return {
    ...(transcription === undefined ? {} : { transcription }),
    ...(speech === undefined || speech === transcription ? {} : { speech }),
  };
}

/**
 * Whether Voice could use this endpoint right now: the same rule the server
 * applies when it resolves a speech endpoint (an enabled OpenAI-compatible
 * instance), so a tip is never offered for a setting that would be refused.
 */
export function isSpeechUsable(instance: ProviderInstance): boolean {
  return instance.enabled && isSpeechEligibleInstance(instance);
}

/** One endpoint and the transcription model Voice could use on it. */
export interface TranscriptionChoice {
  readonly instanceId: ProviderInstanceId;
  readonly instanceName: string;
  readonly modelId: ProviderModelId;
}

/**
 * Every enabled OpenAI-compatible endpoint that lists, or whose preset knows,
 * a transcription model, so Voice settings can offer them as one menu instead
 * of asking for a typed model id. The host still checks the route on use.
 */
export function transcriptionChoices(
  instances: ReadonlyArray<ProviderInstance>,
  observedStates: ReadonlyArray<ProviderObservedState>,
): ReadonlyArray<TranscriptionChoice> {
  const choices: Array<TranscriptionChoice> = [];
  for (const instance of instances) {
    if (!instance.enabled || !isSpeechEligibleInstance(instance)) continue;
    const observed = observedStates.find(
      (state) => String(state.instanceId) === String(instance.id),
    );
    const { transcription } = voiceModelsOf(
      observed?.models,
      endpointPresetForUrl(instance.configuration.baseUrl)?.voice,
    );
    if (transcription === undefined) continue;
    choices.push({
      instanceId: instance.id,
      instanceName: instance.displayName,
      modelId: transcription as ProviderModelId,
    });
  }
  return choices;
}

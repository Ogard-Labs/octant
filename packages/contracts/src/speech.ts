import { Schema } from "effect";
import { ProviderFailureCategory, ProviderInstanceId, ProviderModelId } from "./providers";
import { SettingsDeepLink } from "./settings";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Suggested model IDs for Settings. These are data, not a catalog Octant
 * maintains: any model ID the chosen endpoint accepts is valid, and the
 * suggestions are never rewritten on save.
 */
export const SPEECH_TRANSCRIPTION_MODEL_PRESETS = [
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
  "whisper-1",
] as const;
export const SPEECH_SYNTHESIS_MODEL_PRESETS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"] as const;
export const SPEECH_SYNTHESIS_VOICE_PRESETS = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;

export const SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES = 10_485_760;
export const SPEECH_TRANSCRIPT_MAX_CHARACTERS = 100_000;
export const SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS = 4_096;
export const SPEECH_SYNTHESIS_MAX_AUDIO_BYTES = 10_485_760;
/** Concurrent voice requests one host serves per direction; the rest are refused, not queued. */
export const SPEECH_HOST_CONCURRENCY = 2;

/**
 * Audio a transcription request may carry. The server sniffs the bytes and
 * refuses anything whose signature does not match one of these, so a declared
 * type never speaks for the payload.
 */
export const SPEECH_AUDIO_MEDIA_TYPES = [
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/flac",
] as const;
export const SpeechAudioMediaType = Schema.Literal(...SPEECH_AUDIO_MEDIA_TYPES);
export type SpeechAudioMediaType = typeof SpeechAudioMediaType.Type;

export const SPEECH_SYNTHESIS_FORMATS = ["mp3", "wav", "opus"] as const;
export const SpeechSynthesisFormat = Schema.Literal(...SPEECH_SYNTHESIS_FORMATS);
export type SpeechSynthesisFormat = typeof SpeechSynthesisFormat.Type;
export const SPEECH_SYNTHESIS_FORMAT_MEDIA_TYPES: Readonly<Record<SpeechSynthesisFormat, string>> =
  {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    opus: "audio/ogg",
  };

/**
 * One OpenAI-compatible HTTP provider instance and the model that instance
 * runs for a speech direction. Selecting a pair configures nothing about the
 * provider itself: its base URL, credential, and endpoint policy stay with the
 * provider registry, and every request still fails closed at execution time.
 */
export const SpeechEndpointRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type SpeechEndpointRef = typeof SpeechEndpointRef.Type;

export const SpeechSynthesisVoice = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
export type SpeechSynthesisVoice = typeof SpeechSynthesisVoice.Type;

export const SpeechSynthesisEndpointRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  voice: SpeechSynthesisVoice,
}).annotations(strict);
export type SpeechSynthesisEndpointRef = typeof SpeechSynthesisEndpointRef.Type;

/**
 * Voice settings section.
 *
 * `transcription` is the endpoint that turns speech into text. Absent means
 * the host reports transcription `unconfigured` and every voice control that
 * needs it stays hidden — never a silent fallback to a chat model.
 *
 * `synthesis` is the endpoint that turns text into speech. Absent means no
 * host call is made; a renderer may still read text aloud with the operating
 * system's own voices, which is a renderer-local choice the host never sees.
 */
export const VoiceSettings = Schema.Struct({
  transcription: Schema.optional(SpeechEndpointRef),
  synthesis: Schema.optional(SpeechSynthesisEndpointRef),
}).annotations(strict);
export type VoiceSettings = typeof VoiceSettings.Type;

/** BCP-47-shaped hint the caller may pass to transcription. */
export const SpeechTranscriptionLanguage = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
);
export type SpeechTranscriptionLanguage = typeof SpeechTranscriptionLanguage.Type;

/**
 * What transcription returns. Empty text is a legitimate answer for a silent
 * clip, so the field is not required to be non-empty; the caller decides.
 */
export const SpeechTranscript = Schema.Struct({
  text: Schema.String.pipe(Schema.maxLength(SPEECH_TRANSCRIPT_MAX_CHARACTERS)),
}).annotations(strict);
export type SpeechTranscript = typeof SpeechTranscript.Type;

export const SpeechSynthesisRequest = Schema.Struct({
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS)),
  format: Schema.optional(SpeechSynthesisFormat),
}).annotations(strict);
export type SpeechSynthesisRequest = typeof SpeechSynthesisRequest.Type;

/**
 * Honest readiness of one speech direction. `ready` names the endpoint the
 * host would call. `unconfigured` means Settings holds nothing for it, and
 * `unavailable` means Settings names an endpoint the host cannot use right
 * now (removed, disabled, or not an OpenAI-compatible instance). Both carry
 * the exact Settings destination that fixes it.
 */
export const SpeechCapabilityStatus = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("ready"),
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    voice: Schema.optional(SpeechSynthesisVoice),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unconfigured"),
    settingsTarget: SettingsDeepLink,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
    settingsTarget: SettingsDeepLink,
  }).annotations(strict),
);
export type SpeechCapabilityStatus = typeof SpeechCapabilityStatus.Type;

export const SpeechStatusResponse = Schema.Struct({
  transcription: SpeechCapabilityStatus,
  synthesis: SpeechCapabilityStatus,
}).annotations(strict);
export type SpeechStatusResponse = typeof SpeechStatusResponse.Type;

/**
 * A refused or failed speech request. `unconfigured` and `invalid` are the
 * host's own refusals; every other category is the provider failure the
 * adapter classified, sanitized so no upstream body reaches a renderer.
 */
export const SpeechFailureCategory = Schema.Union(
  Schema.Literal("unconfigured", "invalid"),
  ProviderFailureCategory,
);
export type SpeechFailureCategory = typeof SpeechFailureCategory.Type;

export const SpeechFailureResponse = Schema.Struct({
  error: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000)),
  category: SpeechFailureCategory,
  retryAfterMs: Schema.optional(Schema.Int.pipe(Schema.positive())),
  settingsTarget: Schema.optional(SettingsDeepLink),
}).annotations(strict);
export type SpeechFailureResponse = typeof SpeechFailureResponse.Type;

export const decodeSpeechAudioMediaType = Schema.decodeUnknownSync(SpeechAudioMediaType);
export const decodeSpeechSynthesisFormat = Schema.decodeUnknownSync(SpeechSynthesisFormat);
export const decodeSpeechEndpointRef = Schema.decodeUnknownSync(SpeechEndpointRef);
export const decodeSpeechSynthesisEndpointRef = Schema.decodeUnknownSync(
  SpeechSynthesisEndpointRef,
);
export const decodeVoiceSettings = Schema.decodeUnknownSync(VoiceSettings);
export const decodeSpeechTranscriptionLanguage = Schema.decodeUnknownSync(
  SpeechTranscriptionLanguage,
);
export const decodeSpeechTranscript = Schema.decodeUnknownSync(SpeechTranscript);
export const decodeSpeechSynthesisRequest = Schema.decodeUnknownSync(SpeechSynthesisRequest);
export const decodeSpeechCapabilityStatus = Schema.decodeUnknownSync(SpeechCapabilityStatus);
export const decodeSpeechStatusResponse = Schema.decodeUnknownSync(SpeechStatusResponse);
export const decodeSpeechFailureResponse = Schema.decodeUnknownSync(SpeechFailureResponse);

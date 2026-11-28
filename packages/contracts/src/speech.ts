import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProviderFailureCategory, ProviderInstanceId, ProviderModelId } from "./providers";
import { SettingsDeepLink } from "./settings";

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
export const SpeechAudioMediaType = Schema.Literals(SPEECH_AUDIO_MEDIA_TYPES);
export type SpeechAudioMediaType = typeof SpeechAudioMediaType.Type;

export const SPEECH_SYNTHESIS_FORMATS = ["mp3", "wav", "opus"] as const;
export const SpeechSynthesisFormat = Schema.Literals(SPEECH_SYNTHESIS_FORMATS);
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
});
export type SpeechEndpointRef = typeof SpeechEndpointRef.Type;

export const SpeechSynthesisVoice = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
);
export type SpeechSynthesisVoice = typeof SpeechSynthesisVoice.Type;

export const SpeechSynthesisEndpointRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  voice: SpeechSynthesisVoice,
});
export type SpeechSynthesisEndpointRef = typeof SpeechSynthesisEndpointRef.Type;

/** BCP-47-shaped hint the caller may pass to transcription. */
export const SpeechTranscriptionLanguage = Schema.String.check(
  Schema.isPattern(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
);
export type SpeechTranscriptionLanguage = typeof SpeechTranscriptionLanguage.Type;

/** How many dictionary terms Voice keeps; the provider sees as many as fit its prompt. */
export const MAX_VOICE_DICTIONARY_TERMS = 100;

/** One name or term transcription should spell the person's way. */
export const VoiceDictionaryTerm = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
);
export type VoiceDictionaryTerm = typeof VoiceDictionaryTerm.Type;

/** Speech to text that runs on the host itself, with no endpoint. */
export const SpeechLocalEngine = Schema.Literal("apple-speech");
export type SpeechLocalEngine = typeof SpeechLocalEngine.Type;

/**
 * Voice settings section.
 *
 * `transcriptionEngine` names an engine on the host itself. While it is set
 * the host transcribes nothing through an endpoint, for anyone: `transcription`
 * is kept for the person to go back to and is not used. Absent, as it is for
 * everyone who set dictation up before it existed, means `transcription`.
 *
 * `transcription` is the endpoint that turns speech into text. Absent means
 * the host reports transcription `unconfigured` and every voice control that
 * needs it stays hidden — never a silent fallback to a chat model.
 *
 * `synthesis` is the endpoint that turns text into speech. Absent means no
 * host call is made; a renderer may still read text aloud with the operating
 * system's own voices, which is a renderer-local choice the host never sees.
 *
 * `language` and `dictionary` shape every transcription the host makes —
 * dictation, a paired phone's clips, and the agent's transcription tool — so
 * they live here rather than in any one client.
 */
export const VoiceSettings = Schema.Struct({
  transcriptionEngine: Schema.optional(SpeechLocalEngine),
  transcription: Schema.optional(SpeechEndpointRef),
  synthesis: Schema.optional(SpeechSynthesisEndpointRef),
  /** The language dictation assumes when a request names none; absent lets the model detect it. */
  language: Schema.optional(SpeechTranscriptionLanguage),
  /** Names and terms transcription should spell this way, in the order they were added. */
  dictionary: Schema.optional(
    Schema.Array(VoiceDictionaryTerm).check(Schema.isMaxLength(MAX_VOICE_DICTIONARY_TERMS)),
  ),
});
export type VoiceSettings = typeof VoiceSettings.Type;

/**
 * What transcription returns. Empty text is a legitimate answer for a silent
 * clip, so the field is not required to be non-empty; the caller decides.
 */
export const SpeechTranscript = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(SPEECH_TRANSCRIPT_MAX_CHARACTERS)),
});
export type SpeechTranscript = typeof SpeechTranscript.Type;

export const SpeechSynthesisRequest = Schema.Struct({
  text: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS),
  ),
  format: Schema.optional(SpeechSynthesisFormat),
});
export type SpeechSynthesisRequest = typeof SpeechSynthesisRequest.Type;

/**
 * Honest readiness of one speech direction. `ready` names the endpoint the
 * host would call, or the engine that runs on the host itself. `unconfigured` means Settings holds nothing for it, and
 * `unavailable` means Settings names an endpoint the host cannot use right
 * now (removed, disabled, or not an OpenAI-compatible instance). Both carry
 * the exact Settings destination that fixes it.
 */
export const SpeechCapabilityStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    voice: Schema.optional(SpeechSynthesisVoice),
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    engine: SpeechLocalEngine,
  }),
  Schema.Struct({
    status: Schema.Literal("unconfigured"),
    settingsTarget: SettingsDeepLink,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
    settingsTarget: SettingsDeepLink,
  }),
]);
export type SpeechCapabilityStatus = typeof SpeechCapabilityStatus.Type;

export const SpeechStatusResponse = Schema.Struct({
  transcription: SpeechCapabilityStatus,
  synthesis: SpeechCapabilityStatus,
});
export type SpeechStatusResponse = typeof SpeechStatusResponse.Type;

/**
 * The one shape of clip the on-device engine takes: a WAV file of 16 kHz mono
 * 16-bit PCM behind a plain 44-byte header. The window that recorded the clip
 * decodes it, so no compressed container reaches native code.
 */
export const SPEECH_LOCAL_SAMPLE_RATE = 16_000;
export const SPEECH_LOCAL_WAV_HEADER_BYTES = 44;
/** Two minutes, the longest dictation a window records, and ten seconds' slack. */
export const SPEECH_LOCAL_MAX_PCM_BYTES = 130 * SPEECH_LOCAL_SAMPLE_RATE * 2;

/**
 * Whether the on-device engine can transcribe in the language Voice settings
 * name. The speech model is the operating system's own; it is fetched only
 * when the person asks, and `language` is the one it would be fetched for.
 */
export const SpeechLocalEngineStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
  Schema.Struct({ status: Schema.Literal("unsupported-language") }),
  Schema.Struct({
    status: Schema.Literals(["ready", "not-downloaded", "download-failed"]),
    language: SpeechTranscriptionLanguage,
  }),
  Schema.Struct({
    status: Schema.Literal("downloading"),
    language: SpeechTranscriptionLanguage,
    fraction: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  Schema.Struct({ status: Schema.Literal("failed") }),
]);
export type SpeechLocalEngineStatus = typeof SpeechLocalEngineStatus.Type;

/**
 * A refused or failed speech request. `unconfigured` and `invalid` are the
 * host's own refusals; every other category is the provider failure the
 * adapter classified, sanitized so no upstream body reaches a renderer.
 */
export const SpeechFailureCategory = Schema.Union([
  Schema.Literals(["unconfigured", "invalid"]),
  ProviderFailureCategory,
]);
export type SpeechFailureCategory = typeof SpeechFailureCategory.Type;

export const SpeechFailureResponse = Schema.Struct({
  error: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  category: SpeechFailureCategory,
  retryAfterMs: Schema.optional(PositiveInt),
  settingsTarget: Schema.optional(SettingsDeepLink),
});
export type SpeechFailureResponse = typeof SpeechFailureResponse.Type;

export const decodeSpeechAudioMediaType = Schema.decodeUnknownSync(
  SpeechAudioMediaType,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechSynthesisFormat = Schema.decodeUnknownSync(
  SpeechSynthesisFormat,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechEndpointRef = Schema.decodeUnknownSync(
  SpeechEndpointRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechSynthesisEndpointRef = Schema.decodeUnknownSync(
  SpeechSynthesisEndpointRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeVoiceSettings = Schema.decodeUnknownSync(VoiceSettings, STRICT_DECODE_OPTIONS);
export const decodeSpeechTranscriptionLanguage = Schema.decodeUnknownSync(
  SpeechTranscriptionLanguage,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechTranscript = Schema.decodeUnknownSync(
  SpeechTranscript,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechSynthesisRequest = Schema.decodeUnknownSync(
  SpeechSynthesisRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechCapabilityStatus = Schema.decodeUnknownSync(
  SpeechCapabilityStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechStatusResponse = Schema.decodeUnknownSync(
  SpeechStatusResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechLocalEngineStatus = Schema.decodeUnknownSync(
  SpeechLocalEngineStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeSpeechFailureResponse = Schema.decodeUnknownSync(
  SpeechFailureResponse,
  STRICT_DECODE_OPTIONS,
);

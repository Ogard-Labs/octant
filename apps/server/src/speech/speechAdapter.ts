import {
  SPEECH_SYNTHESIS_FORMAT_MEDIA_TYPES,
  SPEECH_SYNTHESIS_MAX_AUDIO_BYTES,
  SPEECH_TRANSCRIPT_MAX_CHARACTERS,
  SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type OpenAiCompatibleProviderInstance,
  type ProviderFailure,
  type ProviderModelId,
  type SpeechAudioMediaType,
  type SpeechSynthesisFormat,
  type SpeechSynthesisVoice,
} from "@octant/contracts";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import {
  cancelResponseBody,
  classifyCompatibleHttpFailure,
  isProviderFailure,
  makeOpenAiCompatibleEndpoint,
  performCompatibleRequest,
  sanitizeCompatibleFailure,
  type CompatibleFetch,
  type CompatibleHttpLimits,
} from "../providers/openAiCompatibleEndpoint";

export type SpeechTranscriptionResult =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure };

export type SpeechSynthesisResult =
  | { readonly status: "completed"; readonly bytes: Uint8Array; readonly mediaType: string }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure };

export interface SpeechTranscriptionRequest {
  readonly audio: Uint8Array;
  readonly mediaType: SpeechAudioMediaType;
  readonly modelId: ProviderModelId;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

export interface SpeechSynthesisRequestInput {
  readonly text: string;
  readonly modelId: ProviderModelId;
  readonly voice: SpeechSynthesisVoice;
  readonly format: SpeechSynthesisFormat;
  readonly signal?: AbortSignal;
}

export interface SpeechAdapter {
  transcribe(request: SpeechTranscriptionRequest): Promise<SpeechTranscriptionResult>;
  synthesize(request: SpeechSynthesisRequestInput): Promise<SpeechSynthesisResult>;
}

export interface SpeechAdapterOptions {
  readonly instance: OpenAiCompatibleProviderInstance;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: CompatibleFetch;
  readonly limits?: Partial<CompatibleHttpLimits>;
}

// A 10 MB clip can take a while to transcribe; the chat default of ten
// seconds would fail healthy requests. Synthesis returns bytes, not a stream
// of events, so its response bound is the audio ceiling plus header slack.
const TRANSCRIPTION_LIMITS: CompatibleHttpLimits = {
  connectionTimeoutMs: 120_000,
  requestBodyBytes: SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES + 65_536,
  responseBodyBytes: 1_048_576,
  streamIdleTimeoutMs: 30_000,
};
const SYNTHESIS_LIMITS: CompatibleHttpLimits = {
  connectionTimeoutMs: 120_000,
  requestBodyBytes: 65_536,
  responseBodyBytes: SPEECH_SYNTHESIS_MAX_AUDIO_BYTES + 65_536,
  streamIdleTimeoutMs: 30_000,
};

// Mistral answers JSON carrying the audio as base64, which is 4/3 the size of
// the audio itself, so the raw response must be allowed to be that much larger
// than the decoded ceiling or valid audio near the limit is cut off early.
const BASE64_ENCODED_SYNTHESIS_LIMITS: CompatibleHttpLimits = {
  ...SYNTHESIS_LIMITS,
  responseBodyBytes: Math.ceil((SPEECH_SYNTHESIS_MAX_AUDIO_BYTES * 4) / 3) + 65_536,
};

const AUDIO_FILE_EXTENSIONS: Readonly<Record<SpeechAudioMediaType, string>> = {
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/flac": "flac",
};

/**
 * Speech over an OpenAI-compatible HTTP instance. The instance's own base URL,
 * credential, and endpoint policy are reused unchanged; this adapter only adds
 * the two `/audio/*` paths and refuses to accept anything but text from
 * transcription or bytes from synthesis.
 */
export function makeOpenAiCompatibleSpeechAdapter(options: SpeechAdapterOptions): SpeechAdapter {
  const endpoint = (limits: CompatibleHttpLimits) =>
    makeOpenAiCompatibleEndpoint({
      instanceId: String(options.instance.id),
      configuration: options.instance.configuration,
      ...(options.credentialResolver === undefined
        ? {}
        : { credentialResolver: options.credentialResolver }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      limits: { ...limits, ...options.limits },
    });

  return {
    transcribe: async (request) => {
      try {
        const form = new FormData();
        form.set("model", String(request.modelId));
        form.set("response_format", "json");
        if (request.language !== undefined) form.set("language", request.language);
        form.set(
          "file",
          new Blob([Uint8Array.from(request.audio)], { type: request.mediaType }),
          `recording.${AUDIO_FILE_EXTENSIONS[request.mediaType]}`,
        );
        const response = await performCompatibleRequest(
          endpoint(TRANSCRIPTION_LIMITS),
          "audio/transcriptions",
          {
            method: "POST",
            body: form,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
        if (!response.ok) {
          const failure = classifyCompatibleHttpFailure(response);
          await cancelResponseBody(response);
          return { status: "failed", providerFailure: failure };
        }
        const text = readTranscriptText(await readJson(response));
        if (text === undefined) {
          return {
            status: "failed",
            providerFailure: {
              category: "protocol",
              message: "The provider returned an invalid transcription response.",
            },
          };
        }
        return { status: "completed", text };
      } catch (error) {
        return { status: "failed", providerFailure: sanitizeCompatibleFailure(error) };
      }
    },

    synthesize: async (request) => {
      try {
        // Mistral's speech route takes the same model, input and
        // response_format as OpenAI's but names the voice `voice_id` and
        // answers JSON with the audio as base64 `audio_data` (its OpenAPI
        // description, read 2026-10-20), so that host gets its own body and
        // its own reading of the reply.
        const mistral = isMistralHost(options.instance.configuration.baseUrl);
        const response = await performCompatibleRequest(
          endpoint(mistral ? BASE64_ENCODED_SYNTHESIS_LIMITS : SYNTHESIS_LIMITS),
          "audio/speech",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: String(request.modelId),
              input: request.text,
              ...(mistral ? { voice_id: request.voice } : { voice: request.voice }),
              response_format: request.format,
            }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
        if (!response.ok) {
          const failure = classifyCompatibleHttpFailure(response);
          await cancelResponseBody(response);
          return { status: "failed", providerFailure: failure };
        }
        const bytes = mistral
          ? decodeAudioData(await readJson(response))
          : new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > SPEECH_SYNTHESIS_MAX_AUDIO_BYTES) {
          return {
            status: "failed",
            providerFailure: {
              category: "protocol",
              message:
                bytes.byteLength === 0
                  ? "The provider returned no audio."
                  : "The provider response exceeded the configured size limit.",
            },
          };
        }
        return {
          status: "completed",
          bytes,
          // The requested format decides what the caller may play; a provider
          // header is only trusted when it agrees it is audio at all.
          mediaType: audioMediaType(
            response.headers.get("content-type"),
            SPEECH_SYNTHESIS_FORMAT_MEDIA_TYPES[request.format],
          ),
        };
      } catch (error) {
        return { status: "failed", providerFailure: sanitizeCompatibleFailure(error) };
      }
    },
  };
}

function isMistralHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.mistral.ai";
  } catch {
    return false;
  }
}

/** Mistral's reply: `{ audio_data: "<base64>" }`; anything else is no audio. */
function decodeAudioData(payload: unknown): Uint8Array {
  if (typeof payload !== "object" || payload === null) return new Uint8Array(0);
  const encoded = (payload as { readonly audio_data?: unknown }).audio_data;
  if (typeof encoded !== "string" || encoded.length === 0) return new Uint8Array(0);
  // Buffer.from skips anything outside the alphabet, so a damaged reply would
  // decode to garbage audio instead of failing; check the shape first.
  const compact = encoded.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) return new Uint8Array(0);
  return new Uint8Array(Buffer.from(compact, "base64"));
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function readTranscriptText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const text = (payload as { readonly text?: unknown }).text;
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return trimmed.length > SPEECH_TRANSCRIPT_MAX_CHARACTERS
    ? trimmed.slice(0, SPEECH_TRANSCRIPT_MAX_CHARACTERS)
    : trimmed;
}

function audioMediaType(header: string | null, requested: string): string {
  if (header === null) return requested;
  const declared = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return declared.startsWith("audio/") ? declared : requested;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    return undefined;
  }
}

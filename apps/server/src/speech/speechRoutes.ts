import {
  decodeSpeechFailureResponse,
  decodeSpeechStatusResponse,
  decodeSpeechSynthesisRequest,
  decodeSpeechTranscript,
  decodeSpeechTranscriptionLanguage,
  SPEECH_HOST_CONCURRENCY,
  SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type ProviderFailure,
  type ProviderInstance,
  type SettingsDeepLink,
  type SpeechEndpointRef,
  type SpeechFailureResponse,
  type SpeechSynthesisEndpointRef,
  type VoiceSettings,
} from "@octant/contracts";
import {
  resolveSpeechEndpoint,
  speechStatusOf,
  VOICE_SYNTHESIS_TARGET,
  VOICE_TRANSCRIPTION_TARGET,
  type SpeechEndpointResolution,
} from "@octant/domain";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import type { CompatibleFetch } from "../providers/openAiCompatibleEndpoint";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { makeOpenAiCompatibleSpeechAdapter, type SpeechAdapter } from "./speechAdapter";
import { sniffSpeechAudioMediaType } from "./speechAudio";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const STATUS_PATH = "/api/speech/status";
const TRANSCRIPTIONS_PATH = "/api/speech/transcriptions";
const SYNTHESIS_PATH = "/api/speech/synthesis";
// Multipart framing around a maximal clip: boundaries, part headers, model
// and language fields. Anything beyond this is refused before it is buffered.
const TRANSCRIPTION_BODY_LIMIT = SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES + 65_536;
const SYNTHESIS_BODY_LIMIT = 65_536;

export interface SpeechRouteDependencies {
  readonly readVoiceSettings: () => VoiceSettings;
  readonly listInstances: () => ReadonlyArray<ProviderInstance>;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: CompatibleFetch;
  /** Test seam: replace the adapter the route would build for a ready endpoint. */
  readonly makeAdapter?: (
    resolution: SpeechEndpointResolution & { status: "ready" },
  ) => SpeechAdapter;
  readonly now?: () => number;
}

/**
 * The host's voice surface: honest status, speech to text, and text to speech.
 *
 * Every request needs a live window capability; the endpoint each direction
 * uses is resolved from Voice settings against the registry on every call, so
 * a removed or disabled instance refuses with the Settings link that fixes it
 * rather than falling back to another instance. Audio bytes and transcripts
 * pass through and are never journaled or stored: the caller decides what to
 * do with a transcript, and a composer that receives one still needs the
 * person to send it.
 */
export function createSpeechRouteHandler(dependencies: SpeechRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const gates = {
    transcription: new AdmissionGate(SPEECH_HOST_CONCURRENCY),
    synthesis: new AdmissionGate(SPEECH_HOST_CONCURRENCY),
  };
  const adapterFor =
    dependencies.makeAdapter ??
    ((resolution) =>
      makeOpenAiCompatibleSpeechAdapter({
        instance: resolution.instance,
        ...(dependencies.credentialResolver === undefined
          ? {}
          : { credentialResolver: dependencies.credentialResolver }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      }));

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/speech/")) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return refuse("Speech API requests must use loopback.", "invalid", 400, origin);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return refuse("Renderer origin is not allowed.", "invalid", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return refuse("Speech request is unauthorized.", "invalid", 401, origin);
      }
      return refuse("Speech request is invalid.", "invalid", 400, origin);
    }

    if (url.pathname === STATUS_PATH && request.method === "GET") {
      return json(
        decodeSpeechStatusResponse(
          speechStatusOf(dependencies.readVoiceSettings(), dependencies.listInstances()),
        ),
        200,
        origin,
      );
    }

    if (url.pathname === TRANSCRIPTIONS_PATH && request.method === "POST") {
      return transcribe(request, origin);
    }

    if (url.pathname === SYNTHESIS_PATH && request.method === "POST") {
      return synthesize(request, origin);
    }

    return refuse("Speech request is invalid.", "invalid", 405, origin);
  };

  async function transcribe(request: Request, origin: string | null): Promise<Response> {
    const resolution = resolve(dependencies.readVoiceSettings().transcription);
    if (resolution.status !== "ready") {
      return refuseEndpoint(resolution, VOICE_TRANSCRIPTION_TARGET, origin);
    }
    if (exceedsDeclaredLength(request, TRANSCRIPTION_BODY_LIMIT)) {
      return refuse("The recording is larger than 10 MB.", "invalid", 413, origin);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return refuse("Speech request must be multipart form data.", "invalid", 400, origin);
    }
    const audioPart = form.get("audio");
    if (!isBlob(audioPart)) {
      return refuse("Speech request must carry an audio part.", "invalid", 400, origin);
    }
    if (audioPart.size === 0) {
      return refuse("The recording is empty.", "invalid", 400, origin);
    }
    if (audioPart.size > SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      return refuse("The recording is larger than 10 MB.", "invalid", 413, origin);
    }
    const audio = new Uint8Array(await audioPart.arrayBuffer());
    const mediaType = sniffSpeechAudioMediaType(audio);
    if (mediaType === undefined) {
      return refuse("The recording is not a supported audio format.", "invalid", 400, origin);
    }
    let language: string | undefined;
    const languagePart = form.get("language");
    if (typeof languagePart === "string" && languagePart.length > 0) {
      try {
        language = decodeSpeechTranscriptionLanguage(languagePart);
      } catch {
        return refuse("The language hint is not a language tag.", "invalid", 400, origin);
      }
    }

    const release = gates.transcription.tryAcquire();
    if (release === null) return busy(origin);
    try {
      const result = await adapterFor(resolution).transcribe({
        audio,
        mediaType,
        modelId: resolution.modelId,
        ...(language === undefined ? {} : { language }),
        signal: request.signal,
      });
      if (result.status === "failed") {
        return providerFailure(result.providerFailure, origin);
      }
      return json(decodeSpeechTranscript({ text: result.text }), 200, origin);
    } finally {
      release();
    }
  }

  async function synthesize(request: Request, origin: string | null): Promise<Response> {
    const resolution = resolve(dependencies.readVoiceSettings().synthesis);
    if (resolution.status !== "ready") {
      return refuseEndpoint(resolution, VOICE_SYNTHESIS_TARGET, origin);
    }
    if (resolution.voice === undefined) {
      return refuseEndpoint(
        { status: "unavailable", reason: "The chosen voice is missing." },
        VOICE_SYNTHESIS_TARGET,
        origin,
      );
    }
    const decoded = await readJson(request, SYNTHESIS_BODY_LIMIT);
    if (decoded.kind === "too-large") {
      return refuse("Request body is too large.", "invalid", 413, origin);
    }
    if (decoded.kind === "invalid") {
      return refuse("Request body must be valid JSON.", "invalid", 400, origin);
    }
    let body;
    try {
      body = decodeSpeechSynthesisRequest(decoded.value);
    } catch {
      return refuse("Speech synthesis request is invalid.", "invalid", 400, origin);
    }

    const release = gates.synthesis.tryAcquire();
    if (release === null) return busy(origin);
    try {
      const result = await adapterFor(resolution).synthesize({
        text: body.text,
        modelId: resolution.modelId,
        voice: resolution.voice,
        format: body.format ?? "mp3",
        signal: request.signal,
      });
      if (result.status === "failed") {
        return providerFailure(result.providerFailure, origin);
      }
      return new Response(Uint8Array.from(result.bytes), {
        status: 200,
        headers: {
          ...corsHeaders(origin),
          "content-type": result.mediaType,
          "cache-control": "private, max-age=0, no-store",
        },
      });
    } finally {
      release();
    }
  }

  function resolve(
    ref: SpeechEndpointRef | SpeechSynthesisEndpointRef | undefined,
  ): SpeechEndpointResolution {
    return resolveSpeechEndpoint(ref, dependencies.listInstances());
  }
}

/**
 * Bounds concurrent voice calls per direction before any body is buffered.
 * The overflow is refused, not queued: a person speaking into a composer
 * would rather retry than wait behind an unknown number of other clips.
 */
class AdmissionGate {
  #active = 0;
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  tryAcquire(): (() => void) | null {
    if (this.#active >= this.#capacity) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}

function refuseEndpoint(
  resolution: Exclude<SpeechEndpointResolution, { status: "ready" }>,
  settingsTarget: SettingsDeepLink,
  origin: string | null,
): Response {
  const direction = settingsTarget.setting === "synthesis" ? "Text to speech" : "Transcription";
  return json(
    decodeSpeechFailureResponse({
      error:
        resolution.status === "unconfigured"
          ? `${direction} is not configured.`
          : `${direction} is unavailable: ${resolution.reason}`,
      category: "unconfigured",
      settingsTarget,
    } satisfies SpeechFailureResponse),
    412,
    origin,
  );
}

function providerFailure(failure: ProviderFailure, origin: string | null): Response {
  const status =
    failure.category === "rate-limited"
      ? 429
      : failure.category === "interrupted"
        ? 499
        : failure.category === "unauthenticated" || failure.category === "unauthorized"
          ? 401
          : failure.category === "unsupported"
            ? 501
            : 502;
  return json(
    decodeSpeechFailureResponse({
      error: failure.message,
      category: failure.category,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    } satisfies SpeechFailureResponse),
    status,
    origin,
  );
}

function busy(origin: string | null): Response {
  return refuse(
    "Too many voice requests are already in progress. Try again shortly.",
    "unavailable",
    503,
    origin,
  );
}

function refuse(
  message: string,
  category: SpeechFailureResponse["category"],
  status: number,
  origin: string | null,
): Response {
  return json(
    decodeSpeechFailureResponse({ error: message, category } satisfies SpeechFailureResponse),
    status,
    origin,
  );
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname === "127.0.0.1" || url.hostname === "localhost"
      : false;
  } catch {
    return false;
  }
}

function exceedsDeclaredLength(request: Request, limit: number): boolean {
  const header = request.headers.get("content-length");
  if (header === null) return false;
  const length = Number(header);
  return Number.isFinite(length) && length > limit;
}

function isBlob(value: unknown): value is Blob {
  return typeof value === "object" && value !== null && "arrayBuffer" in value && "size" in value;
}

async function readJson(
  request: Request,
  limit: number,
): Promise<
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" }
> {
  if (exceedsDeclaredLength(request, limit)) return { kind: "too-large" };
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > limit) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(buffer)) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

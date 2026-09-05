import {
  decodeSpeechFailureResponse,
  decodeSpeechStatusResponse,
  decodeSpeechTranscript,
  type SettingsDeepLink,
  type SpeechFailureCategory,
  type SpeechStatusResponse,
  type SpeechSynthesisFormat,
  type SpeechTranscript,
} from "@octant/contracts";

export interface SpeechClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface SpeechSynthesisAudio {
  readonly bytes: Blob;
  readonly mediaType: string;
}

export interface SpeechClient {
  status(): Promise<SpeechStatusResponse>;
  transcribe(input: {
    readonly audio: Blob;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }): Promise<SpeechTranscript>;
  synthesize(input: {
    readonly text: string;
    readonly format?: SpeechSynthesisFormat;
    readonly signal?: AbortSignal;
  }): Promise<SpeechSynthesisAudio>;
}

/**
 * A speech request the host refused or could not complete. `settingsTarget`
 * is present exactly when Settings can fix it, so a surface can offer the
 * destination instead of a dead end.
 */
export class SpeechClientFailure extends Error {
  readonly status: number;
  readonly category: SpeechFailureCategory;
  readonly retryAfterMs: number | undefined;
  readonly settingsTarget: SettingsDeepLink | undefined;

  constructor(input: {
    readonly message: string;
    readonly status: number;
    readonly category: SpeechFailureCategory;
    readonly retryAfterMs?: number;
    readonly settingsTarget?: SettingsDeepLink;
  }) {
    super(input.message);
    this.name = "SpeechClientFailure";
    this.status = input.status;
    this.category = input.category;
    this.retryAfterMs = input.retryAfterMs;
    this.settingsTarget = input.settingsTarget;
  }
}

export function createSpeechClient(options: SpeechClientOptions): SpeechClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    async status() {
      const response = await send(options, "/api/speech/status", { method: "GET", headers });
      return decodeOrFail(response, decodeSpeechStatusResponse, undefined);
    },
    async transcribe(input) {
      const form = new FormData();
      form.set("audio", input.audio, "recording");
      if (input.language !== undefined) form.set("language", input.language);
      const response = await send(options, "/api/speech/transcriptions", {
        method: "POST",
        headers,
        body: form,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return decodeOrFail(response, decodeSpeechTranscript, input.signal);
    },
    async synthesize(input) {
      const response = await send(options, "/api/speech/synthesis", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          text: input.text,
          ...(input.format === undefined ? {} : { format: input.format }),
        }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!response.ok) throw await failureOf(response, input.signal);
      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!mediaType.startsWith("audio/")) {
        throw new SpeechClientFailure({
          message: "Speech synthesis returned something that is not audio.",
          status: response.status,
          category: "protocol",
        });
      }
      let bytes: Blob;
      try {
        bytes = await response.blob();
      } catch {
        throw (
          cancelled(input.signal) ??
          new SpeechClientFailure({
            message: "Voice returned an invalid response.",
            status: response.status,
            category: "protocol",
          })
        );
      }
      return { bytes, mediaType };
    },
  };
}

async function send(options: SpeechClientOptions, path: string, init: RequestInit) {
  try {
    return await options.fetch(new URL(path, options.baseUrl).toString(), init);
  } catch {
    if (init.signal?.aborted === true) {
      throw new SpeechClientFailure({
        message: "The voice request was cancelled.",
        status: 0,
        category: "interrupted",
      });
    }
    throw new SpeechClientFailure({
      message: "Voice is unavailable.",
      status: 0,
      category: "unavailable",
    });
  }
}

/**
 * An abort that lands after the response headers surfaces from the body read
 * rather than from `fetch`, so every body path has to name it a cancellation
 * instead of a protocol or provider fault.
 */
function cancelled(signal: AbortSignal | undefined): SpeechClientFailure | undefined {
  if (signal?.aborted !== true) return undefined;
  return new SpeechClientFailure({
    message: "The voice request was cancelled.",
    status: 0,
    category: "interrupted",
  });
}

async function decodeOrFail<T>(
  response: Response,
  decode: (value: unknown) => T,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!response.ok) throw await failureOf(response, signal);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw (
      cancelled(signal) ??
      new SpeechClientFailure({
        message: "Voice returned an invalid response.",
        status: response.status,
        category: "protocol",
      })
    );
  }
  try {
    return decode(body);
  } catch {
    throw new SpeechClientFailure({
      message: "Voice response did not match the contract.",
      status: response.status,
      category: "protocol",
    });
  }
}

async function failureOf(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<SpeechClientFailure> {
  try {
    const failure = decodeSpeechFailureResponse(await response.json());
    return new SpeechClientFailure({
      message: failure.error,
      status: response.status,
      category: failure.category,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      ...(failure.settingsTarget === undefined ? {} : { settingsTarget: failure.settingsTarget }),
    });
  } catch {
    return (
      cancelled(signal) ??
      new SpeechClientFailure({
        message: "Voice request failed.",
        status: response.status,
        category: "provider-failed",
      })
    );
  }
}

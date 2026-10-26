import {
  decodeHostAnswer,
  type SpeechFailureCategory,
  SpeechFailureResponse,
  SpeechStatusResponse,
  SpeechTranscript,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const STATUS_PATH = "/api/speech/status";
const TRANSCRIPTIONS_PATH = "/api/speech/transcriptions";

export type MobileTranscriptionReadiness = "ready" | "unconfigured" | "unavailable";

/**
 * Whether the paired computer will transcribe a clip from this phone right
 * now. Anything but the host's own `ready` reads as not ready, so the phone
 * never offers a microphone the host would refuse.
 */
export async function readMobileTranscriptionReadiness(input: {
  readonly transport: MobileRemoteTransport;
  readonly signal?: AbortSignal;
}): Promise<MobileTranscriptionReadiness> {
  try {
    const response = await input.transport.authenticatedFetch({
      method: "GET",
      path: STATUS_PATH,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!response.ok) return "unavailable";
    const status = decodeHostAnswer(SpeechStatusResponse)(await response.json());
    return status.transcription.status;
  } catch {
    return "unavailable";
  }
}

export type MobileTranscriptionResult =
  | { readonly status: "transcribed"; readonly text: string }
  | {
      readonly status: "refused";
      readonly category: SpeechFailureCategory;
      readonly message: string;
      readonly retryAfterMs?: number;
    };

/**
 * Sends one recorded clip to the paired computer's Voice endpoint and returns
 * the text. The clip goes as the same multipart upload the desktop sends, so
 * the host applies one set of sniffing and bounds to both. The caller owns the
 * audio and discards it whatever this returns.
 */
export async function transcribeMobileClip(input: {
  readonly transport: MobileRemoteTransport;
  readonly audio: Uint8Array;
  readonly mediaType: string;
  readonly signal?: AbortSignal;
}): Promise<MobileTranscriptionResult> {
  const boundary = `octant-voice-${globalThis.crypto.randomUUID()}`;
  let response: Response;
  try {
    response = await input.transport.authenticatedFetch({
      method: "POST",
      path: TRANSCRIPTIONS_PATH,
      body: multipartClip(boundary, input.audio, input.mediaType),
      contentType: `multipart/form-data; boundary=${boundary}`,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return {
      status: "refused",
      category: input.signal?.aborted === true ? "interrupted" : "unavailable",
      message: "Could not reach the computer to transcribe the recording.",
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.ok) {
    try {
      return { status: "transcribed", text: decodeHostAnswer(SpeechTranscript)(body).text };
    } catch {
      return {
        status: "refused",
        category: "protocol",
        message: "The computer returned a transcript this app cannot read.",
      };
    }
  }
  try {
    const failure = decodeHostAnswer(SpeechFailureResponse)(body);
    return {
      status: "refused",
      category: failure.category,
      message: failure.error,
      ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    };
  } catch {
    return {
      status: "refused",
      category: "unavailable",
      message: "The computer did not transcribe the recording.",
    };
  }
}

function multipartClip(boundary: string, audio: Uint8Array, mediaType: string): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="recording"\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + audio.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(audio, head.byteLength);
  body.set(tail, head.byteLength + audio.byteLength);
  return body;
}

import { SpeechClientFailure, type SpeechClient } from "@octant/client-runtime/speech-client";
import type { ProviderInstance, VoiceSettings } from "@octant/contracts";
import { vi } from "vitest";

export const SPEECH_TEST_INSTANCE_ID = "00000000-0000-4000-8000-00000000c001";
const now = "2026-09-05T10:00:00.000Z";

/** One enabled OpenAI-compatible instance, the only kind voice resolves against. */
export function speechTestInstances(): ReadonlyArray<ProviderInstance> {
  return [
    {
      id: SPEECH_TEST_INSTANCE_ID as never,
      displayName: "OpenAI",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as never,
      createdAt: now as never,
      updatedAt: now as never,
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://api.openai.com/v1",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: [],
      },
    },
  ];
}

export function speechTestSettings(
  directions: { readonly transcription?: boolean; readonly synthesis?: boolean } = {
    transcription: true,
  },
): VoiceSettings {
  return {
    ...(directions.transcription === true
      ? {
          transcription: {
            providerInstanceId: SPEECH_TEST_INSTANCE_ID as never,
            modelId: "whisper-1" as never,
          },
        }
      : {}),
    ...(directions.synthesis === true
      ? {
          synthesis: {
            providerInstanceId: SPEECH_TEST_INSTANCE_ID as never,
            modelId: "gpt-4o-mini-tts" as never,
            voice: "alloy" as never,
          },
        }
      : {}),
  };
}

export function fakeSpeechClient(
  behaviour: {
    readonly transcript?: string;
    readonly transcribeFailure?: SpeechClientFailure;
  } = {},
) {
  const transcribe = vi.fn(async () => {
    if (behaviour.transcribeFailure !== undefined) throw behaviour.transcribeFailure;
    return { text: behaviour.transcript ?? "hello from the microphone" };
  });
  const synthesize = vi.fn(async () => ({
    bytes: new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/mpeg" }),
    mediaType: "audio/mpeg",
  }));
  const client: SpeechClient = {
    status: async () => {
      throw new Error("status is decided locally in these tests");
    },
    transcribe: transcribe as unknown as SpeechClient["transcribe"],
    synthesize: synthesize as unknown as SpeechClient["synthesize"],
  };
  return { client, transcribe, synthesize };
}

/**
 * A MediaRecorder stand-in: `start` marks it live, `stop` hands one chunk to
 * `ondataavailable` and then fires `onstop`, the order the real API promises.
 */
export class FakeMediaRecorder {
  static instances: Array<FakeMediaRecorder> = [];
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  readonly mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly stream: MediaStream;

  constructor(stream: MediaStream) {
    this.stream = stream;
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 7])]) });
    this.onstop?.();
  }
}

/** Installs a granting microphone and the fake recorder; returns the stop spy of the track. */
export function installFakeMicrophone(options: { readonly deny?: boolean } = {}) {
  FakeMediaRecorder.instances = [];
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => {
    if (options.deny === true) {
      const error = new Error("denied");
      error.name = "NotAllowedError";
      throw error;
    }
    return stream;
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return { getUserMedia, stopTrack };
}

export function uninstallFakeMicrophone() {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
}

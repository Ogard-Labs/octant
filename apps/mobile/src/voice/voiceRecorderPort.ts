/** One clip the phone recorded, held only until the host answers. */
export interface RecordedVoiceClip {
  readonly audio: Uint8Array;
  readonly mediaType: string;
}

export type VoiceRecorderStart =
  | { readonly status: "recording" }
  | { readonly status: "denied" }
  | { readonly status: "failed" };

export type VoiceRecorderStop =
  | { readonly status: "recorded"; readonly clip: RecordedVoiceClip }
  | { readonly status: "failed" };

/**
 * The microphone, reached only on the person's explicit act. `start` asks the
 * operating system for permission the first time; `discard` stops any
 * recording and deletes what the platform wrote, and is called after every
 * clip, sent or not, so no audio stays on the phone.
 */
export interface MobileVoiceRecorderPort {
  readonly available: boolean;
  readonly start: () => Promise<VoiceRecorderStart>;
  readonly stop: () => Promise<VoiceRecorderStop>;
  readonly discard: () => Promise<void>;
}

/** A build or platform without a recorder: the microphone is never shown. */
export function createUnavailableVoiceRecorderPort(): MobileVoiceRecorderPort {
  return {
    available: false,
    async start() {
      return { status: "failed" };
    },
    async stop() {
      return { status: "failed" };
    },
    async discard() {},
  };
}

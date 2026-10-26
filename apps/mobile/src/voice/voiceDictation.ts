import type { MobileTranscriptionResult } from "@octant/client-runtime";
import { REMOTE_TRANSCRIPTION_MAX_CLIP_MS } from "@octant/domain";
import type {
  MobileVoiceRecorderPort,
  RecordedVoiceClip,
  VoiceRecorderStart,
} from "./voiceRecorderPort";

export type VoiceDictationView =
  | { readonly kind: "hidden" }
  | { readonly kind: "idle" }
  | { readonly kind: "recording" }
  | { readonly kind: "transcribing" };

export interface VoiceDictationOptions {
  readonly recorder: MobileVoiceRecorderPort;
  readonly transcribe: (clip: RecordedVoiceClip) => Promise<MobileTranscriptionResult>;
  readonly appendToDraft: (text: string) => void;
  readonly onChange: (view: VoiceDictationView, notice: string | undefined) => void;
  /** Schedules `fire` after `ms`; returns the cancel. Defaults to `setTimeout`. */
  readonly startTimer?: (ms: number, fire: () => void) => () => void;
}

const MICROPHONE_DENIED = "Allow microphone access in Settings to dictate.";

/**
 * One composer's dictation: tap to record, tap again to send the clip to the
 * paired computer, and the words land in the draft for the person to send.
 *
 * The microphone shows only while the host reports transcription ready and
 * the phone can record. A clip stops on its own at sixty seconds. Leaving the
 * foreground, or the host no longer being ready, drops the recording unsent.
 * The audio is discarded after every clip, whether the transcript came back
 * or not.
 */
export class VoiceDictation {
  readonly #options: VoiceDictationOptions;
  #ready = false;
  #phase: "idle" | "starting" | "recording" | "transcribing" = "idle";
  #notice: string | undefined;
  #cancelTimer: (() => void) | undefined;
  // Bumped by a cancel, so a microphone that finishes opening afterwards is
  // closed and discarded instead of recording in the background.
  #attempt = 0;
  #shown: { readonly kind: VoiceDictationView["kind"]; readonly notice: string | undefined } = {
    kind: "hidden",
    notice: undefined,
  };

  constructor(options: VoiceDictationOptions) {
    this.#options = options;
  }

  view(): VoiceDictationView {
    if (this.#phase === "recording") return { kind: "recording" };
    if (this.#phase === "transcribing") return { kind: "transcribing" };
    return this.#ready && this.#options.recorder.available ? { kind: "idle" } : { kind: "hidden" };
  }

  setReady(ready: boolean): void {
    this.#ready = ready;
    if (!ready && (this.#phase === "starting" || this.#phase === "recording")) {
      void this.cancel();
    }
    this.#emit();
  }

  /** The microphone control: start when idle, finish when recording. */
  async press(): Promise<void> {
    if (this.#phase === "recording") return this.#finish();
    if (this.#phase === "idle" && this.view().kind === "idle") return this.#start();
  }

  /** Drops a recording in progress without sending it. */
  async cancel(): Promise<void> {
    if (this.#phase === "starting") {
      this.#attempt += 1;
      this.#phase = "idle";
      this.#emit();
      return;
    }
    if (this.#phase !== "recording") return;
    this.#clearTimer();
    this.#phase = "idle";
    this.#emit();
    await this.#discard();
  }

  async #start(): Promise<void> {
    this.#attempt += 1;
    const attempt = this.#attempt;
    this.#phase = "starting";
    this.#notice = undefined;
    this.#emit();
    let started: VoiceRecorderStart;
    try {
      started = await this.#options.recorder.start();
    } catch {
      started = { status: "failed" };
    }
    if (attempt !== this.#attempt || this.#phase !== "starting") {
      if (started.status === "recording") await this.#discard();
      return;
    }
    if (started.status !== "recording") {
      this.#phase = "idle";
      this.#notice = started.status === "denied" ? MICROPHONE_DENIED : "Could not start recording.";
      this.#emit();
      return;
    }
    this.#phase = "recording";
    const startTimer = this.#options.startTimer ?? startTimeout;
    this.#cancelTimer = startTimer(REMOTE_TRANSCRIPTION_MAX_CLIP_MS, () => void this.#finish());
    this.#emit();
  }

  async #finish(): Promise<void> {
    if (this.#phase !== "recording") return;
    this.#clearTimer();
    this.#phase = "transcribing";
    this.#emit();
    let notice: string | undefined;
    try {
      const stopped = await this.#options.recorder.stop();
      if (stopped.status === "failed") {
        notice = "Could not finish the recording.";
      } else {
        const result = await this.#options.transcribe(stopped.clip);
        if (result.status === "refused") notice = refusalNotice(result);
        else if (result.text.trim().length === 0) notice = "Nothing was heard in the recording.";
        else this.#options.appendToDraft(result.text);
      }
    } catch {
      notice = "Could not transcribe the recording.";
    } finally {
      await this.#discard();
    }
    this.#phase = "idle";
    this.#notice = notice;
    this.#emit();
  }

  async #discard(): Promise<void> {
    try {
      await this.#options.recorder.discard();
    } catch {
      // The recorder owns its file; a failed delete is retried by its next discard.
    }
  }

  #clearTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  #emit(): void {
    const view = this.view();
    if (view.kind === this.#shown.kind && this.#notice === this.#shown.notice) return;
    this.#shown = { kind: view.kind, notice: this.#notice };
    this.#options.onChange(view, this.#notice);
  }
}

/** The draft with the transcript's words after it, one space between. */
export function appendTranscript(draft: string, transcript: string): string {
  const words = transcript.trim();
  if (words.length === 0) return draft;
  if (draft.length === 0 || /\s$/.test(draft)) return `${draft}${words}`;
  return `${draft} ${words}`;
}

/**
 * The host's refusal, with when to try again if the host said: a device over
 * its hourly allowance otherwise reads only "later" and cannot tell how long.
 */
function refusalNotice(refusal: Extract<MobileTranscriptionResult, { status: "refused" }>): string {
  if (refusal.retryAfterMs === undefined) return refusal.message;
  const minutes = Math.ceil(refusal.retryAfterMs / 60_000);
  const wait = minutes <= 1 ? "a minute" : `${minutes} minutes`;
  return `${refusal.message} You can dictate again in about ${wait}.`;
}

function startTimeout(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

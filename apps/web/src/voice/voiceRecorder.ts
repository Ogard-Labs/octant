import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A clip longer than this is stopped for the person, not by them. Two minutes
 * of speech is well inside the host's 10 MB cap at the bit rates the browser
 * encoder uses, and a dictation that runs longer has usually been forgotten.
 */
export const MAX_VOICE_RECORDING_MS = 120_000;

export type VoiceRecorderState =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting" }
  | { readonly kind: "recording"; readonly startedAt: number }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface VoiceRecording {
  readonly audio: Blob;
  readonly durationMs: number;
}

export interface VoiceRecorder {
  readonly state: VoiceRecorderState;
  readonly elapsedMs: number;
  /** Whether this browser can record at all; a surface hides its control otherwise. */
  readonly supported: boolean;
  readonly start: () => Promise<void>;
  /** Resolves to the clip, or `undefined` when nothing was recording. */
  readonly stop: () => Promise<VoiceRecording | undefined>;
  readonly cancel: () => void;
}

interface ActiveRecording {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Array<Blob>;
  readonly startedAt: number;
  readonly mimeType: string;
  settle: ((recording: VoiceRecording | undefined) => void) | undefined;
  /** One promise per recording, so a second `stop()` awaits the same clip
   * instead of releasing whatever recording has replaced this one. */
  completion: Promise<VoiceRecording | undefined> | undefined;
}

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export function isVoiceRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

/**
 * Records the microphone with the browser's own encoder. The clip is whatever
 * container the encoder produced — the host identifies it by its bytes — so
 * there is no resampling or WAV framing on the main thread.
 */
export function useVoiceRecorder(): VoiceRecorder {
  const [state, setState] = useState<VoiceRecorderState>({ kind: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const active = useRef<ActiveRecording | undefined>(undefined);
  // Two synchronous guards, because a start races the browser's permission
  // prompt: `starting` refuses a second start while the first still waits, and
  // `generation` lets a cancel disown a stream that arrives after it.
  const starting = useRef(false);
  const generation = useRef(0);
  const supported = isVoiceRecordingSupported();

  /** Releases the microphone only while this recording still owns the slot. */
  const release = useCallback((recording: ActiveRecording) => {
    if (active.current !== recording) return;
    active.current = undefined;
    for (const track of recording.stream.getTracks()) track.stop();
    setElapsedMs(0);
    setState({ kind: "idle" });
  }, []);

  const stop = useCallback(async (): Promise<VoiceRecording | undefined> => {
    const current = active.current;
    if (current === undefined) return undefined;
    current.completion ??= new Promise<VoiceRecording | undefined>((resolve) => {
      if (current.recorder.state === "inactive") {
        resolve(undefined);
        return;
      }
      current.settle = resolve;
      current.recorder.stop();
    });
    const recording = await current.completion;
    release(current);
    return recording;
  }, [release]);

  const cancel = useCallback(() => {
    // Any permission request still in flight now belongs to nobody.
    generation.current += 1;
    starting.current = false;
    const current = active.current;
    if (current !== undefined) {
      const settle = current.settle;
      current.settle = undefined;
      if (current.recorder.state !== "inactive") current.recorder.stop();
      active.current = undefined;
      for (const track of current.stream.getTracks()) track.stop();
      settle?.(undefined);
    }
    setElapsedMs(0);
    setState({ kind: "idle" });
  }, []);

  const start = useCallback(async () => {
    if (active.current !== undefined || starting.current || !supported) return;
    starting.current = true;
    const token = generation.current;
    setState({ kind: "requesting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      starting.current = false;
      if (generation.current === token) {
        setState({ kind: "unavailable", reason: describeMicrophoneFailure(error) });
      }
      return;
    }
    starting.current = false;
    if (generation.current !== token) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const mimeType = PREFERRED_MIME_TYPES.find((candidate) =>
      typeof MediaRecorder.isTypeSupported === "function"
        ? MediaRecorder.isTypeSupported(candidate)
        : true,
    );
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setState({ kind: "unavailable", reason: "This browser cannot encode a recording." });
      return;
    }
    const startedAt = Date.now();
    const recording: ActiveRecording = {
      recorder,
      stream,
      chunks: [],
      startedAt,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      settle: undefined,
      completion: undefined,
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recording.chunks.push(event.data);
    };
    recorder.onstop = () => {
      const settle = recording.settle;
      recording.settle = undefined;
      if (settle === undefined) return;
      const durationMs = Math.max(0, Date.now() - recording.startedAt);
      const audio = new Blob(recording.chunks, { type: recording.mimeType });
      settle(audio.size === 0 ? undefined : { audio, durationMs });
    };
    active.current = recording;
    recorder.start();
    setElapsedMs(0);
    setState({ kind: "recording", startedAt });
  }, [supported]);

  useEffect(() => {
    if (state.kind !== "recording") return undefined;
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - state.startedAt);
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  // Unmounting while recording releases the microphone; nothing is transcribed
  // for a surface that is no longer there to receive it.
  useEffect(() => cancel, [cancel]);

  return { state, elapsedMs, supported, start, stop, cancel };
}

export function formatRecordingDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function describeMicrophoneFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was not allowed.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found.";
    case "NotReadableError":
      return "The microphone is in use by another application.";
    default:
      return "The microphone could not be started.";
  }
}

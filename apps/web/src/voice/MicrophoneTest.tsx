import { SpeechClientFailure } from "@octant/client-runtime/speech-client";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { Mic, Square } from "../ui/icons";
import { useSpeechCapability } from "./SpeechCapabilityContext";
import { formatRecordingDuration, useVoiceRecorder, type VoiceRecording } from "./voiceRecorder";

/** Long enough to say a sentence, short enough that a test is never a dictation. */
export const MICROPHONE_TEST_MS = 10_000;

type Transcription =
  | { readonly kind: "none" }
  | { readonly kind: "transcribing" }
  | { readonly kind: "heard"; readonly text: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Records a short clip and plays it back in this window, so a person can hear
 * which microphone Octant gets before dictating. Nothing leaves the computer
 * until they press Transcribe it, which sends the clip through the same host
 * route the composer's microphone uses.
 */
export function MicrophoneTest() {
  const speech = useSpeechCapability();
  const recorder = useVoiceRecorder();
  const [clip, setClip] = useState<VoiceRecording | undefined>(undefined);
  const [playbackUrl, setPlaybackUrl] = useState<string | undefined>(undefined);
  const [transcription, setTranscription] = useState<Transcription>({ kind: "none" });
  const requestId = useRef(0);

  const canTranscribe =
    speech.client !== undefined && speech.status.transcription.status === "ready";

  useEffect(() => {
    if (clip === undefined || typeof URL.createObjectURL !== "function") {
      setPlaybackUrl(undefined);
      return undefined;
    }
    const url = URL.createObjectURL(clip.audio);
    setPlaybackUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip]);

  const finish = async () => {
    const recording = await recorder.stop();
    if (recording !== undefined) setClip(recording);
  };

  const overLimit = recorder.state.kind === "recording" && recorder.elapsedMs >= MICROPHONE_TEST_MS;
  useEffect(() => {
    if (overLimit) void finish();
    // `finish` reads the current recorder; the effect only needs to run once
    // when the limit is crossed.
  }, [overLimit]);

  if (!recorder.supported) {
    return <p className="provider-settings__field-guidance">This browser cannot record audio.</p>;
  }

  const recording = recorder.state.kind === "recording";
  const starting = recorder.state.kind === "requesting";

  return (
    <div className="voice-settings__test">
      <div className="voice-settings__test-controls">
        <OctantButton
          aria-pressed={recording}
          disabled={starting || transcription.kind === "transcribing"}
          onClick={() => {
            if (recording) {
              void finish();
              return;
            }
            requestId.current += 1;
            setClip(undefined);
            setTranscription({ kind: "none" });
            void recorder.start();
          }}
          size="sm"
          type="button"
          variant={recording ? "destructive" : "secondary"}
        >
          {recording ? (
            <Square aria-hidden="true" fill="currentColor" size={12} />
          ) : (
            <Mic aria-hidden="true" size={14} />
          )}
          {recording ? "Stop" : clip === undefined ? "Record" : "Record again"}
        </OctantButton>
        {recording ? (
          <span aria-live="off" className="voice-settings__test-timer">
            {formatRecordingDuration(recorder.elapsedMs)} /{" "}
            {formatRecordingDuration(MICROPHONE_TEST_MS)}
          </span>
        ) : null}
        {clip !== undefined && canTranscribe ? (
          <OctantButton
            disabled={transcription.kind === "transcribing"}
            onClick={() => {
              const client = speech.client;
              if (client === undefined) return;
              const id = ++requestId.current;
              setTranscription({ kind: "transcribing" });
              client.transcribe({ audio: clip.audio }).then(
                (result) => {
                  if (id !== requestId.current) return;
                  const text = result.text.trim();
                  setTranscription(
                    text.length === 0
                      ? { kind: "failed", message: "Nothing was heard in that recording." }
                      : { kind: "heard", text },
                  );
                },
                (error: unknown) => {
                  if (id !== requestId.current) return;
                  setTranscription({
                    kind: "failed",
                    message:
                      error instanceof SpeechClientFailure
                        ? error.message
                        : "The recording could not be transcribed.",
                  });
                },
              );
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            {transcription.kind === "transcribing" ? "Transcribing…" : "Transcribe it"}
          </OctantButton>
        ) : null}
      </div>
      {clip !== undefined && playbackUrl !== undefined ? (
        <audio aria-label="Test recording" controls src={playbackUrl} />
      ) : null}
      {recorder.state.kind === "unavailable" ? (
        /* ui-boundary-exception: inline-field-error */
        <p className="provider-settings__field-guidance" role="alert">
          {recorder.state.reason}
        </p>
      ) : null}
      {transcription.kind === "heard" ? (
        <p className="provider-settings__field-guidance" role="status">
          Heard: “{transcription.text}”
        </p>
      ) : transcription.kind === "failed" ? (
        /* ui-boundary-exception: inline-field-error */
        <p className="provider-settings__field-guidance" role="alert">
          {transcription.message}
        </p>
      ) : null}
    </div>
  );
}

import { SpeechClientFailure } from "@octant/client-runtime/speech-client";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { useSpeechCapability } from "./SpeechCapabilityContext";
import { formatRecordingDuration, MAX_VOICE_RECORDING_MS, useVoiceRecorder } from "./voiceRecorder";

export interface ComposerVoiceButtonProps {
  /** Receives the transcript; the caller appends it to its draft. Nothing is sent. */
  readonly onTranscript: (transcript: string) => void;
  readonly disabled?: boolean | undefined;
  /** Optional BCP-47 hint forwarded to transcription. */
  readonly language?: string | undefined;
}

type Phase =
  | { readonly kind: "ready" }
  | { readonly kind: "transcribing" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The microphone beside a composer's attach control. It exists only while the
 * host reports transcription `ready` and this browser can record; otherwise
 * the composer looks exactly as it did before voice shipped. A finished clip
 * goes to the host and comes back as text the caller appends — the person
 * still reads it and presses send.
 */
export function ComposerVoiceButton(props: ComposerVoiceButtonProps) {
  const speech = useSpeechCapability();
  const recorder = useVoiceRecorder();
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const requestId = useRef(0);
  const onTranscript = useRef(props.onTranscript);
  onTranscript.current = props.onTranscript;

  const client = speech.client;
  const ready = speech.status.transcription.status === "ready" && client !== undefined;

  const finish = async () => {
    const recording = await recorder.stop();
    if (recording === undefined || client === undefined) return;
    const id = ++requestId.current;
    setPhase({ kind: "transcribing" });
    try {
      const transcript = await client.transcribe({
        audio: recording.audio,
        ...(props.language === undefined ? {} : { language: props.language }),
      });
      if (id !== requestId.current) return;
      setPhase({ kind: "ready" });
      if (transcript.text.trim().length === 0) {
        setPhase({ kind: "failed", message: "Nothing was heard in that recording." });
        return;
      }
      onTranscript.current(transcript.text);
    } catch (error) {
      if (id !== requestId.current) return;
      setPhase({
        kind: "failed",
        message:
          error instanceof SpeechClientFailure
            ? error.message
            : "The recording could not be transcribed.",
      });
    }
  };

  // The recorder stops a forgotten dictation itself; the clip is still
  // transcribed, because the words spoken before the limit were meant.
  const overLimit =
    recorder.state.kind === "recording" && recorder.elapsedMs >= MAX_VOICE_RECORDING_MS;
  useEffect(() => {
    if (overLimit) void finish();
    // `finish` closes over the current recorder and client; re-running on
    // every render would restart the effect without the limit having moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overLimit]);

  // A transcription that is still in flight when the endpoint disappears must
  // not land in a composer that no longer offers voice.
  useEffect(() => {
    if (!ready) {
      requestId.current += 1;
      recorder.cancel();
      setPhase({ kind: "ready" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!ready || !recorder.supported) return null;

  const recording = recorder.state.kind === "recording";
  const busy = recorder.state.kind === "requesting" || phase.kind === "transcribing";
  const label = recording
    ? "Stop dictating"
    : phase.kind === "transcribing"
      ? "Transcribing…"
      : recorder.state.kind === "requesting"
        ? "Starting microphone…"
        : "Dictate message";
  const failure =
    phase.kind === "failed"
      ? phase.message
      : recorder.state.kind === "unavailable"
        ? recorder.state.reason
        : undefined;

  return (
    <span className="composer-voice">
      <OctantButton
        aria-label={label}
        aria-pressed={recording}
        className="composer-voice__button"
        data-recording={recording ? "true" : undefined}
        disabled={props.disabled === true || busy}
        onClick={() => {
          if (recording) {
            void finish();
            return;
          }
          setPhase({ kind: "ready" });
          void recorder.start();
        }}
        size="icon"
        title={label}
        type="button"
        variant="ghost"
      >
        {busy ? (
          <LoaderCircle
            aria-hidden="true"
            className="composer-voice__spin"
            size={16}
            strokeWidth={1.8}
          />
        ) : recording ? (
          <Square aria-hidden="true" fill="currentColor" size={12} strokeWidth={1.5} />
        ) : (
          <Mic aria-hidden="true" size={16} strokeWidth={1.8} />
        )}
      </OctantButton>
      {recording ? (
        <span aria-live="off" className="composer-voice__timer">
          {formatRecordingDuration(recorder.elapsedMs)}
        </span>
      ) : null}
      {failure === undefined ? null : (
        <span className="composer-voice__error" role="alert">
          {failure}
        </span>
      )}
    </span>
  );
}

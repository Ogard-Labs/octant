import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  readMobileTranscriptionReadiness,
  transcribeMobileClip,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { useExpoVoiceRecorder } from "./expoVoiceRecorder";
import { VoiceDictation, type VoiceDictationView } from "./voiceDictation";

/** What a composer needs to draw its microphone; absent, it draws none. */
export interface ComposerVoice {
  readonly state: "idle" | "recording" | "transcribing";
  readonly onPress: () => void;
  readonly notice: string | undefined;
}

/**
 * Dictation for one composer on one host. The host's readiness is read when
 * the host changes and whenever the app returns to the foreground; leaving the
 * foreground or the screen drops a recording unsent.
 */
export function useVoiceDictation(input: {
  readonly transport: MobileRemoteTransport | undefined;
  readonly editable: boolean;
  readonly appendToDraft: (text: string) => void;
}): ComposerVoice | undefined {
  const recorder = useExpoVoiceRecorder();
  const [view, setView] = useState<VoiceDictationView>({ kind: "hidden" });
  const [notice, setNotice] = useState<string | undefined>();
  const transportRef = useRef(input.transport);
  transportRef.current = input.transport;
  const appendRef = useRef(input.appendToDraft);
  appendRef.current = input.appendToDraft;

  const dictation = useMemo(
    () =>
      new VoiceDictation({
        recorder,
        transcribe: async (clip) => {
          const transport = transportRef.current;
          if (transport === undefined) {
            return {
              status: "refused",
              category: "unavailable",
              message: "No computer is connected to transcribe the recording.",
            };
          }
          return transcribeMobileClip({ transport, audio: clip.audio, mediaType: clip.mediaType });
        },
        appendToDraft: (text) => appendRef.current(text),
        onChange: (next, nextNotice) => {
          setView(next);
          setNotice(nextNotice);
        },
      }),
    [recorder],
  );

  useEffect(() => {
    const transport = input.transport;
    dictation.setReady(false);
    if (transport === undefined) return;
    let current = true;
    const readReadiness = () => {
      void readMobileTranscriptionReadiness({ transport }).then((readiness) => {
        if (current) dictation.setReady(readiness === "ready");
      });
    };
    readReadiness();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") void dictation.cancel();
      else if (previous !== "active") readReadiness();
      previous = next;
    });
    return () => {
      current = false;
      subscription.remove();
      void dictation.cancel();
    };
  }, [dictation, input.transport]);

  if (view.kind === "hidden") return undefined;
  if (view.kind === "idle" && !input.editable) return undefined;
  return { state: view.kind, onPress: () => void dictation.press(), notice };
}

import { SpeechClientFailure } from "@octant/client-runtime/speech-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpeechCapability } from "./SpeechCapabilityContext";

export type ReadAloudVoice = "provider" | "system" | "none";

export interface ReadAloud {
  /**
   * Where speech would come from: the configured provider, this computer's
   * own voices when no provider is set, or nowhere at all.
   */
  readonly voice: ReadAloudVoice;
  readonly speaking: boolean;
  readonly error: string | undefined;
  readonly speak: (text: string) => Promise<void>;
  readonly stop: () => void;
}

/**
 * Reads text aloud. A configured synthesis endpoint is asked for audio and the
 * bytes are played; without one the operating system's speech synthesizer
 * speaks locally and the host is never called. A provider that fails is
 * reported, not quietly replaced by the system voice — Settings said which
 * voice would speak, and this hook does what Settings said.
 */
export function useReadAloud(): ReadAloud {
  const speech = useSpeechCapability();
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const playback = useRef<{ audio: HTMLAudioElement; url: string } | undefined>(undefined);
  const requestId = useRef(0);

  const providerReady = speech.status.synthesis.status === "ready" && speech.client !== undefined;
  const systemAvailable = typeof window !== "undefined" && "speechSynthesis" in window;
  const voice: ReadAloudVoice = providerReady ? "provider" : systemAvailable ? "system" : "none";

  const stop = useCallback(() => {
    requestId.current += 1;
    const current = playback.current;
    playback.current = undefined;
    if (current !== undefined) {
      current.audio.pause();
      URL.revokeObjectURL(current.url);
    }
    if (systemAvailable) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [systemAvailable]);

  const speak = useCallback(
    async (text: string) => {
      const spoken = text.trim();
      if (spoken.length === 0) return;
      stop();
      setError(undefined);
      const id = ++requestId.current;
      if (voice === "provider" && speech.client !== undefined) {
        setSpeaking(true);
        try {
          const audio = await speech.client.synthesize({ text: spoken });
          if (id !== requestId.current) return;
          const url = URL.createObjectURL(audio.bytes);
          const element = new Audio(url);
          playback.current = { audio: element, url };
          const done = () => {
            if (playback.current?.audio !== element) return;
            playback.current = undefined;
            URL.revokeObjectURL(url);
            setSpeaking(false);
          };
          element.addEventListener("ended", done);
          element.addEventListener("error", () => {
            done();
            setError("The audio could not be played.");
          });
          await element.play();
        } catch (failure) {
          if (id !== requestId.current) return;
          setSpeaking(false);
          setError(
            failure instanceof SpeechClientFailure
              ? failure.message
              : "The reply could not be read aloud.",
          );
        }
        return;
      }
      if (voice === "system") {
        const utterance = new SpeechSynthesisUtterance(spoken);
        utterance.addEventListener("end", () => {
          if (id === requestId.current) setSpeaking(false);
        });
        utterance.addEventListener("error", () => {
          if (id !== requestId.current) return;
          setSpeaking(false);
          setError("This computer's voice could not read the reply.");
        });
        setSpeaking(true);
        window.speechSynthesis.speak(utterance);
      }
    },
    [speech.client, stop, voice],
  );

  useEffect(() => stop, [stop]);

  return { voice, speaking, error, speak, stop };
}

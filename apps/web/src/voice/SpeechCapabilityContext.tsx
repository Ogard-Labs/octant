import type { SpeechClient } from "@octant/client-runtime/speech-client";
import type {
  ProviderInstance,
  SpeechCapabilityStatus,
  SpeechStatusResponse,
  VoiceSettings,
} from "@octant/contracts";
import { LOCAL_SPEECH_DOWNLOADING_REASON, speechStatusOf } from "@octant/domain";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface SpeechCapability {
  /** Absent when this renderer has no host speech routes to call. */
  readonly client: SpeechClient | undefined;
  /**
   * Readiness of each direction, decided by the same policy the host routes
   * run over the same inputs (Voice settings and the provider registry). A
   * surface reads this to decide whether to offer a control at all; the host
   * still resolves and enforces on every call.
   */
  readonly status: SpeechStatusResponse;
  /** Asks the host again, after something that may have made its engine ready. */
  readonly refresh: () => void;
}

const NO_SPEECH: SpeechCapability = {
  client: undefined,
  status: speechStatusOf({}, []),
  refresh: () => undefined,
};

const SpeechCapabilityContext = createContext<SpeechCapability>(NO_SPEECH);

export interface SpeechCapabilityProviderProps {
  readonly client: SpeechClient | undefined;
  readonly settings: VoiceSettings;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly children: ReactNode;
}

/**
 * Hands every composer and Navigator one view of what voice can do right now,
 * so a microphone appears wherever text is typed without each surface threading
 * a client and two settings objects through its props.
 *
 * Whether the host's own engine is ready is a fact of the host (its system,
 * its speech model, whether this window is on it), so with that engine chosen
 * the host is asked, and asked again when the window regains focus. Until it
 * answers ready, no microphone is offered.
 */
export function SpeechCapabilityProvider(props: SpeechCapabilityProviderProps) {
  const local = props.settings.transcriptionEngine !== undefined;
  const client = props.client;
  const [hostTranscription, setHostTranscription] = useState<SpeechCapabilityStatus>();
  const [asked, setAsked] = useState(0);
  const refresh = useCallback(() => setAsked((count) => count + 1), []);

  useEffect(() => {
    if (!local || client === undefined) {
      setHostTranscription(undefined);
      return undefined;
    }
    let live = true;
    const read = (upgradeOnly: boolean) => {
      // A read on focus only ever turns the microphone on. A slow or busy
      // helper must not take it away mid-dictation; a model that is gone is
      // said by the host when the clip is sent.
      client.status().then(
        (status) => {
          if (!live) return;
          if (upgradeOnly && status.transcription.status !== "ready") return;
          setHostTranscription(status.transcription);
        },
        () => undefined,
      );
    };
    const onFocus = () => read(true);
    read(false);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [client, local, props.settings.language, asked]);

  // A download outlives the Settings page that started it. While the host says
  // one is under way, ask again now and then, so the microphone appears when
  // it ends; a model that is simply missing is not asked about again.
  const downloading =
    hostTranscription?.status === "unavailable" &&
    hostTranscription.reason === LOCAL_SPEECH_DOWNLOADING_REASON;
  useEffect(() => {
    if (!downloading) return undefined;
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, [downloading, refresh]);

  const value = useMemo<SpeechCapability>(() => {
    const status = speechStatusOf(props.settings, props.instances);
    return {
      client:
        local && client !== undefined
          ? {
              ...client,
              transcribe: async (input) => {
                const { toLocalClip } = await import("./localClip");
                return client.transcribe({ ...input, audio: await toLocalClip(input.audio) });
              },
            }
          : client,
      status:
        local && hostTranscription !== undefined
          ? { ...status, transcription: hostTranscription }
          : status,
      refresh,
    };
  }, [client, local, hostTranscription, props.settings, props.instances, refresh]);
  return (
    <SpeechCapabilityContext.Provider value={value}>
      {props.children}
    </SpeechCapabilityContext.Provider>
  );
}

export function useSpeechCapability(): SpeechCapability {
  return useContext(SpeechCapabilityContext);
}

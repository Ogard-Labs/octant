import type { SpeechClient } from "@octant/client-runtime/speech-client";
import type { ProviderInstance, SpeechStatusResponse, VoiceSettings } from "@octant/contracts";
import { speechStatusOf } from "@octant/domain";
import { createContext, useContext, useMemo, type ReactNode } from "react";

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
}

const NO_SPEECH: SpeechCapability = {
  client: undefined,
  status: speechStatusOf({}, []),
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
 */
export function SpeechCapabilityProvider(props: SpeechCapabilityProviderProps) {
  const value = useMemo<SpeechCapability>(
    () => ({
      client: props.client,
      status: speechStatusOf(props.settings, props.instances),
    }),
    [props.client, props.settings, props.instances],
  );
  return (
    <SpeechCapabilityContext.Provider value={value}>
      {props.children}
    </SpeechCapabilityContext.Provider>
  );
}

export function useSpeechCapability(): SpeechCapability {
  return useContext(SpeechCapabilityContext);
}

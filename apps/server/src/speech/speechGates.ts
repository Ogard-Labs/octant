import { SPEECH_HOST_CONCURRENCY } from "@octant/contracts";

/** Agents and paired clips together must leave capacity for the local microphone. */
class SpeechGate {
  #active = 0;
  #shared = 0;

  tryAcquire(source: "local" | "shared"): (() => void) | null {
    if (
      this.#active >= SPEECH_HOST_CONCURRENCY ||
      (source === "shared" && this.#shared >= SPEECH_HOST_CONCURRENCY - 1)
    )
      return null;
    this.#active++;
    if (source === "shared") this.#shared++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      if (source === "shared") this.#shared--;
    };
  }
}

export function createSpeechGates() {
  return { transcription: new SpeechGate(), synthesis: new SpeechGate() };
}
export type SpeechGates = ReturnType<typeof createSpeechGates>;

// Main's half of a relay admission (decision H36). The relay runs here, but
// the device key lives in the window that paired, and never leaves it. When
// the hub's challenge arrives, main asks the window that sent the request to
// sign it, and the window answers with the signature and the key's public
// SPKI. Main asks only for text that reads exactly as a relay admission for
// the computer the request is for, takes an answer only from the window it
// asked, and gives up after the relay's own admission time.

import { parseRelayAdmissionPayload } from "@octant/client-runtime/relay-tunnel";
import type { RelayAdmissionSignature } from "@octant/client-runtime/relay-tunnel";
import type { PairedComputerRelaySigningRequest } from "@octant/contracts/desktop-bridge";

/** The relay gives an admission this long; the window's answer must come inside it. */
export const RELAY_SIGNING_TIMEOUT_MS = 10_000;

const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const SPKI = /^[A-Za-z0-9_-]{80,512}$/;

export class PairedComputerRelaySigning<Window> {
  readonly #send: (window: Window, request: PairedComputerRelaySigningRequest) => void;
  readonly #newId: () => string;
  readonly #timeoutMs: number;
  readonly #pending = new Map<
    string,
    {
      readonly window: Window;
      readonly settle: (answer: RelayAdmissionSignature | undefined) => void;
    }
  >();

  constructor(options: {
    readonly send: (window: Window, request: PairedComputerRelaySigningRequest) => void;
    readonly newId: () => string;
    readonly timeoutMs?: number;
  }) {
    this.#send = options.send;
    this.#newId = options.newId;
    this.#timeoutMs = options.timeoutMs ?? RELAY_SIGNING_TIMEOUT_MS;
  }

  /**
   * Asks `window` to sign one relay admission for the computer at `origin`,
   * whose host id is `hostId`. Rejects, asking nothing, for any other text;
   * rejects when the window refuses, answers malformed, or does not answer.
   */
  ask(
    window: Window,
    request: { readonly origin: string; readonly hostId: string; readonly payload: string },
  ): Promise<RelayAdmissionSignature> {
    const parsed = parseRelayAdmissionPayload(request.payload);
    if (parsed === undefined || parsed.targetMemberId !== request.hostId) {
      return Promise.reject(new Error("Octant signs only a relay admission for that computer."));
    }
    const requestId = this.#newId();
    return new Promise<RelayAdmissionSignature>((resolve, reject) => {
      const timer = setTimeout(() => settle(undefined), this.#timeoutMs);
      const settle = (answer: RelayAdmissionSignature | undefined): void => {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        if (answer === undefined) reject(new Error("The window did not sign the relay admission."));
        else resolve(answer);
      };
      this.#pending.set(requestId, { window, settle });
      this.#send(window, { requestId, origin: request.origin, payload: request.payload });
    });
  }

  /** The window's answer; taken only from the window that was asked. Returns whether it was. */
  answer(window: Window, value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const { requestId, signature, deviceSpki } = value as Record<string, unknown>;
    if (typeof requestId !== "string") return false;
    const pending = this.#pending.get(requestId);
    if (pending === undefined || pending.window !== window) return false;
    pending.settle(
      typeof signature === "string" &&
        SIGNATURE.test(signature) &&
        typeof deviceSpki === "string" &&
        SPKI.test(deviceSpki)
        ? { signature, deviceSpki }
        : undefined,
    );
    return true;
  }
}

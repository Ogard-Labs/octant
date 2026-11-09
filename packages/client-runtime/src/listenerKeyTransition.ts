import { Schema } from "effect";
import { ListenerKeyTransition } from "@octant/contracts";
import { LISTENER_KEY_TRANSITION_WINDOW_MS, listenerKeyTransitionPayload } from "@octant/domain";
import { listenerPinFromSha256, type ListenerOriginTrust } from "./remoteListenerTrust";

const decodeTransition = Schema.decodeUnknownSync(ListenerKeyTransition);

/** Verifies the old pinned key's delegation; an unrecognized key never bootstraps trust. */
export async function stageListenerKeyTransition(input: {
  readonly value: unknown;
  readonly origin: string;
  readonly hostId?: string;
  readonly trust: ListenerOriginTrust;
  readonly now: number;
}): Promise<
  | { readonly status: "staged"; readonly trust: ListenerOriginTrust }
  | { readonly status: "refused" }
> {
  try {
    const transition = decodeTransition(input.value);
    const start = Date.parse(transition.preparedAt);
    const end = Date.parse(transition.expiresAt);
    const current = input.trust.current;
    if (
      current.kind !== "pinned" ||
      transition.origin !== input.origin ||
      (input.hostId !== undefined && transition.hostId !== input.hostId) ||
      transition.oldPin !== current.pin ||
      transition.oldPin === transition.newPin ||
      start > input.now ||
      end <= input.now ||
      end - start !== LISTENER_KEY_TRANSITION_WINDOW_MS
    )
      return { status: "refused" };
    const publicKeyBytes = fromBase64Url(transition.oldPublicKey);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyBytes));
    if (listenerPinFromSha256(digest) !== current.pin) return { status: "refused" };
    const key = await crypto.subtle.importKey(
      "spki",
      publicKeyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(transition.signature),
      new TextEncoder().encode(listenerKeyTransitionPayload(transition)),
    );
    return valid
      ? {
          status: "staged",
          trust: {
            current,
            staged: {
              trust: { kind: "pinned", pin: transition.newPin },
              until: transition.expiresAt,
            },
          },
        }
      : { status: "refused" };
  } catch {
    return { status: "refused" };
  }
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Called only for a response received over the already-judged listener TLS connection. */
export async function listenerTrustAfterResponse(input: {
  readonly header: string | null;
  readonly origin: string;
  readonly hostId?: string;
  readonly trust: ListenerOriginTrust;
  readonly now: number;
}): Promise<ListenerOriginTrust> {
  if (input.header === "none") return { current: input.trust.current };
  if (input.header === null || input.header.length > 4_096) return input.trust;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(input.header)));
    const staged = await stageListenerKeyTransition({ ...input, value });
    return staged.status === "staged" ? staged.trust : input.trust;
  } catch {
    return input.trust;
  }
}

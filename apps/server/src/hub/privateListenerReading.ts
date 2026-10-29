import { isIP } from "node:net";
import { classifyRemoteListenerAddress } from "@octant/domain";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import { digestFromListenerPin } from "./hubCrypto";

export type PrivateListenerReading =
  | {
      readonly status: "private";
      readonly origin: string;
      readonly port: number | undefined;
      readonly sourceClass: "lan-private" | "tailscale";
      /** The listener's certificate pin as a roster holds it. */
      readonly pinDigest: string;
      readonly privateNames: ReadonlyArray<string>;
      readonly addresses: ReadonlyArray<string>;
    }
  | {
      readonly status: "refused";
      readonly kind: "listener-not-running" | "listener-not-private" | "listener-has-no-pin";
    };

/**
 * Whether the host's private listener is serving on a Tailscale, RFC 1918, or
 * IPv6 ULA address, which is the only place hub and spoke traffic is served. A
 * listener bound anywhere else, or serving a certificate the person pasted
 * (which has no pin a member can hold it to), is refused.
 */
export function readPrivateListener(status: PrivateListenerHostStatus): PrivateListenerReading {
  if (status.state !== "ready" || status.hostname === null || status.origin === null) {
    return { status: "refused", kind: "listener-not-running" };
  }
  const sourceClass = classifyRemoteListenerAddress(status.hostname);
  if (sourceClass !== "lan-private" && sourceClass !== "tailscale") {
    return { status: "refused", kind: "listener-not-private" };
  }
  const pinDigest = status.tlsPin === null ? undefined : digestFromListenerPin(status.tlsPin);
  if (pinDigest === undefined) return { status: "refused", kind: "listener-has-no-pin" };
  const isAddress = isIP(status.hostname.replace(/^\[|\]$/g, "")) !== 0;
  return {
    status: "private",
    origin: status.origin,
    port: status.port ?? undefined,
    sourceClass,
    pinDigest,
    privateNames: isAddress ? [] : [status.hostname],
    addresses: isAddress ? [status.hostname] : [],
  };
}

/** Whether a member's listener origin names a private address, as a join code or roster entry must. */
export function originIsPrivate(origin: string): boolean {
  let hostname: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) return false;
    hostname = url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  const sourceClass = classifyRemoteListenerAddress(hostname);
  return sourceClass === "lan-private" || sourceClass === "tailscale";
}

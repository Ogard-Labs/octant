// How one member authenticates a request to another. Each request is signed
// with the sender's host identity key over its method, path, body, time, a
// nonce, and the recipient's member id, so a request cannot be changed or
// replayed, nor sent on to a different host. The receiver holds the sender's
// public key from joining and accepts nothing else.

import { createHash, randomBytes } from "node:crypto";
import { verifySignature } from "./hubCrypto";
import type { HubTransport } from "./pinnedHubTransport";

export const HUB_LINK_HEADER = "x-octant-hub-link";

/** How far a request's time may be from the receiver's clock. */
const FRESHNESS_WINDOW_MS = 120_000;
const MAX_REMEMBERED_NONCES = 4_096;
const REQUEST_TIMEOUT_MS = 8_000;

function signedText(input: {
  readonly recipientMemberId: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: number;
  readonly nonce: string;
}): string {
  return [
    "octant-hub-link-v1",
    input.recipientMemberId,
    input.method.toUpperCase(),
    input.path,
    createHash("sha256").update(input.body, "utf8").digest("hex"),
    String(input.timestamp),
    input.nonce,
  ].join("\n");
}

export function signHubLinkRequest(input: {
  readonly signHostPayload: (payload: string) => string;
  readonly senderMemberId: string;
  readonly recipientMemberId: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly now: number;
}): string {
  const nonce = randomBytes(16).toString("base64url");
  const signature = input.signHostPayload(signedText({ ...input, timestamp: input.now, nonce }));
  return `v1.${input.senderMemberId}.${input.now}.${nonce}.${signature}`;
}

export type HubLinkVerification =
  | { readonly status: "verified"; readonly senderMemberId: string }
  | {
      readonly status: "refused";
      readonly kind:
        | "missing"
        | "malformed"
        | "stale"
        | "unknown-sender"
        | "signature-invalid"
        | "replayed";
    };

export class HubLinkVerifier {
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();

  constructor(options: { readonly now: () => number }) {
    this.#now = options.now;
  }

  /** `publicKeyFor` answers only for a sender the receiver already trusts. */
  verify(input: {
    readonly header: string | null;
    readonly method: string;
    readonly path: string;
    readonly body: string;
    readonly recipientMemberId: string;
    readonly publicKeyFor: (senderMemberId: string) => string | undefined;
  }): HubLinkVerification {
    if (input.header === null) return { status: "refused", kind: "missing" };
    const parts = input.header.split(".");
    const [version, senderMemberId, rawTimestamp, nonce, signature] = parts;
    if (
      parts.length !== 5 ||
      version !== "v1" ||
      senderMemberId === undefined ||
      rawTimestamp === undefined ||
      nonce === undefined ||
      signature === undefined ||
      !/^[0-9]{1,15}$/.test(rawTimestamp)
    ) {
      return { status: "refused", kind: "malformed" };
    }
    const timestamp = Number(rawTimestamp);
    const now = this.#now();
    if (Math.abs(now - timestamp) > FRESHNESS_WINDOW_MS)
      return { status: "refused", kind: "stale" };
    const publicKey = input.publicKeyFor(senderMemberId);
    if (publicKey === undefined) return { status: "refused", kind: "unknown-sender" };
    const valid = verifySignature({
      payload: signedText({
        recipientMemberId: input.recipientMemberId,
        method: input.method,
        path: input.path,
        body: input.body,
        timestamp,
        nonce,
      }),
      signature,
      publicKey,
    });
    if (!valid) return { status: "refused", kind: "signature-invalid" };
    // Remembered only after the signature holds, so a forged header cannot
    // fill the table and push a real nonce out of it.
    this.#forgetExpired(now);
    const remembered = `${senderMemberId}.${nonce}`;
    if (this.#seen.has(remembered)) return { status: "refused", kind: "replayed" };
    this.#seen.set(remembered, timestamp + FRESHNESS_WINDOW_MS);
    return { status: "verified", senderMemberId };
  }

  #forgetExpired(now: number): void {
    if (this.#seen.size < MAX_REMEMBERED_NONCES) return;
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt < now) this.#seen.delete(nonce);
    }
  }
}

export type HubLinkAnswer =
  | { readonly status: "answered"; readonly response: Response }
  /** Nothing was sent, or nothing came back: the pin refused, the address was not private, or the host is down. */
  | { readonly status: "unreachable" };

/**
 * Sends one signed request to a member's listener over a connection held to
 * its pin. The transport reaches only private addresses and never a relay.
 */
export async function sendHubLinkRequest(input: {
  readonly transport: HubTransport;
  readonly target: { readonly origin: string; readonly pin: string };
  readonly signHostPayload: (payload: string) => string;
  readonly senderMemberId: string;
  readonly recipientMemberId: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly body?: string;
  readonly now: number;
}): Promise<HubLinkAnswer> {
  const pinned = input.transport(input.target);
  const body = input.body ?? "";
  const header = signHubLinkRequest({
    signHostPayload: input.signHostPayload,
    senderMemberId: input.senderMemberId,
    recipientMemberId: input.recipientMemberId,
    method: input.method,
    path: input.path,
    body,
    now: input.now,
  });
  try {
    const response = await pinned(`${input.target.origin}${input.path}`, {
      method: input.method,
      headers: {
        [HUB_LINK_HEADER]: header,
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: "answered", response };
  } catch {
    return { status: "unreachable" };
  }
}

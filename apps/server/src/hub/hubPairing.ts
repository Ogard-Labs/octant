// Pairing with a hub from the joining host. A join code is a pairing code, so
// this is the pairing the desktop and phone apps already do, from the server:
// read the code, reach the hub's listener only over a connection held to the
// code's pin, check the hub's signed hello against a nonce made for this
// request, and claim the ticket with a new device key. The person compares the
// short code on both screens and approves on the hub.

import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import {
  HOST_HELLO_CLIENT_NONCE_PARAMETER,
  HostHelloV1,
  PairingStatusResultV1,
} from "@octant/contracts/remote-access";
import { decodeHostAnswer } from "@octant/contracts";
import { buildHostHelloSignaturePayload, readPairingCode } from "@octant/domain";
import { type HubFetch, type HubTransport } from "./pinnedHubTransport";
import { originIsPrivate } from "./privateListenerReading";

/** How far past its stated expiry a hello is still accepted, for a clock a little behind. */
const HELLO_CLOCK_SKEW_MS = 2 * 60 * 1_000;

export type HubPairingRefusal =
  | "not-a-join-code"
  | "damaged-join-code"
  | "newer-join-code"
  | "hub-origin-not-private"
  | "hub-identity-unproven"
  | "hub-too-old";

export type HubPairingOpening =
  | { readonly status: "claimed"; readonly session: HubPairingSession }
  | { readonly status: "refused"; readonly kind: HubPairingRefusal }
  | { readonly status: "failed" };

export type HubPairingPoll =
  | { readonly kind: "pending" }
  | { readonly kind: "approved" }
  | { readonly kind: "failed" };

export interface HubPairingSession {
  /** What the hub's signed hello proved about it, over the connection held to the code's pin. */
  readonly hub: {
    readonly hostId: string;
    readonly displayName: string;
    readonly hostKeyFingerprint: string;
    readonly hostPublicKey: string;
    readonly origin: string;
    readonly pin: string;
  };
  readonly ticket: { readonly ticketId: string; readonly ticketProof: string };
  /** The short code the person compares with the one the hub shows. */
  readonly comparisonCode: string;
  readonly poll: () => Promise<HubPairingPoll>;
}

function readingRefusal(reason: string): HubPairingRefusal {
  switch (reason) {
    case "not-private":
      return "hub-origin-not-private";
    case "newer-version":
      return "newer-join-code";
    case "not-a-pairing-code":
      return "not-a-join-code";
    default:
      return "damaged-join-code";
  }
}

/** Whether the hello is signed by the key it names, for the nonce this request carried. */
function helloIsProven(hello: HostHelloV1, clientNonce: string, now: number): boolean {
  if (hello.hostPublicKey === undefined || hello.clientNonce !== clientNonce) return false;
  if (Date.parse(hello.expiresAt) + HELLO_CLOCK_SKEW_MS <= now) return false;
  try {
    const spki = Buffer.from(hello.hostPublicKey, "base64url");
    if (createHash("sha256").update(spki).digest("hex") !== hello.hostKeyFingerprint) return false;
    return verify(
      "sha256",
      Buffer.from(buildHostHelloSignaturePayload(hello), "utf8"),
      {
        key: createPublicKey({ key: spki, format: "der", type: "spki" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(hello.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

async function postJson(fetch: HubFetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("refused");
  return await response.json();
}

export async function openHubPairing(input: {
  readonly code: string;
  readonly deviceLabel: string;
  readonly transport: HubTransport;
  readonly webBuildVersion: string;
  readonly now: () => number;
}): Promise<HubPairingOpening> {
  const reading = readPairingCode(input.code);
  if (reading.status === "refused") {
    return { status: "refused", kind: readingRefusal(reading.reason) };
  }
  const { origin, ticketId, ticketProof, pin } = reading.contents;
  if (!originIsPrivate(origin)) return { status: "refused", kind: "hub-origin-not-private" };
  const fetch = input.transport({ origin, pin });
  try {
    const clientNonce = randomBytes(32).toString("base64url");
    const helloUrl = new URL("/api/remote/hello", origin);
    helloUrl.searchParams.set(HOST_HELLO_CLIENT_NONCE_PARAMETER, clientNonce);
    const helloResponse = await fetch(helloUrl.toString(), { signal: AbortSignal.timeout(10_000) });
    if (helloResponse.status === 404) return { status: "refused", kind: "hub-too-old" };
    if (!helloResponse.ok) return { status: "failed" };
    const hello = decodeHostAnswer(HostHelloV1)(await helloResponse.json());
    if (
      hello.remoteOrigin !== origin ||
      hello.hostPublicKey === undefined ||
      !helloIsProven(hello, clientNonce, input.now())
    ) {
      return { status: "refused", kind: "hub-identity-unproven" };
    }

    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = keys.publicKey.export({ format: "der", type: "spki" });
    const claimBody = {
      ticketId,
      ticketProof,
      hostHelloNonce: hello.nonce,
      devicePublicKey: String(keys.publicKey.export({ format: "pem", type: "spki" })).trim(),
      deviceKeyFingerprint: createHash("sha256").update(spki).digest("hex"),
      deviceLabel: input.deviceLabel.trim().slice(0, 128),
      origin,
      clientHello: {
        webBuildVersion: input.webBuildVersion,
        supportedProtocolRange: { min: 1, max: 1 },
        browserCapabilities: ["webcrypto"],
      },
    };
    const claim = (await postJson(
      fetch,
      new URL("/api/remote/pairing", origin).toString(),
      claimBody,
    )) as {
      readonly kind?: unknown;
      readonly ticketId?: unknown;
      readonly hostId?: unknown;
      readonly comparisonCode?: unknown;
    };
    if (
      claim.kind !== "pending" ||
      claim.ticketId !== ticketId ||
      claim.hostId !== String(hello.hostId) ||
      typeof claim.comparisonCode !== "string" ||
      !/^\d{6}$/.test(claim.comparisonCode)
    ) {
      return { status: "failed" };
    }
    const comparisonCode = claim.comparisonCode;
    // The device key is not kept: membership rests on the identity key the
    // joining host signs its requests with, and the hub's abandoned-pairing
    // sweep removes a device that never signs in.
    return {
      status: "claimed",
      session: {
        hub: {
          hostId: String(hello.hostId),
          displayName: hello.displayName,
          hostKeyFingerprint: hello.hostKeyFingerprint,
          hostPublicKey: hello.hostPublicKey,
          origin,
          pin,
        },
        ticket: { ticketId, ticketProof },
        comparisonCode,
        poll: async () => {
          try {
            const status = decodeHostAnswer(PairingStatusResultV1)(
              await postJson(fetch, new URL("/api/remote/pairing/status", origin).toString(), {
                ticketId,
                ticketProof,
              }),
            );
            return status.status === "pending"
              ? { kind: "pending" }
              : status.status === "approved"
                ? { kind: "approved" }
                : { kind: "failed" };
          } catch {
            return { kind: "pending" };
          }
        },
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === "HubTransportRefused") {
      return { status: "refused", kind: "hub-identity-unproven" };
    }
    return { status: "failed" };
  }
}

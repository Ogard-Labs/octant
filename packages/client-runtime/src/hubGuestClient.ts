// A phone or browser that joined a hub as a guest. It joins with the same code
// a computer uses and pairs as a device on the hub; from then on it holds the
// hub's signed roster, checks every roster it is handed against the hub key it
// recorded at join, and reaches each spoke directly at the address and pin the
// roster gives. Nothing here goes through the hub except the join and the
// roster read: a spoke's traffic never does (the hub never sees it).
//
// No screen is built on this yet. A platform supplies a pinned transport and a
// device key store, exactly as pairing does.

import {
  NO_LISTENER_PIN,
  decodeHubGuestAdmissionResponse,
  decodeHubGuestRosterResponse,
  decodeHubJoinResponse,
  type HubGuestAdmissionResponse,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import {
  classifyRemoteListenerAddress,
  decideRosterReplacement,
  hubRosterSigningPayload,
  type RosterReplacement,
} from "@octant/domain";
import { openAppPairingCode, type PinnedListenerTransportPort } from "./appPairingCode";
import { listenerPinFromSha256 } from "./remoteListenerTrust";
import type {
  RemoteDeviceKeyPair,
  RemoteDeviceKeyStore,
  RemotePairingApproval,
} from "./remotePairingClient";

const HUB_LINK_HEADER = "x-octant-hub-link";
const HUB_GUEST_ROUTES = {
  join: "/api/hub/join",
  guestRoster: "/api/hub/guest-roster",
  guest: "/api/hub/guest",
} as const;

const encoder = new TextEncoder();

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(digest: string): Uint8Array {
  return Uint8Array.from(digest.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

const sha256 = async (bytes: BufferSource | string): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", typeof bytes === "string" ? encoder.encode(bytes) : bytes);

/** The key a guest signs with: the device key it paired with. */
export interface GuestSigner {
  readonly memberId: string;
  /** SubjectPublicKeyInfo, base64url: the identity key the hub's roster vouches for. */
  readonly publicKey: string;
  /** SHA-256 of the SubjectPublicKeyInfo, lowercase hex: the roster's `identityKeyFingerprint`. */
  readonly fingerprint: string;
  /** IEEE-P1363 signature over the text, base64url. */
  readonly sign: (payload: string) => Promise<string>;
}

export async function createGuestSigner(input: {
  readonly memberId: string;
  readonly keyPair: RemoteDeviceKeyPair;
}): Promise<GuestSigner> {
  const spki = await crypto.subtle.exportKey("spki", input.keyPair.publicKey);
  return {
    memberId: input.memberId,
    publicKey: base64UrlEncode(spki),
    fingerprint: hex(await sha256(new Uint8Array(spki))),
    sign: async (payload) =>
      base64UrlEncode(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          input.keyPair.privateKey,
          encoder.encode(payload),
        ),
      ),
  };
}

async function linkHeader(input: {
  readonly signer: GuestSigner;
  readonly recipientMemberId: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly now: number;
}): Promise<string> {
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const text = [
    "octant-hub-link-v1",
    input.recipientMemberId,
    input.method.toUpperCase(),
    input.path,
    hex(await sha256(input.body)),
    String(input.now),
    nonce,
  ].join("\n");
  return `v1.${input.signer.memberId}.${input.now}.${nonce}.${await input.signer.sign(text)}`;
}

/** Whether `signature` is the key's signature over `payload`; a malformed key or signature is a no. */
async function verifyRosterSignature(input: {
  readonly payload: string;
  readonly signature: string;
  readonly publicKey: string;
}): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      base64UrlDecode(input.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlDecode(input.signature),
      encoder.encode(input.payload),
    );
  } catch {
    return false;
  }
}

/** What a guest keeps about the hub it joined: plain data a platform stores beside its device key. */
export interface GuestHubRecord {
  readonly hub: {
    readonly memberId: string;
    readonly name: string;
    readonly origin: string;
    /** The hub listener's certificate pin, `sha256-` and base64url. */
    readonly pin: string;
    /** The key the hub signs every roster with, recorded at join. */
    readonly rosterSigningPublicKey: string;
  };
  readonly selfMemberId: string;
  readonly deviceKeyId: string;
  readonly roster: SignedHubRoster;
}

export type GuestJoinRefusal =
  | "refused-code"
  | "hub-declined"
  | "hub-refused-join"
  | "hub-answer-invalid"
  | "device-key-lost"
  | "hub-unreachable";

export type GuestJoinStart =
  | {
      readonly status: "awaiting-approval";
      readonly hubName: string;
      readonly hubKeyFingerprint: string;
      /** The short code the person compares with the one the hub shows. */
      readonly comparisonCode: string;
      readonly finish: () => Promise<GuestJoinFinish>;
    }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "failed"; readonly message: string };

export type GuestJoinFinish =
  | { readonly status: "awaiting-approval" }
  | {
      readonly status: "joined";
      readonly record: GuestHubRecord;
      readonly signer: GuestSigner;
      /** The pairing the hub approved: what the guest reaches the hub itself with, as a host. */
      readonly approval: RemotePairingApproval;
    }
  | { readonly status: "refused"; readonly kind: GuestJoinRefusal };

export interface JoinHubAsGuestOptions {
  readonly code: string;
  readonly deviceLabel: string;
  readonly transport: PinnedListenerTransportPort;
  readonly webBuildVersion: string;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly now?: () => number;
}

/**
 * Joins a hub as a guest. The code's pairing runs as it does for a phone: the
 * guest and the hub show a comparison code and the person approves on the hub.
 * Once approved, the guest sends the hub a join request signed with the device
 * key it paired with, which is what the roster vouches for to every spoke.
 */
export async function joinHubAsGuest(options: JoinHubAsGuestOptions): Promise<GuestJoinStart> {
  const now = options.now ?? Date.now;
  const opened = await openAppPairingCode({
    code: options.code,
    transport: options.transport,
    webBuildVersion: options.webBuildVersion,
    deviceKeyStore: options.deviceKeyStore,
    now,
  });
  if (opened.status !== "opened") return opened;
  const hello = opened.hostHello;
  if (hello.hostPublicKey === undefined) {
    return { status: "refused", message: "That Octant host cannot be a hub." };
  }
  const hubPublicKey = hello.hostPublicKey;
  const claimed = await opened.claim(options.deviceLabel);
  if (claimed.status !== "claimed") return claimed;
  const { claim } = claimed;
  const transport = options.transport({
    origin: opened.origin,
    trust: { current: opened.listenerTrust },
  });
  if (transport.status === "unavailable") {
    return { status: "refused", message: "This app cannot hold a connection to that pin." };
  }
  const pinnedFetch = transport.fetch;

  const finish = async (): Promise<GuestJoinFinish> => {
    const polled = await opened.client.pollPairingStatus({ ticket: opened.ticket, claim });
    if (polled.kind === "pending") return { status: "awaiting-approval" };
    if (polled.kind !== "approved") return { status: "refused", kind: "hub-declined" };
    const keyPair = await options.deviceKeyStore
      .get(polled.approval.deviceKeyId)
      .catch(() => undefined);
    if (keyPair === undefined) return { status: "refused", kind: "device-key-lost" };
    const signer = await createGuestSigner({ memberId: crypto.randomUUID(), keyPair });
    const body = JSON.stringify({
      ticketId: opened.ticket.ticketId,
      ticketProof: opened.ticket.ticketProof,
      member: {
        memberId: signer.memberId,
        name: options.deviceLabel,
        identityKeyFingerprint: signer.fingerprint,
        listenerPin: NO_LISTENER_PIN,
        privateNames: [],
        addresses: [],
      },
      identityPublicKey: signer.publicKey,
      asGuest: true,
    });
    let response: Response;
    try {
      response = await pinnedFetch(new URL(HUB_GUEST_ROUTES.join, opened.origin).toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HUB_LINK_HEADER]: await linkHeader({
            signer,
            recipientMemberId: String(hello.hostId),
            method: "POST",
            path: HUB_GUEST_ROUTES.join,
            body,
            now: now(),
          }),
        },
        body,
      });
    } catch {
      return { status: "refused", kind: "hub-unreachable" };
    }
    if (!response.ok) return { status: "refused", kind: "hub-refused-join" };
    let answer;
    try {
      answer = decodeHubJoinResponse(await response.json());
    } catch {
      return { status: "refused", kind: "hub-answer-invalid" };
    }
    // The hub is who its hello proved it to be, the roster is signed by the key
    // the hub announced, and it lists this guest with the key it paired with.
    const self = answer.roster.roster.members.find(
      (member) => String(member.memberId) === signer.memberId,
    );
    const valid =
      String(answer.hub.memberId) === String(hello.hostId) &&
      answer.hub.identityPublicKey === hubPublicKey &&
      hex(await sha256(base64UrlDecode(hubPublicKey))) === hello.hostKeyFingerprint &&
      answer.roster.signedBy.kind === "hub" &&
      String(answer.roster.signedBy.memberId) === String(hello.hostId) &&
      self?.role === "guest" &&
      self.identityKeyFingerprint === signer.fingerprint &&
      (await verifyRosterSignature({
        payload: hubRosterSigningPayload(answer.roster.roster),
        signature: answer.roster.signature,
        publicKey: answer.hub.rosterSigningPublicKey,
      }));
    if (!valid) return { status: "refused", kind: "hub-answer-invalid" };
    return {
      status: "joined",
      signer,
      approval: polled.approval,
      record: {
        hub: {
          memberId: String(answer.hub.memberId),
          name: answer.hub.name,
          origin: opened.origin,
          pin: listenerPinFromSha256(bytesFromHex(answer.hub.listenerPin)),
          rosterSigningPublicKey: answer.hub.rosterSigningPublicKey,
        },
        selfMemberId: signer.memberId,
        deviceKeyId: polled.approval.deviceKeyId,
        roster: answer.roster,
      },
    };
  };

  return {
    status: "awaiting-approval",
    hubName: hello.displayName,
    hubKeyFingerprint: hello.hostKeyFingerprint,
    comparisonCode: claim.comparisonCode,
    finish,
  };
}

export type GuestRosterRefusal =
  | Extract<RosterReplacement, { readonly status: "refused" }>["kind"]
  | "not-the-hub";

export type GuestRosterAcceptance =
  | { readonly status: "accepted"; readonly record: GuestHubRecord }
  | { readonly status: "unchanged"; readonly record: GuestHubRecord }
  | { readonly status: "refused"; readonly kind: GuestRosterRefusal };

/**
 * Whether a roster the guest was handed replaces the one it holds. It must be
 * signed by the hub's roster key recorded at join, and newer than the roster
 * held; a forged, older, or standby-signed roster is refused. The record is
 * returned, never changed in place.
 */
export async function acceptGuestRoster(input: {
  readonly record: GuestHubRecord;
  readonly candidate: SignedHubRoster;
}): Promise<GuestRosterAcceptance> {
  const { record, candidate } = input;
  if (candidate.roster.sequence === record.roster.roster.sequence) {
    // The same sequence is the roster already held only if its bytes are; a
    // different roster at the same sequence is refused as a stale one.
    return candidate.signature === record.roster.signature
      ? { status: "unchanged", record }
      : { status: "refused", kind: "stale-sequence" };
  }
  const fromTheHub =
    candidate.signedBy.kind === "hub" &&
    String(candidate.signedBy.memberId) === record.hub.memberId;
  const decision = decideRosterReplacement({
    held: { latest: record.roster, latestHubSigned: record.roster },
    candidate,
    signatureVerified:
      fromTheHub &&
      (await verifyRosterSignature({
        payload: hubRosterSigningPayload(candidate.roster),
        signature: candidate.signature,
        publicKey: record.hub.rosterSigningPublicKey,
      })),
    hubReachable: true,
  });
  if (decision.status === "refused") return decision;
  return { status: "accepted", record: { ...record, roster: candidate } };
}

export type GuestRosterRefresh =
  | GuestRosterAcceptance
  | { readonly status: "unreachable" }
  | {
      readonly status: "hub-refused";
      readonly httpStatus: number;
      /** What the hub said; `unknown-sender` is the hub saying this guest is not on its roster. */
      readonly kind: string;
    };

/** Reads the current signed roster from the hub, signed as the guest, and accepts it only if it verifies. */
export async function refreshGuestRoster(input: {
  readonly record: GuestHubRecord;
  readonly signer: GuestSigner;
  readonly transport: PinnedListenerTransportPort;
  readonly now?: () => number;
}): Promise<GuestRosterRefresh> {
  const { record } = input;
  const transport = input.transport({
    origin: record.hub.origin,
    trust: { current: { kind: "pinned", pin: record.hub.pin } },
  });
  if (transport.status === "unavailable") return { status: "unreachable" };
  let response: Response;
  try {
    response = await transport.fetch(
      new URL(HUB_GUEST_ROUTES.guestRoster, record.hub.origin).toString(),
      {
        method: "GET",
        headers: {
          [HUB_LINK_HEADER]: await linkHeader({
            signer: input.signer,
            recipientMemberId: record.hub.memberId,
            method: "GET",
            path: HUB_GUEST_ROUTES.guestRoster,
            body: "",
            now: (input.now ?? Date.now)(),
          }),
        },
      },
    );
  } catch {
    return { status: "unreachable" };
  }
  if (!response.ok) {
    const said = (await response.json().catch(() => undefined)) as
      | { readonly kind?: unknown }
      | undefined;
    return {
      status: "hub-refused",
      httpStatus: response.status,
      kind: typeof said?.kind === "string" ? said.kind : "refused",
    };
  }
  let candidate: SignedHubRoster;
  try {
    candidate = decodeHubGuestRosterResponse(await response.json()).roster;
  } catch {
    return { status: "refused", kind: "signature-invalid" };
  }
  return acceptGuestRoster({ record, candidate });
}

/** A member of the roster a guest can reach directly, at the address and pin the roster gives. */
export interface GuestSpokeTarget {
  readonly memberId: string;
  readonly name: string;
  readonly role: RosterMember["role"];
  readonly origin: string;
  /** The member listener's certificate pin, `sha256-` and base64url. */
  readonly pin: string;
}

/**
 * Every member a guest can connect to: the spokes and the hub, each at its
 * first private name or address. A member whose entry names no private
 * address, or no listener pin, is left out; a guest never reaches a spoke by
 * way of the hub.
 */
export function guestSpokeTargets(record: GuestHubRecord): ReadonlyArray<GuestSpokeTarget> {
  return record.roster.roster.members.flatMap((member): ReadonlyArray<GuestSpokeTarget> => {
    if (member.role === "guest" || String(member.memberId) === record.selfMemberId) return [];
    if (member.listenerPin === NO_LISTENER_PIN) return [];
    const host = [...member.privateNames, ...member.addresses].find((candidate) => {
      const reach = classifyRemoteListenerAddress(candidate);
      return reach === "lan-private" || reach === "tailscale";
    });
    if (host === undefined) return [];
    const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const port = member.listenerPort === undefined ? "" : `:${member.listenerPort}`;
    return [
      {
        memberId: String(member.memberId),
        name: member.name,
        role: member.role,
        origin: `https://${hostname}${port}`,
        pin: listenerPinFromSha256(bytesFromHex(member.listenerPin)),
      },
    ];
  });
}

export type GuestSpokeAdmission =
  | ({ readonly status: "admitted" } & HubGuestAdmissionResponse)
  | { readonly status: "refused"; readonly httpStatus: number; readonly kind: string }
  | { readonly status: "unreachable" };

/**
 * Asks one spoke to admit this guest as a paired device, directly, over a
 * connection held to the pin the roster gave. The spoke admits the guest only
 * if it accepted it from a verified roster; otherwise it refuses, and the
 * refusal is returned as it was said.
 */
export async function admitGuestOnSpoke(input: {
  readonly target: GuestSpokeTarget;
  readonly signer: GuestSigner;
  readonly deviceLabel: string;
  readonly transport: PinnedListenerTransportPort;
  readonly now?: () => number;
}): Promise<GuestSpokeAdmission> {
  const transport = input.transport({
    origin: input.target.origin,
    trust: { current: { kind: "pinned", pin: input.target.pin } },
  });
  if (transport.status === "unavailable") return { status: "unreachable" };
  const body = JSON.stringify({
    memberId: input.signer.memberId,
    devicePublicKey: input.signer.publicKey,
    deviceLabel: input.deviceLabel,
  });
  let response: Response;
  try {
    response = await transport.fetch(
      new URL(HUB_GUEST_ROUTES.guest, input.target.origin).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HUB_LINK_HEADER]: await linkHeader({
            signer: input.signer,
            recipientMemberId: input.target.memberId,
            method: "POST",
            path: HUB_GUEST_ROUTES.guest,
            body,
            now: (input.now ?? Date.now)(),
          }),
        },
        body,
      },
    );
  } catch {
    return { status: "unreachable" };
  }
  if (!response.ok) {
    const said = (await response.json().catch(() => undefined)) as
      | { readonly kind?: unknown }
      | undefined;
    return {
      status: "refused",
      httpStatus: response.status,
      kind: typeof said?.kind === "string" ? said.kind : "refused",
    };
  }
  try {
    return { status: "admitted", ...decodeHubGuestAdmissionResponse(await response.json()) };
  } catch {
    return { status: "refused", httpStatus: response.status, kind: "invalid-answer" };
  }
}

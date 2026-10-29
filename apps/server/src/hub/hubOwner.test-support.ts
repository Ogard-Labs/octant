// A software stand-in for an owner device: keys made in the test process that
// sign what a phone's Secure Enclave, a Mac's Touch ID key, or a passkey would,
// in both shapes the host accepts, plus a client that makes the signed owner
// requests the way a device does (ask for a challenge, sign it, send the action).

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_SESSION_HEADER,
  OWNER_UNLOCK_HEADER,
  type OwnerPosture,
  type OwnerPostureChangeRequest,
  type OwnerPostureSubject,
} from "@octant/contracts";
import { ownerUnlockSigningPayload } from "@octant/domain";
import { publicKeyFingerprint } from "./hubCrypto";
import type { HubTestHost, HubTestNetwork } from "./hubHost.test-support";
import { HUB_LINK_HEADER, signHubLinkRequest } from "./hubLink";
import type {
  CredentialCopyBroker,
  CredentialReadResult,
  CredentialStoreResult,
} from "./ownerCredentialCopy";
import type { OwnerPostureChange, OwnerPostureHost, OwnerPostureRead } from "./ownerPostureHost";
import { createPinnedHubTransport } from "./pinnedHubTransport";

export interface SoftwareAuthenticator {
  /** The unlock public key a host records, as a base64url SubjectPublicKeyInfo. */
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly sign: (payload: string) => string;
  /** A passkey assertion over a challenge: authenticator data, client data, and a DER signature. */
  readonly assert: (
    payload: string,
    flags?: number,
  ) => {
    readonly authenticatorData: string;
    readonly clientDataJson: string;
    readonly signature: string;
  };
}

const USER_PRESENT_AND_VERIFIED = 0x05;

export function softwareAuthenticator(): SoftwareAuthenticator {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    publicKey,
    fingerprint: publicKeyFingerprint(publicKey),
    sign: (payload) => signRaw(keys.privateKey, payload),
    assert: (payload, flags = USER_PRESENT_AND_VERIFIED) => {
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: createHash("sha256").update(payload, "utf8").digest("base64url"),
          origin: "https://mac-mini.example.ts.net",
        }),
      );
      const authenticatorData = Buffer.concat([
        randomBytes(32),
        Buffer.from([flags]),
        Buffer.from([0, 0, 0, 1]),
      ]);
      const signature = cryptoSign(
        "sha256",
        Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]),
        { key: keys.privateKey, dsaEncoding: "der" },
      );
      return {
        authenticatorData: authenticatorData.toString("base64url"),
        clientDataJson: clientData.toString("base64url"),
        signature: signature.toString("base64url"),
      };
    },
  };
}

function signRaw(privateKey: KeyObject, payload: string): string {
  return cryptoSign("sha256", Buffer.from(payload, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

export interface OwnerUnlockChoice {
  readonly authenticator: SoftwareAuthenticator;
  readonly shape: "raw" | "webauthn";
  /** The flags byte of the assertion; the default is user present and verified. */
  readonly flags?: number;
  /** Ask for the challenge for a different action than the one then sent. */
  readonly boundTo?: { readonly route: string; readonly body: string };
  /** Milliseconds the host's clock moves between the challenge and the action. */
  readonly delayMs?: number;
  /** A proof header from an earlier call, sent again instead of asking for a new challenge. */
  readonly reuse?: string;
}

export interface OwnerCallResult {
  readonly status: number;
  readonly json: unknown;
  /** The unlock header that went with the action, so a test can send it again. */
  readonly proofHeader?: string;
}

const bodyHash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

/** One signed owner request from `device` to `target`, with an unlock when asked. */
export async function ownerCall(input: {
  readonly device: HubTestHost;
  readonly network: HubTestNetwork;
  readonly target: HubTestHost;
  readonly route: string;
  readonly body?: unknown;
  readonly method?: "GET" | "POST";
  readonly unlock?: OwnerUnlockChoice;
  /** Send the request without the identity key header, as a client that forgot it would. */
  readonly omitIdentityKey?: true;
  /** An administration session id to present beside the signed request, instead of a challenge answer. */
  readonly session?: string;
}): Promise<OwnerCallResult> {
  const method = input.method ?? "POST";
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const { target, device } = input;
  const pin = target.listener.tlsPin;
  if (pin === null) throw new Error("The target has no pin.");
  const fetchPinned = createPinnedHubTransport(input.network.network)({
    origin: target.origin,
    pin,
  });

  const send = async (route: string, sendMethod: "GET" | "POST", text: string, proof?: string) => {
    const header = signHubLinkRequest({
      signHostPayload: device.signHostPayload,
      senderMemberId: device.hostId,
      recipientMemberId: target.hostId,
      method: sendMethod,
      path: route,
      body: text,
      // Signed on the host's clock, so a test that moves it past the minutes an
      // unlock session lasts is not refused as stale before the session is judged.
      now: Date.now() + target.clock.offset,
    });
    const response = await fetchPinned(`${target.origin}${route}`, {
      method: sendMethod,
      headers: {
        [HUB_LINK_HEADER]: header,
        ...(input.omitIdentityKey === true
          ? {}
          : { [OWNER_IDENTITY_KEY_HEADER]: device.hostPublicKey }),
        ...(sendMethod === "GET" ? {} : { "content-type": "application/json" }),
        ...(proof === undefined ? {} : { [OWNER_UNLOCK_HEADER]: proof }),
        ...(input.session === undefined || route === "/api/hub/owner/challenge"
          ? {}
          : { [OWNER_SESSION_HEADER]: input.session }),
      },
      ...(sendMethod === "GET" ? {} : { body: text }),
    });
    return { status: response.status, json: (await response.json()) as unknown };
  };

  let proofHeader = input.unlock?.reuse;
  if (input.unlock !== undefined && proofHeader === undefined) {
    const bound = input.unlock.boundTo ?? { route: input.route, body };
    const asked = await send(
      "/api/hub/owner/challenge",
      "POST",
      JSON.stringify({ method: "POST", path: bound.route, bodyHash: bodyHash(bound.body) }),
    );
    const challenge = (
      asked.json as { challenge?: { challengeId: string; nonce: string; expiresAt: number } }
    ).challenge;
    // A host that refuses to issue a challenge refuses the action the same way.
    if (challenge === undefined) return asked;
    const payload = ownerUnlockSigningPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      hostMemberId: target.hostId,
      ownerMemberId: device.hostId,
      method: "POST",
      path: bound.route,
      bodyHash: bodyHash(bound.body),
      expiresAt: challenge.expiresAt,
    });
    const proof =
      input.unlock.shape === "raw"
        ? {
            shape: "raw",
            challengeId: challenge.challengeId,
            signature: input.unlock.authenticator.sign(payload),
          }
        : {
            shape: "webauthn",
            challengeId: challenge.challengeId,
            ...input.unlock.authenticator.assert(payload, input.unlock.flags),
          };
    proofHeader = Buffer.from(JSON.stringify(proof)).toString("base64url");
    if (input.unlock.delayMs !== undefined) target.clock.offset += input.unlock.delayMs;
  }
  const answered = await send(input.route, method, body, proofHeader);
  return proofHeader === undefined ? answered : { ...answered, proofHeader };
}

/** A host's credential broker as a test sees it: which rows exist, what they hold, and which are subscription sign-ins. */
export class TestCredentialBroker implements CredentialCopyBroker {
  /** Provider rows that send an API key, by the name a copy uses. */
  readonly providers = new Set<string>();
  /** Sign-ins a provider's own app holds; a copy of one is refused. */
  readonly subscriptions = new Set<string>();
  readonly keys = new Map<string, string>();
  readonly stores: string[] = [];

  async read(name: string): Promise<CredentialReadResult> {
    if (this.subscriptions.has(name)) return { status: "refused", kind: "subscription-sign-in" };
    const value = this.keys.get(name);
    return value === undefined
      ? { status: "refused", kind: "no-such-credential" }
      : { status: "found", value };
  }

  async store(name: string, value: string): Promise<CredentialStoreResult> {
    if (this.subscriptions.has(name)) return { status: "refused", kind: "subscription-sign-in" };
    if (!this.providers.has(name)) return { status: "refused", kind: "no-such-provider" };
    if (this.keys.has(name)) return { status: "refused", kind: "already-stored" };
    this.keys.set(name, value);
    this.stores.push(name);
    return { status: "stored" };
  }
}

/** A host's postures as a test sees them: seeded by subject, and every accepted change recorded. */
export class TestPostureHost implements OwnerPostureHost {
  readonly postures = new Map<string, OwnerPosture>();
  readonly changes: OwnerPostureChangeRequest[] = [];

  seed(posture: OwnerPosture): void {
    this.postures.set(JSON.stringify(posture.subject), posture);
  }

  async read(subject: OwnerPostureSubject): Promise<OwnerPostureRead> {
    const found = this.postures.get(JSON.stringify(subject));
    return found === undefined
      ? { status: "refused", kind: "not-found" }
      : { status: "read", posture: found };
  }

  async change(request: OwnerPostureChangeRequest): Promise<OwnerPostureChange> {
    const key = JSON.stringify(request.subject);
    if (!this.postures.has(key)) return { status: "refused", kind: "not-found" };
    // The host's own rule, as a window meets it: a thread keeps Full access only
    // where its Project remembers it. The test host has no Projects, so it asks
    // for the default to be set on the Project first.
    if (
      request.subject.kind === "code-thread" &&
      request.posture === "full-access" &&
      request.persistence === "project-default"
    ) {
      return { status: "refused", kind: "project-default-not-enabled" };
    }
    this.changes.push(request);
    const next: OwnerPosture = {
      subject: request.subject,
      posture: request.posture,
      persistence: request.persistence,
    };
    this.postures.set(key, next);
    return { status: "changed", posture: next };
  }
}

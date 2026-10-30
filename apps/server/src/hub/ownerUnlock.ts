// A host's check that an owner device's person is present for one action. The
// host issues a challenge bound to the owner and to the exact method, path, and
// body hash it will act on; the owner's unlock key signs it; the host verifies
// the signature before any side effect and forgets the challenge, so one unlock
// authorizes one action. An action of the administration class may instead ride
// an open session (five minutes, decision H17), kept here in memory only and
// bound to the owner device and the owner list it opened against. Two signed
// shapes are accepted: a raw ES256 signature
// over the unlock text (a Secure Enclave, Keystore or Touch ID key), and a
// WebAuthn assertion whose challenge is the SHA-256 of that text (a passkey).

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type {
  OwnerAdministrationSession,
  OwnerChallenge,
  OwnerChallengeRequest,
  OwnerUnlockProof,
} from "@octant/contracts";
import {
  OWNER_ADMINISTRATION_SESSION_MS,
  OWNER_UNLOCK_LIFETIME_MS,
  ownerUnlockSigningPayload,
} from "@octant/domain";
import { verifySignature } from "./hubCrypto";

const MAX_OUTSTANDING_CHALLENGES = 256;
/** WebAuthn authenticator data flags: user present and user verified. */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

interface IssuedChallenge {
  readonly ownerMemberId: string;
  readonly nonce: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
  readonly expiresAt: number;
}

export type OwnerUnlockVerification =
  | { readonly status: "fresh" }
  | {
      readonly status: "refused";
      readonly kind:
        | "no-such-challenge"
        | "expired"
        | "wrong-owner"
        | "action-mismatch"
        | "signature-invalid"
        | "user-verification-missing";
    };

export type ChallengeIssue =
  | { readonly status: "issued"; readonly challenge: OwnerChallenge }
  | { readonly status: "refused"; readonly kind: "too-many-challenges" };

const MAX_OPEN_SESSIONS = 64;

/** An open administration session: bound to one owner device and to the owner list it was opened against. */
interface OpenSession {
  readonly ownerMemberId: string;
  /** Identifies the owner list (and each owner's unlock key) the session was opened against. */
  readonly ownerListStamp: string;
  readonly expiresAt: number;
}

export type OwnerSessionCheck =
  | { readonly status: "open" }
  | {
      readonly status: "refused";
      readonly kind:
        | "no-such-session"
        | "session-expired"
        | "session-wrong-owner"
        | "session-owner-changed";
    };

export class OwnerUnlockService {
  readonly #now: () => number;
  readonly #hostMemberId: () => string;
  readonly #issued = new Map<string, IssuedChallenge>();
  // In memory only, never persisted: a restart ends every session.
  readonly #sessions = new Map<string, OpenSession>();

  constructor(options: { readonly now: () => number; readonly hostMemberId: () => string }) {
    this.#now = options.now;
    this.#hostMemberId = options.hostMemberId;
  }

  issue(input: {
    readonly ownerMemberId: string;
    readonly request: OwnerChallengeRequest;
  }): ChallengeIssue {
    const now = this.#now();
    this.#forgetExpired(now);
    if (this.#issued.size >= MAX_OUTSTANDING_CHALLENGES) {
      return { status: "refused", kind: "too-many-challenges" };
    }
    const challengeId = randomUUID();
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = now + OWNER_UNLOCK_LIFETIME_MS;
    this.#issued.set(challengeId, {
      ownerMemberId: input.ownerMemberId,
      nonce,
      method: input.request.method,
      path: input.request.path,
      bodyHash: input.request.bodyHash,
      expiresAt,
    });
    return { status: "issued", challenge: { challengeId, nonce, expiresAt } };
  }

  /**
   * Checks a proof against the challenge issued for it and the request that
   * carries it. The challenge is consumed first, so a proof that fails, or is
   * replayed, never opens a second action.
   */
  verify(input: {
    readonly ownerMemberId: string;
    readonly unlockPublicKey: string;
    readonly proof: OwnerUnlockProof;
    readonly request: { readonly method: string; readonly path: string; readonly body: string };
  }): OwnerUnlockVerification {
    const issued = this.#issued.get(input.proof.challengeId);
    this.#issued.delete(input.proof.challengeId);
    if (issued === undefined) return { status: "refused", kind: "no-such-challenge" };
    if (this.#now() > issued.expiresAt) return { status: "refused", kind: "expired" };
    if (issued.ownerMemberId !== input.ownerMemberId) {
      return { status: "refused", kind: "wrong-owner" };
    }
    const bodyHash = createHash("sha256").update(input.request.body, "utf8").digest("hex");
    if (
      issued.method !== input.request.method.toUpperCase() ||
      issued.path !== input.request.path ||
      issued.bodyHash !== bodyHash
    ) {
      return { status: "refused", kind: "action-mismatch" };
    }
    const payload = ownerUnlockSigningPayload({
      challengeId: input.proof.challengeId,
      nonce: issued.nonce,
      hostMemberId: this.#hostMemberId(),
      ownerMemberId: input.ownerMemberId,
      method: issued.method,
      path: issued.path,
      bodyHash: issued.bodyHash,
      expiresAt: issued.expiresAt,
    });
    if (input.proof.shape === "raw") {
      return verifySignature({
        payload,
        signature: input.proof.signature,
        publicKey: input.unlockPublicKey,
      })
        ? { status: "fresh" }
        : { status: "refused", kind: "signature-invalid" };
    }
    return verifyOwnerAssertion({
      payload,
      assertion: input.proof,
      unlockPublicKey: input.unlockPublicKey,
    });
  }

  /**
   * Opens the administration session a verified unlock earns (decision H17).
   * One owner has one session; opening again replaces it. The id is a secret
   * the device presents beside its signed requests, and it is useless to any
   * other owner device.
   */
  openSession(input: {
    readonly ownerMemberId: string;
    readonly ownerListStamp: string;
  }): OwnerAdministrationSession | undefined {
    const now = this.#now();
    this.#forgetExpired(now);
    this.revokeOwner(input.ownerMemberId);
    if (this.#sessions.size >= MAX_OPEN_SESSIONS) return undefined;
    const sessionId = randomBytes(32).toString("base64url");
    const expiresAt = now + OWNER_ADMINISTRATION_SESSION_MS;
    this.#sessions.set(sessionId, {
      ownerMemberId: input.ownerMemberId,
      ownerListStamp: input.ownerListStamp,
      expiresAt,
    });
    return { sessionId, expiresAt };
  }

  /**
   * Whether a session still covers this owner on this host. A session that
   * ran out, or whose owner list changed since it opened, is forgotten.
   */
  checkSession(input: {
    readonly sessionId: string;
    readonly ownerMemberId: string;
    readonly ownerListStamp: string;
  }): OwnerSessionCheck {
    const session = this.#sessions.get(input.sessionId);
    if (session === undefined) return { status: "refused", kind: "no-such-session" };
    if (session.ownerMemberId !== input.ownerMemberId) {
      return { status: "refused", kind: "session-wrong-owner" };
    }
    if (this.#now() > session.expiresAt) {
      this.#sessions.delete(input.sessionId);
      return { status: "refused", kind: "session-expired" };
    }
    if (session.ownerListStamp !== input.ownerListStamp) {
      this.#sessions.delete(input.sessionId);
      return { status: "refused", kind: "session-owner-changed" };
    }
    return { status: "open" };
  }

  /** Ends every session an owner device holds: the device was removed or revoked. */
  revokeOwner(ownerMemberId: string): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.ownerMemberId === ownerMemberId) this.#sessions.delete(sessionId);
    }
  }

  #forgetExpired(now: number): void {
    for (const [challengeId, issued] of this.#issued) {
      if (issued.expiresAt < now) this.#issued.delete(challengeId);
    }
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt < now) this.#sessions.delete(sessionId);
    }
  }
}

/**
 * Whether a passkey's assertion answers `payload`: its challenge is the SHA-256
 * of the text, the person was present and verified, and the key the host
 * recorded signed it. Unlocks and confirmations share this rule.
 */
export function verifyOwnerAssertion(input: {
  readonly payload: string;
  readonly assertion: {
    readonly authenticatorData: string;
    readonly clientDataJson: string;
    readonly signature: string;
  };
  readonly unlockPublicKey: string;
}): OwnerUnlockVerification {
  const invalid = { status: "refused", kind: "signature-invalid" } as const;
  const authenticatorData = Buffer.from(input.assertion.authenticatorData, "base64url");
  const clientDataBytes = Buffer.from(input.assertion.clientDataJson, "base64url");
  let clientData: unknown;
  try {
    clientData = JSON.parse(clientDataBytes.toString("utf8"));
  } catch {
    return invalid;
  }
  if (typeof clientData !== "object" || clientData === null) return invalid;
  const { type, challenge } = clientData as { type?: unknown; challenge?: unknown };
  const expectedChallenge = createHash("sha256").update(input.payload, "utf8").digest("base64url");
  if (type !== "webauthn.get" || challenge !== expectedChallenge) return invalid;
  // 32 bytes of relying-party hash, one flags byte, a four-byte counter.
  const flags = authenticatorData[32];
  if (authenticatorData.byteLength < 37 || flags === undefined) return invalid;
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) {
    return { status: "refused", kind: "user-verification-missing" };
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(input.unlockPublicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    // An assertion's signature is DER-encoded ECDSA over authenticatorData
    // followed by the hash of the client data.
    const signed = Buffer.concat([
      authenticatorData,
      createHash("sha256").update(clientDataBytes).digest(),
    ]);
    return verify(
      "sha256",
      signed,
      { key, dsaEncoding: "der" },
      Buffer.from(input.assertion.signature, "base64url"),
    )
      ? { status: "fresh" }
      : invalid;
  } catch {
    return invalid;
  }
}

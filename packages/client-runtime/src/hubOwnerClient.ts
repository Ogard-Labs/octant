// An owner device acting on a host. It reaches the host's private listener with
// the same signed member request a guest uses, adds the identity key the host
// recorded for it, and for every change asks the host for a challenge bound to
// that one action, has the person's unlock key sign it, and sends the action
// with the proof. A challenge opens one action and ends 60 seconds after the
// host issued it, so the person unlocks once per action.
//
// A platform supplies a pinned transport, the identity key it joined with, and
// an unlock signer that signs only after the person proves presence (Face ID,
// the device passcode, or a passkey with user verification). Nothing here holds
// or exports a private key. A raw key is opened once for an action: the person
// authenticates once, the key signs everything that action needs (the
// confirmation and the proof for it), and the session is closed afterwards. A
// passkey signs one challenge per prompt, so a confirmation asks it twice.

import {
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_SESSION_HEADER,
  OWNER_UNLOCK_HEADER,
  decodeNewMemberConfirmation,
  decodeOwnerAdministrationSession,
  decodeOwnerChallenge,
  type HeldMember,
  type NewMemberAlert,
  type NewMemberConfirmation,
  type OwnerChallenge,
  type OwnerPostureChangeRequest,
  type OwnerPostureSubject,
} from "@octant/contracts";
import { newMemberConfirmationSigningPayload, ownerUnlockSigningPayload } from "@octant/domain";
import type { PinnedListenerTransportPort } from "./appPairingCode";
import {
  HUB_LINK_HEADER,
  base64UrlDecode,
  base64UrlEncode,
  hex,
  linkHeader,
  sha256,
  type LinkSigner,
} from "./hubLinkSigning";

const OWNER_ROUTES = {
  challenge: "/api/hub/owner/challenge",
  alerts: "/api/hub/owner/alerts",
  heldMembers: "/api/hub/owner/held-members",
  alertDismiss: "/api/hub/owner/alerts/dismiss",
  alertRemove: "/api/hub/owner/alerts/remove",
  confirmNewMembers: "/api/hub/owner/confirm-new-members",
  confirmMember: "/api/hub/owner/confirm-member",
  session: "/api/hub/owner/session",
  postureRead: "/api/hub/owner/posture/read",
  postureChange: "/api/hub/owner/posture/change",
  credentialReceive: "/api/hub/owner/credentials/receive",
  credentialCopy: "/api/hub/owner/credentials/copy",
  provisionApply: "/api/hub/owner/provision/apply",
  provisionDismiss: "/api/hub/owner/provision/dismiss",
} as const;

/** The identity key an owner device joined with, which the host's owner list records. */
export interface OwnerIdentity extends LinkSigner {
  /** SubjectPublicKeyInfo, base64url. */
  readonly publicKey: string;
}

/** What asking the person to unlock came to. A person who declines is an answer, not an error. */
export type UnlockAttempt<T> =
  | { readonly status: "signed"; readonly value: T }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable" };

export interface OwnerUnlockAssertion {
  readonly authenticatorData: string;
  readonly clientDataJson: string;
  readonly signature: string;
}

/** A raw key, opened after one authentication. `close` drops the key from memory. */
export interface RawUnlockSession {
  /** ES256 over the text (IEEE-P1363, base64url). May throw when the platform cannot sign. */
  readonly sign: (text: string) => Promise<string>;
  readonly close: () => void;
}

/**
 * The key that answers a host's challenge. `raw` is opened once, after the
 * person authenticates, and signs the unlock text with ES256; `webauthn` is a
 * passkey that signs the SHA-256 of the text, handed over as base64url.
 */
export type OwnerUnlockSigner =
  | {
      readonly shape: "raw";
      /** SubjectPublicKeyInfo, base64url: what the host recorded for this owner. */
      readonly publicKey: string;
      readonly open: () => Promise<UnlockAttempt<RawUnlockSession>>;
    }
  | {
      readonly shape: "webauthn";
      readonly publicKey: string;
      readonly assert: (challenge: string) => Promise<UnlockAttempt<OwnerUnlockAssertion>>;
    };

export interface OwnerTarget {
  readonly memberId: string;
  readonly origin: string;
  /**
   * The host listener's certificate pin, `sha256-` and base64url. A browser
   * cannot check a pin and names none: it reaches only the origin that served
   * its page, under the platform's own certificate check.
   */
  readonly pin?: string;
}

export type OwnerActionResult =
  | { readonly status: "done"; readonly body: unknown }
  | { readonly status: "refused"; readonly kind: string }
  | { readonly status: "not-unlocked"; readonly reason: "cancelled" | "unavailable" }
  | { readonly status: "unreachable" };

export type OwnerAlertsResult =
  | { readonly status: "read"; readonly alerts: ReadonlyArray<NewMemberAlert> }
  | { readonly status: "refused"; readonly kind: string }
  | { readonly status: "unreachable" };

export type OwnerHeldMembersResult =
  | { readonly status: "read"; readonly members: ReadonlyArray<HeldMember> }
  | { readonly status: "refused"; readonly kind: string }
  | { readonly status: "unreachable" };

export interface OwnerClientOptions {
  readonly target: OwnerTarget;
  readonly identity: OwnerIdentity;
  readonly unlock: OwnerUnlockSigner;
  readonly transport: PinnedListenerTransportPort;
  readonly now?: () => number;
}

export interface OwnerClient {
  /** New-member alerts this host raised. A read; it asks for no unlock. */
  readonly alerts: () => Promise<OwnerAlertsResult>;
  /** The members the host holds under Confirm new members: the only ones Confirm applies to. A read; it asks for no unlock. */
  readonly heldMembers: () => Promise<OwnerHeldMembersResult>;
  readonly dismissAlert: (alertId: string) => Promise<OwnerActionResult>;
  readonly removeFromAlert: (alertId: string) => Promise<OwnerActionResult>;
  readonly setConfirmNewMembers: (enabled: boolean) => Promise<OwnerActionResult>;
  /** Confirms a member: the unlock key signs the confirmation, then the action. */
  readonly confirmNewMember: (
    member: Pick<HeldMember, "memberId" | "identityKeyFingerprint">,
  ) => Promise<OwnerActionResult>;
}

/**
 * What an owner device adds beyond alerts and confirmation: the five-minute
 * administration session, a Code posture, an API-key sign-in copy, and a
 * provisioning proposal. Kept apart so a screen that only needs alerts is not
 * handed these.
 */
export interface OwnerAdministrationClient {
  /**
   * One unlock that covers five minutes of administration screens on this host
   * (decision H17). The session is kept in memory only; Full access, merge, a
   * sign-in copy, and an owner change still ask for their own unlock.
   */
  readonly openSession: () => Promise<OwnerActionResult>;
  /** Forgets the session on this device. The host forgets its own at expiry. */
  readonly endSession: () => void;
  /** Whether a session this device opened is still inside its five minutes. */
  readonly hasSession: () => boolean;
  /** A Code Project's or thread's posture on this host. Covered by a session. */
  readonly readPosture: (subject: OwnerPostureSubject) => Promise<OwnerActionResult>;
  /** Changes a posture. Full access asks for its own unlock; any other posture is covered by a session. */
  readonly changePosture: (request: OwnerPostureChangeRequest) => Promise<OwnerActionResult>;
  /** The receiving host's half of a sign-in copy; see `copyApiKeySignIn`. */
  readonly receiveCredential: (input: {
    readonly sourceMemberId: string;
    readonly credentialName: string;
  }) => Promise<OwnerActionResult>;
  /** The sending host's half of a sign-in copy; see `copyApiKeySignIn`. */
  readonly sendCredential: (input: {
    readonly targetMemberId: string;
    readonly credentialName: string;
    readonly ticketId: string;
  }) => Promise<OwnerActionResult>;
  /** Applies a provisioning proposal this spoke holds, through the same path its window uses. */
  readonly applyProposal: (offerId: string, projectId?: string) => Promise<OwnerActionResult>;
  readonly dismissProposal: (offerId: string) => Promise<OwnerActionResult>;
}

/** What a signer answers for one text: a raw signature, or a passkey's assertion. */
type Signed = { readonly signature: string } | OwnerUnlockAssertion;

/** An unlocked signer for one action. `close` ends the session. */
interface ActionSigner {
  readonly sign: (text: string) => Promise<UnlockAttempt<Signed>>;
  readonly close: () => void;
}

const encoder = new TextEncoder();

interface Answer {
  readonly ok: boolean;
  readonly json: unknown;
}

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : undefined;
};

export function createOwnerClient(
  options: OwnerClientOptions,
): OwnerClient & OwnerAdministrationClient {
  const { target, identity, unlock } = options;
  const now = options.now ?? Date.now;

  const send = async (input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body: string;
    readonly proof?: string;
    readonly session?: string;
  }): Promise<Answer | undefined> => {
    const transport = options.transport({
      origin: target.origin,
      trust: {
        current:
          target.pin === undefined ? { kind: "platform" } : { kind: "pinned", pin: target.pin },
      },
    });
    if (transport.status === "unavailable") return undefined;
    try {
      const response = await transport.fetch(new URL(input.path, target.origin).toString(), {
        method: input.method,
        headers: {
          [HUB_LINK_HEADER]: await linkHeader({
            signer: identity,
            recipientMemberId: target.memberId,
            method: input.method,
            path: input.path,
            body: input.body,
            now: now(),
          }),
          [OWNER_IDENTITY_KEY_HEADER]: identity.publicKey,
          ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
          ...(input.proof === undefined ? {} : { [OWNER_UNLOCK_HEADER]: input.proof }),
          ...(input.session === undefined ? {} : { [OWNER_SESSION_HEADER]: input.session }),
        },
        ...(input.method === "POST" ? { body: input.body } : {}),
      });
      const json: unknown = await response.json().catch(() => undefined);
      return { ok: response.ok, json };
    } catch {
      return undefined;
    }
  };

  const refusal = (answer: Answer): { readonly status: "refused"; readonly kind: string } => ({
    status: "refused",
    kind: stringField(answer.json, "kind") ?? "refused",
  });

  /** Asks the person once for a raw key; a passkey is asked per text, when it signs. */
  const openSigner = async (): Promise<UnlockAttempt<ActionSigner>> => {
    if (unlock.shape === "webauthn") {
      return {
        status: "signed",
        value: {
          sign: async (text) => unlock.assert(base64UrlEncode(await sha256(text))),
          close: () => undefined,
        },
      };
    }
    const opened = await unlock.open();
    if (opened.status !== "signed") return opened;
    const session = opened.value;
    return {
      status: "signed",
      value: {
        sign: async (text) => {
          try {
            return { status: "signed", value: { signature: await session.sign(text) } };
          } catch {
            return { status: "unavailable" };
          }
        },
        close: session.close,
      },
    };
  };

  /** Runs one action with a signer the person unlocked, and always closes it. */
  const unlocked = async (
    use: (signer: ActionSigner) => Promise<OwnerActionResult>,
  ): Promise<OwnerActionResult> => {
    const opened = await openSigner();
    if (opened.status !== "signed") return { status: "not-unlocked", reason: opened.status };
    try {
      return await use(opened.value);
    } finally {
      opened.value.close();
    }
  };

  /** Asks for a challenge for this one action, has the unlocked key sign it, and sends the action. */
  const act = async (
    path: string,
    body: string,
    signer: ActionSigner,
  ): Promise<OwnerActionResult> => {
    const bodyHash = hex(await sha256(body));
    const asked = await send({
      method: "POST",
      path: OWNER_ROUTES.challenge,
      body: JSON.stringify({ method: "POST", path, bodyHash }),
    });
    if (asked === undefined) return { status: "unreachable" };
    if (!asked.ok) return refusal(asked);
    let challenge: OwnerChallenge;
    try {
      challenge = decodeOwnerChallenge(
        (asked.json as { challenge?: unknown } | undefined)?.challenge,
      );
    } catch {
      return { status: "refused", kind: "invalid-answer" };
    }
    const text = ownerUnlockSigningPayload({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      hostMemberId: target.memberId,
      ownerMemberId: identity.memberId,
      method: "POST",
      path,
      bodyHash,
      expiresAt: challenge.expiresAt,
    });
    const signed = await signer.sign(text);
    if (signed.status !== "signed") return { status: "not-unlocked", reason: signed.status };
    const proof = {
      shape: unlock.shape,
      challengeId: challenge.challengeId,
      ...signed.value,
    };
    const answered = await send({
      method: "POST",
      path,
      body,
      proof: base64UrlEncode(encoder.encode(JSON.stringify(proof))),
    });
    if (answered === undefined) return { status: "unreachable" };
    if (!answered.ok || stringField(answered.json, "status") === "refused") {
      return refusal(answered);
    }
    return { status: "done", body: answered.json };
  };

  // The administration session lives in memory only, for this client's host.
  let session: { readonly sessionId: string; readonly expiresAt: number } | undefined;
  const sessionLive = (): boolean => session !== undefined && now() < session.expiresAt;

  /** Sends an administration action under the open session; undefined when there is none to use. */
  const underSession = async (
    path: string,
    body: string,
  ): Promise<OwnerActionResult | undefined> => {
    if (session === undefined || !sessionLive()) return undefined;
    const answered = await send({ method: "POST", path, body, session: session.sessionId });
    if (answered === undefined) return { status: "unreachable" };
    if (!answered.ok || stringField(answered.json, "status") === "refused") {
      const refused = refusal(answered);
      // The host ended the session (expiry, a changed owner list, a removed device):
      // forget it here too and let the caller ask for a fresh unlock.
      if (SESSION_ENDED.has(refused.kind)) {
        session = undefined;
        return undefined;
      }
      return refused;
    }
    return { status: "done", body: answered.json };
  };

  /** An administration action: free under an open session, else one fresh unlock for this action. */
  const administration = async (path: string, body: string): Promise<OwnerActionResult> =>
    (await underSession(path, body)) ?? unlocked((signer) => act(path, body, signer));

  return {
    async alerts() {
      const answer = await send({ method: "GET", path: OWNER_ROUTES.alerts, body: "" });
      if (answer === undefined) return { status: "unreachable" };
      if (!answer.ok) return refusal(answer);
      return { status: "read", alerts: readAlerts((answer.json as { alerts?: unknown })?.alerts) };
    },
    async heldMembers() {
      const answer = await send({ method: "GET", path: OWNER_ROUTES.heldMembers, body: "" });
      if (answer === undefined) return { status: "unreachable" };
      if (!answer.ok) return refusal(answer);
      return {
        status: "read",
        members: readHeldMembers((answer.json as { members?: unknown } | undefined)?.members),
      };
    },
    dismissAlert: (alertId) =>
      administration(OWNER_ROUTES.alertDismiss, JSON.stringify({ alertId })),
    removeFromAlert: (alertId) =>
      administration(OWNER_ROUTES.alertRemove, JSON.stringify({ alertId })),
    setConfirmNewMembers: (enabled) =>
      administration(OWNER_ROUTES.confirmNewMembers, JSON.stringify({ enabled })),
    openSession: () =>
      unlocked(async (signer) => {
        const opened = await act(OWNER_ROUTES.session, "", signer);
        if (opened.status !== "done") return opened;
        try {
          session = decodeOwnerAdministrationSession(
            (opened.body as { session?: unknown } | undefined)?.session,
          );
        } catch {
          return { status: "refused", kind: "invalid-answer" };
        }
        // The secret stays in this client; the caller learns only when it ends.
        return { status: "done", body: { expiresAt: session.expiresAt } };
      }),
    endSession: () => {
      session = undefined;
    },
    hasSession: sessionLive,
    readPosture: (subject) => administration(OWNER_ROUTES.postureRead, JSON.stringify({ subject })),
    changePosture: (request) => {
      const body = JSON.stringify(request);
      // Full access is the one posture a session never covers.
      return request.posture === "full-access"
        ? unlocked((signer) => act(OWNER_ROUTES.postureChange, body, signer))
        : administration(OWNER_ROUTES.postureChange, body);
    },
    receiveCredential: (input) =>
      unlocked((signer) => act(OWNER_ROUTES.credentialReceive, JSON.stringify(input), signer)),
    sendCredential: (input) =>
      unlocked((signer) => act(OWNER_ROUTES.credentialCopy, JSON.stringify(input), signer)),
    applyProposal: (offerId, projectId) =>
      administration(
        OWNER_ROUTES.provisionApply,
        JSON.stringify({ offerId, ...(projectId === undefined ? {} : { projectId }) }),
      ),
    dismissProposal: (offerId) =>
      administration(OWNER_ROUTES.provisionDismiss, JSON.stringify({ offerId })),
    confirmNewMember: (member) =>
      unlocked(async (signer) => {
        // The confirmation is its own signature by the unlock key, over the
        // member and key it names, so the spoke can check it against the key it
        // recorded for this owner. The same unlocked key then answers the
        // host's challenge for the action that carries it.
        // Decoding with a stand-in signature brands the ids and checks the shape.
        let unsigned: Omit<NewMemberConfirmation, "signature">;
        try {
          const { signature: _standIn, ...fields } = decodeNewMemberConfirmation({
            spokeId: target.memberId,
            memberId: String(member.memberId),
            identityKeyFingerprint: member.identityKeyFingerprint,
            confirmedBy: identity.memberId,
            unlockKeyFingerprint: await unlockKeyFingerprint(unlock.publicKey),
            confirmedAt: new Date(now()).toISOString(),
            signature: "A",
          });
          unsigned = fields;
        } catch {
          return { status: "refused", kind: "confirmation-invalid" };
        }
        const signed = await signer.sign(newMemberConfirmationSigningPayload(unsigned));
        if (signed.status !== "signed") return { status: "not-unlocked", reason: signed.status };
        return act(
          OWNER_ROUTES.confirmMember,
          JSON.stringify({ ...unsigned, ...signed.value }),
          signer,
        );
      }),
  };
}

/** Refusals that mean the host no longer holds the session this device presented. */
const SESSION_ENDED: ReadonlySet<string> = new Set([
  "no-such-session",
  "session-expired",
  "session-owner-changed",
  "session-wrong-owner",
]);

/**
 * Copies an API-key sign-in from one of the person's computers to another. The
 * person unlocks on each: first the computer that will receive the key, which
 * makes a one-time ticket, then the computer that holds it, which sends the key
 * straight to the first. The key never passes through this device.
 */
export async function copyApiKeySignIn(input: {
  readonly source: Pick<OwnerAdministrationClient, "sendCredential">;
  readonly target: Pick<OwnerAdministrationClient, "receiveCredential">;
  readonly sourceMemberId: string;
  readonly targetMemberId: string;
  readonly credentialName: string;
}): Promise<OwnerActionResult> {
  const ticket = await input.target.receiveCredential({
    sourceMemberId: input.sourceMemberId,
    credentialName: input.credentialName,
  });
  if (ticket.status !== "done") return ticket;
  const ticketId = stringField(ticket.body, "ticketId");
  if (ticketId === undefined) return { status: "refused", kind: "invalid-answer" };
  return input.source.sendCredential({
    targetMemberId: input.targetMemberId,
    credentialName: input.credentialName,
    ticketId,
  });
}

/** SHA-256 of an unlock public key's SubjectPublicKeyInfo, lowercase hex: what a host lists beside the owner's name. */
export async function unlockKeyFingerprint(publicKey: string): Promise<string> {
  return hex(await sha256(base64UrlDecode(publicKey)));
}

function readAlerts(value: unknown): ReadonlyArray<NewMemberAlert> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is NewMemberAlert => {
    return (
      stringField(entry, "alertId") !== undefined &&
      stringField(entry, "memberId") !== undefined &&
      stringField(entry, "name") !== undefined &&
      stringField(entry, "identityKeyFingerprint") !== undefined
    );
  });
}

function readHeldMembers(value: unknown): ReadonlyArray<HeldMember> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is HeldMember => {
    return (
      stringField(entry, "memberId") !== undefined &&
      stringField(entry, "name") !== undefined &&
      stringField(entry, "role") !== undefined &&
      stringField(entry, "identityKeyFingerprint") !== undefined
    );
  });
}

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  "unlock-no-such-challenge":
    "That unlock was already used or never issued. Unlock again for this action.",
  "unlock-expired": "The unlock ran out after 60 seconds. Unlock again.",
  "unlock-wrong-owner": "That unlock was issued to a different device. Unlock again.",
  "unlock-action-mismatch": "That unlock was for a different action. Unlock again.",
  "unlock-signature-invalid":
    "The unlock did not check out against the key this computer recorded for you.",
  "unlock-user-verification-missing":
    "The passkey did not confirm that you were present. Try again.",
  "unlock-required": "This needs a fresh unlock.",
  "own-unlock-required":
    "This needs its own unlock. An open session covers only administration screens.",
  "no-such-session": "That unlock session is over. Unlock again.",
  "session-expired": "The five-minute unlock session is over. Unlock again.",
  "session-owner-changed": "The list of owners changed, so the unlock session ended.",
  "subscription-sign-in":
    "Subscription sign-ins stay on the computer that holds them. Only API keys copy.",
  "no-such-credential": "That computer holds no key under that name.",
  "no-such-provider": "The other computer has no provider by that name to keep the key for.",
  "already-stored": "That computer already holds a key under that name. It is not replaced.",
  "several-keys":
    "That provider holds several keys. Copy them one at a time after removing the rest.",
  "ticket-expired": "The copy was not finished in time. Start it again.",
  "no-such-ticket": "The other computer did not expect that copy. Start it again.",
  "target-unreachable": "The other computer could not be reached.",
  "not-an-owner": "This computer does not list this device as an owner.",
  "owners-not-honored": "This computer does not let owner devices act. Its person can change that.",
  "hub-principal": "The hub cannot act as an owner.",
  "no-such-alert": "That alert is already gone.",
  "not-awaiting-confirmation": "That member is not waiting for confirmation here.",
  "confirmation-invalid": "That confirmation did not check out, so the member stays as it was.",
  "confirmed-by-mismatch": "The confirmation was signed for a different owner.",
  "not-a-spoke": "This computer has not joined a hub.",
  "hub-revoked": "The hub removed this computer.",
  "too-many-challenges": "This computer is busy with other unlocks. Try again in a moment.",
  stale: "This phone's clock is too far from the computer's. Check the time.",
  replayed: "That request was already seen. Try again.",
  "signature-invalid": "The computer did not accept this device's signature.",
  "unknown-sender": "This computer does not know this device.",
};

/** A host's refusal as a plain sentence the person can act on. */
export function describeOwnerRefusal(kind: string): string {
  return REFUSAL_COPY[kind] ?? "The computer refused that.";
}

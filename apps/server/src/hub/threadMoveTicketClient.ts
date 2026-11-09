// The source's half of the move ticket. A move is an owner act on the
// destination, so before anything is frozen this host asks the destination for
// an owner challenge naming the ticket route and its exact body, the person's
// unlock key on this Mac signs it (Touch ID), and this host sends the signed
// ticket request. This host signs both requests with its member identity, so
// the destination honors them only when this Mac is on its own owner list.
//
// Nothing here holds the unlock key: the window asks the desktop to sign, and
// only the signature passes through this host.

import { createHash } from "node:crypto";
import {
  HubMemberId,
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_UNLOCK_HEADER,
  decodeOwnerChallenge,
  type MovedThreadReference,
  type OwnerThreadMoveTicketRequest,
  type OwnerUnlockProof,
  type ThreadMoveChallengeOutcome,
} from "@octant/contracts";
import { Schema } from "effect";
import { sendHubLinkRequest } from "./hubLink";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_OWNER_ROUTES } from "./hubOwnerRoutes";
import type { HubHostIdentity } from "./hubService";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import type { MemberTarget } from "./spokeLinkService";

const TICKET_PATH = HUB_OWNER_ROUTES.threadMoveTicket;
const CHALLENGE_PATH = HUB_OWNER_ROUTES.challenge;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);

export type TicketRedemption =
  | { readonly status: "issued"; readonly ticketId: string }
  | {
      readonly status: "refused";
      readonly reason: "unlock-required" | "refused" | "destination-unreachable";
    };

export interface ThreadMoveTicketClientOptions {
  readonly identity: () => HubHostIdentity;
  readonly target: (memberId: string) => MemberTarget;
  readonly transport: HubTransport;
  readonly now: () => number;
}

export interface ThreadMoveTicketClient {
  /**
   * The destination's challenge for the one ticket request this host will
   * send. Naming threads asks for a batch ticket covering only those.
   */
  readonly challenge: (
    destinationMemberId: string,
    threads?: ReadonlyArray<MovedThreadReference>,
  ) => Promise<ThreadMoveChallengeOutcome>;
  /** Sends the ticket request with the signature the person's unlock made, naming the same threads. */
  readonly redeem: (input: {
    readonly destinationMemberId: string;
    readonly challengeId: string;
    readonly signature: string;
    readonly threads?: ReadonlyArray<MovedThreadReference>;
  }) => Promise<TicketRedemption>;
}

export function createThreadMoveTicketClient(
  options: ThreadMoveTicketClientOptions,
): ThreadMoveTicketClient {
  const send = async (
    destinationMemberId: string,
    path: string,
    body: string,
    headers: Readonly<Record<string, string>>,
  ) => {
    const target = options.target(destinationMemberId);
    if (target.status === "refused") return undefined;
    const origin = memberOrigin(target.member);
    if (origin === undefined) return undefined;
    const identity = options.identity();
    const answer = await sendHubLinkRequest({
      transport: options.transport,
      target: { origin, pin: listenerPinFromDigest(target.member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(target.self),
      recipientMemberId: String(target.member.memberId),
      method: "POST",
      path,
      body,
      headers: { ...headers, [OWNER_IDENTITY_KEY_HEADER]: identity.signing.hostPublicKey },
      now: options.now(),
    });
    if (answer.status === "unreachable") return undefined;
    const reply: unknown = await answer.response.json().catch(() => undefined);
    return {
      httpStatus: answer.response.status,
      self: String(target.self),
      reply: typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : {},
    };
  };

  // The body is the same for the challenge's hash and the request it covers.
  const ticketBody = (
    destinationMemberId: string,
    threads: ReadonlyArray<MovedThreadReference> | undefined,
  ): string | undefined => {
    const target = options.target(destinationMemberId);
    if (target.status === "refused") return undefined;
    const request: OwnerThreadMoveTicketRequest = {
      sourceMemberId: target.self,
      ...(threads === undefined ? {} : { threads }),
    };
    return JSON.stringify(request);
  };

  return {
    challenge: async (destinationMemberId, threads) => {
      const body = ticketBody(destinationMemberId, threads);
      if (body === undefined) return { status: "refused", kind: "destination-unreachable" };
      const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
      const answered = await send(
        destinationMemberId,
        CHALLENGE_PATH,
        JSON.stringify({ method: "POST", path: TICKET_PATH, bodyHash }),
        {},
      );
      if (answered === undefined) return { status: "refused", kind: "destination-unreachable" };
      let challenge;
      try {
        challenge = decodeOwnerChallenge(answered.reply.challenge);
      } catch {
        // A host that does not list this Mac as an owner refuses before it
        // issues anything: the person is told to mark it there.
        return { status: "refused", kind: ownerRefusal(answered.reply.kind) };
      }
      return {
        status: "challenge",
        challenge: {
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          hostMemberId: decodeMemberId(destinationMemberId),
          ownerMemberId: decodeMemberId(answered.self),
          method: "POST",
          path: TICKET_PATH,
          bodyHash,
          expiresAt: challenge.expiresAt,
        },
      };
    },
    redeem: async ({ destinationMemberId, challengeId, signature, threads }) => {
      const body = ticketBody(destinationMemberId, threads);
      if (body === undefined) return { status: "refused", reason: "destination-unreachable" };
      const proof: OwnerUnlockProof = { shape: "raw", challengeId, signature };
      const answered = await send(destinationMemberId, TICKET_PATH, body, {
        [OWNER_UNLOCK_HEADER]: Buffer.from(JSON.stringify(proof), "utf8").toString("base64url"),
      });
      if (answered === undefined) return { status: "refused", reason: "destination-unreachable" };
      const ticketId = answered.reply.ticketId;
      if (answered.reply.status === "issued" && typeof ticketId === "string") {
        return { status: "issued", ticketId };
      }
      // A declined, expired, or mismatched unlock is refused by the owner check.
      return { status: "refused", reason: ownerRefusal(answered.reply.kind) };
    },
  };
}

/**
 * The owner check's refusals, as a move reports them: an unlock that is
 * missing, expired, or not this host's owner is `unlock-required`; Owners
 * unticked and every other refusal read the same as a refused offer.
 */
function ownerRefusal(kind: unknown): "unlock-required" | "refused" {
  if (typeof kind !== "string") return "refused";
  return kind === "not-an-owner" ||
    kind === "identity-mismatch" ||
    kind === "unknown-sender" ||
    kind.startsWith("unlock-") ||
    kind === "own-unlock-required"
    ? "unlock-required"
    : "refused";
}

// Copying an API-key sign-in from one of the person's computers to another.
// Both hosts keep their own owner list, so the owner device unlocks on each
// (an own-unlock action): the receiving host makes a one-time ticket naming the
// sending host and the sign-in, then the sending host reads the key from its
// credential broker and hands it to the receiving host over the pinned member
// link against that ticket. The receiving host stores it through its own
// broker. The value exists only inside these calls: it is never journaled,
// logged, or returned to the owner device, and no agent has a path to either
// broker through here. A subscription sign-in held by a provider's own app is
// refused, because its terms and token binding are not checked.

import { randomUUID } from "node:crypto";
import {
  HubMemberId,
  decodeCredentialTransfer,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
} from "@octant/contracts";
import { Schema } from "effect";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import { listenerPinFromDigest } from "./hubCrypto";
import type { HubHostIdentity } from "./hubService";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import type { MemberTarget, PeerRequestOutcome } from "./spokeLinkService";

export const PEER_CREDENTIAL_ROUTE = "/api/hub/peer/credentials";

/** A receive ticket outlives one unlock, because the person unlocks on the second host next. */
export const CREDENTIAL_TICKET_LIFETIME_MS = 120_000;
const MAX_OPEN_TICKETS = 16;

export type CredentialReadResult =
  | { readonly status: "found"; readonly value: string }
  | {
      readonly status: "refused";
      readonly kind: "no-such-credential" | "subscription-sign-in" | "several-keys" | "unavailable";
    };

export type CredentialStoreResult =
  | { readonly status: "stored" }
  | {
      readonly status: "refused";
      readonly kind: "no-such-provider" | "subscription-sign-in" | "already-stored" | "unavailable";
    };

/** This host's credential broker, seen only as far as a sign-in copy needs. */
export interface CredentialCopyBroker {
  readonly read: (credentialName: string) => Promise<CredentialReadResult>;
  readonly store: (credentialName: string, value: string) => Promise<CredentialStoreResult>;
}

/** Every reason a sign-in copy comes to nothing; a refusal a peer sends back is read against this list. */
const CREDENTIAL_COPY_REFUSAL_KINDS = [
  "not-a-spoke",
  "hub-revoked",
  "not-in-roster",
  "missing",
  "malformed",
  "stale",
  "unknown-sender",
  "key-mismatch",
  "signature-invalid",
  "replayed",
  "hub-cannot-delegate",
  "no-peer-grant",
  "not-a-spoke-member",
  "target-unreachable",
  "too-many-tickets",
  "no-such-ticket",
  "ticket-expired",
  "ticket-mismatch",
  "owner-no-longer-listed",
  "invalid",
  "peer-refused",
  "no-such-credential",
  "no-such-provider",
  "subscription-sign-in",
  "several-keys",
  "already-stored",
  "unavailable",
] as const;
export type CredentialCopyRefusalKind = (typeof CREDENTIAL_COPY_REFUSAL_KINDS)[number];

export type CredentialCopyOutcome =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly kind: CredentialCopyRefusalKind };

export type TicketOutcome =
  | { readonly status: "issued"; readonly ticketId: string; readonly expiresAt: number }
  | { readonly status: "refused"; readonly kind: CredentialCopyRefusalKind };

interface Ticket {
  readonly ownerMemberId: string;
  readonly sourceMemberId: string;
  readonly credentialName: string;
  readonly expiresAt: number;
}

export interface OwnerCredentialCopyOptions {
  readonly broker: CredentialCopyBroker;
  readonly identity: () => HubHostIdentity;
  readonly target: (memberId: string) => MemberTarget;
  readonly transport: HubTransport;
  /** Authenticates the sending host's signed request against the held roster. */
  readonly authenticate: (request: {
    readonly header: string | null;
    readonly publicKey: string | null;
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }) => PeerRequestOutcome;
  /** Whether this host still lists the owner as an owner device that is not revoked. */
  readonly ownerIsCurrent: (ownerMemberId: string) => boolean;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  readonly uuid?: () => string;
}

export class OwnerCredentialCopyService {
  readonly #options: OwnerCredentialCopyOptions;
  readonly #tickets = new Map<string, Ticket>();

  constructor(options: OwnerCredentialCopyOptions) {
    this.#options = options;
  }

  /** The receiving host's half: an owner device, unlocked here, lets one named host send one named sign-in. */
  issueTicket(input: {
    readonly ownerMemberId: string;
    readonly sourceMemberId: string;
    readonly credentialName: string;
    readonly principal: AuditActingPrincipal;
  }): TicketOutcome {
    const now = this.#options.now();
    this.#forgetExpired(now);
    const source = this.#options.target(input.sourceMemberId);
    if (source.status === "refused") return { status: "refused", kind: source.kind };
    if (source.member.role !== "spoke") return { status: "refused", kind: "not-a-spoke-member" };
    if (this.#tickets.size >= MAX_OPEN_TICKETS) {
      return { status: "refused", kind: "too-many-tickets" };
    }
    const ticketId = (this.#options.uuid ?? randomUUID)();
    const expiresAt = now + CREDENTIAL_TICKET_LIFETIME_MS;
    this.#tickets.set(ticketId, {
      ownerMemberId: input.ownerMemberId,
      sourceMemberId: input.sourceMemberId,
      credentialName: input.credentialName,
      expiresAt,
    });
    this.#options.record({
      change: "credential-ticket-issued",
      actingPrincipal: input.principal,
      memberId: source.member.memberId,
      credentialName: input.credentialName,
    });
    return { status: "issued", ticketId, expiresAt };
  }

  /** The sending host's half: read the key from this broker and hand it to the receiving host against its ticket. */
  async send(input: {
    readonly targetMemberId: string;
    readonly credentialName: string;
    readonly ticketId: string;
    readonly principal: AuditActingPrincipal;
  }): Promise<CredentialCopyOutcome> {
    const refuse = (kind: CredentialCopyRefusalKind): CredentialCopyOutcome => {
      this.#options.record({
        change: "credential-copy-refused",
        actingPrincipal: input.principal,
        memberId: decodeMemberId(input.targetMemberId),
        credentialName: input.credentialName,
        credentialReason: kind,
      });
      return { status: "refused", kind };
    };
    const target = this.#options.target(input.targetMemberId);
    if (target.status === "refused") return refuse(target.kind);
    if (target.member.role !== "spoke") return refuse("not-a-spoke-member");
    const origin = memberOrigin(target.member);
    if (origin === undefined) return refuse("target-unreachable");

    const read = await this.#options.broker.read(input.credentialName);
    if (read.status === "refused") return refuse(read.kind);

    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin, pin: listenerPinFromDigest(target.member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(target.self),
      recipientMemberId: String(target.member.memberId),
      method: "POST",
      path: PEER_CREDENTIAL_ROUTE,
      body: JSON.stringify({
        ticketId: input.ticketId,
        credentialName: input.credentialName,
        value: read.value,
      }),
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return refuse("target-unreachable");
    const reply = await answer.response.json().catch(() => undefined);
    if (answer.response.ok && statusOf(reply) === "stored") {
      this.#options.record({
        change: "credential-copy-sent",
        actingPrincipal: input.principal,
        memberId: target.member.memberId,
        credentialName: input.credentialName,
      });
      return { status: "ok" };
    }
    return refuse(kindOf(reply));
  }

  /** The receiving host's reception of a key: the ticket, not the sender, is what this host's owner authorized. */
  async receive(request: {
    readonly header: string | null;
    readonly publicKey: string | null;
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }): Promise<CredentialCopyOutcome> {
    const authenticated = this.#options.authenticate(request);
    if (authenticated.status === "refused") {
      return { status: "refused", kind: authenticated.kind };
    }
    if (authenticated.peer.member.role !== "spoke") {
      return { status: "refused", kind: "not-a-spoke-member" };
    }
    let transfer: ReturnType<typeof decodeCredentialTransfer>;
    try {
      transfer = decodeCredentialTransfer(JSON.parse(request.body));
    } catch {
      return { status: "refused", kind: "invalid" };
    }
    // The ticket is single-use: it is gone once any request answers it.
    const ticket = this.#tickets.get(transfer.ticketId);
    this.#tickets.delete(transfer.ticketId);
    const sourceMemberId = String(authenticated.peer.member.memberId);
    const principal: AuditActingPrincipal | undefined =
      ticket === undefined
        ? undefined
        : { kind: "owner-unlock", memberId: decodeMemberId(ticket.ownerMemberId) };
    const refuse = (kind: CredentialCopyRefusalKind): CredentialCopyOutcome => {
      this.#options.record({
        change: "credential-copy-refused",
        actingPrincipal: principal ?? authenticated.principal,
        memberId: authenticated.peer.member.memberId,
        credentialName: transfer.credentialName,
        credentialReason: kind,
      });
      return { status: "refused", kind };
    };
    if (ticket === undefined || principal === undefined) return refuse("no-such-ticket");
    if (this.#options.now() > ticket.expiresAt) return refuse("ticket-expired");
    if (
      ticket.sourceMemberId !== sourceMemberId ||
      ticket.credentialName !== transfer.credentialName
    ) {
      return refuse("ticket-mismatch");
    }
    if (!this.#options.ownerIsCurrent(ticket.ownerMemberId)) {
      return refuse("owner-no-longer-listed");
    }
    const stored = await this.#options.broker.store(transfer.credentialName, transfer.value);
    if (stored.status === "refused") return refuse(stored.kind);
    this.#options.record({
      change: "credential-copy-received",
      actingPrincipal: principal,
      memberId: authenticated.peer.member.memberId,
      credentialName: transfer.credentialName,
    });
    return { status: "ok" };
  }

  #forgetExpired(now: number): void {
    for (const [ticketId, ticket] of this.#tickets) {
      if (ticket.expiresAt < now) this.#tickets.delete(ticketId);
    }
  }
}

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);

function statusOf(reply: unknown): string | undefined {
  if (typeof reply !== "object" || reply === null) return undefined;
  const status = (reply as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

function kindOf(reply: unknown): CredentialCopyRefusalKind {
  if (typeof reply !== "object" || reply === null) return "peer-refused";
  const kind = (reply as { kind?: unknown }).kind;
  return CREDENTIAL_COPY_REFUSAL_KINDS.find((known) => known === kind) ?? "peer-refused";
}

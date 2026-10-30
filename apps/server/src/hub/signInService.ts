// Hub-started sign-in from the hub's side. A person on the hub's own window (or
// an owner device after its unlock) asks one spoke to sign in to a provider
// account. The hub relays the request over the pinned member link and keeps one
// word about it: still asked, the outcome word the spoke reported, or why the
// spoke refused. The hub never signs in for a spoke, never sees a code, an
// address, or an account name, and starts nothing: the spoke's person decides,
// and the provider's own sign-in runs on the spoke.

import { randomUUID } from "node:crypto";
import {
  HubMemberId,
  HubSignInReason,
  HubSignInRequestId,
  UtcTimestamp,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubSignInAsk,
  type HubSignInHubEntry,
  type HubSignInOutcomeReport,
  type RosterMember,
} from "@octant/contracts";
import { Schema } from "effect";
import { listenerPinFromDigest } from "./hubCrypto";
import { sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort, SignInAskRecord } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";

const decodeRequestId = Schema.decodeUnknownSync(HubSignInRequestId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const isReason = Schema.is(HubSignInReason);
/** The hub keeps this many requests; asking past it forgets the oldest. */
const MAX_ASKS = 64;

export interface SignInServiceOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  readonly newRequestId?: () => string;
}

export type AskOutcome =
  | { readonly status: "asked"; readonly requestId: HubSignInRequestId }
  | { readonly status: "refused"; readonly kind: HubSignInReason };

export type OutcomeReceipt =
  | { readonly status: "recorded" }
  | { readonly status: "refused"; readonly kind: "hub-role-off" | "unknown-request" };

const isSpoke = (member: RosterMember) => member.role === "spoke" || member.role === "standby-hub";

export class SignInService {
  readonly #options: SignInServiceOptions;

  constructor(options: SignInServiceOptions) {
    this.#options = options;
  }

  /** The latest request to each member and kind, newest first. */
  status(): ReadonlyArray<HubSignInHubEntry> {
    const asks = this.#options.state.load().hub?.signIn?.asks ?? [];
    const latest = new Map<string, SignInAskRecord>();
    for (const ask of asks) latest.set(`${String(ask.memberId)}:${ask.kind}`, ask);
    return [...latest.values()]
      .sort((a, b) => b.askedAtMs - a.askedAtMs)
      .map((ask) => ({
        memberId: ask.memberId,
        requestId: ask.requestId,
        kind: ask.kind,
        askedAt: decodeTimestamp(new Date(ask.askedAtMs).toISOString()),
        result:
          ask.refused !== undefined
            ? { refused: ask.refused }
            : (ask.outcome ?? ("asked" as const)),
      }));
  }

  /**
   * Relays one request to one spoke. Reaching the spoke is not the spoke taking
   * it: the spoke answers for itself, and a refusal is kept as its reason word.
   */
  async ask(request: HubSignInAsk, principal: AuditActingPrincipal): Promise<AskOutcome> {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true || hub.roster === undefined) {
      return { status: "refused", kind: "hub-role-off" };
    }
    const member = hub.roster.roster.members.find(
      (entry) => String(entry.memberId) === String(request.memberId),
    );
    if (member === undefined || !isSpoke(member)) {
      return { status: "refused", kind: "unknown-member" };
    }
    const requestId = decodeRequestId((this.#options.newRequestId ?? randomUUID)());
    const asked: SignInAskRecord = {
      memberId: request.memberId,
      requestId,
      kind: request.kind,
      askedAtMs: this.#options.now(),
    };
    // Held before it is sent, because a quick person on the spoke can answer before this call returns.
    this.#save(asked);
    this.#options.record({
      change: "sign-in-asked",
      actingPrincipal: principal,
      memberId: request.memberId,
      signInRequestId: requestId,
      signInKind: request.kind,
    });
    const origin =
      hub.members.find((entry) => String(entry.memberId) === String(member.memberId))
        ?.listenerOrigin ?? memberOrigin(member);
    if (origin === undefined) return this.#refuse(asked, principal, "unreachable");
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(identity.hostId),
      recipientMemberId: String(member.memberId),
      method: "POST",
      path: "/api/hub/sign-in-request",
      body: JSON.stringify({ requestId, kind: request.kind }),
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return this.#refuse(asked, principal, "unreachable");
    if (answer.response.ok) return { status: "asked", requestId };
    return this.#refuse(asked, principal, await refusalReason(answer.response));
  }

  /**
   * A spoke tells the hub how a request it accepted or let lapse ended. Only
   * the member the request was sent to can end it, and only once: a repeat of
   * the same word is accepted so a spoke can retry a report whose answer was lost.
   */
  receiveOutcome(senderMemberId: string, report: HubSignInOutcomeReport): OutcomeReceipt {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    const ask = (hub.signIn?.asks ?? []).find(
      (entry) =>
        String(entry.requestId) === String(report.requestId) &&
        String(entry.memberId) === senderMemberId &&
        entry.refused === undefined,
    );
    if (ask === undefined) return { status: "refused", kind: "unknown-request" };
    if (ask.outcome !== undefined && ask.outcome !== report.outcome) {
      return { status: "refused", kind: "unknown-request" };
    }
    if (ask.outcome === undefined) {
      this.#save({ ...ask, outcome: report.outcome });
      this.#options.record({
        change: "sign-in-outcome-received",
        actingPrincipal: { kind: "hub", memberId: decodeMemberId(senderMemberId) },
        memberId: ask.memberId,
        signInRequestId: ask.requestId,
        signInKind: ask.kind,
        signInOutcome: report.outcome,
      });
    }
    return { status: "recorded" };
  }

  #refuse(
    ask: SignInAskRecord,
    principal: AuditActingPrincipal,
    kind: HubSignInReason,
  ): AskOutcome {
    this.#save({ ...ask, refused: kind });
    this.#options.record({
      change: "sign-in-ask-refused",
      actingPrincipal: principal,
      memberId: ask.memberId,
      signInRequestId: ask.requestId,
      signInKind: ask.kind,
      signInReason: kind,
    });
    return { status: "refused", kind };
  }

  #save(ask: SignInAskRecord): void {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub === undefined) return;
    const asks = hub.signIn?.asks ?? [];
    const known = asks.some((entry) => String(entry.requestId) === String(ask.requestId));
    this.#options.state.save({
      ...state,
      hub: {
        ...hub,
        signIn: {
          asks: (known
            ? asks.map((entry) => (String(entry.requestId) === String(ask.requestId) ? ask : entry))
            : [...asks, ask]
          ).slice(-MAX_ASKS),
        },
      },
    });
  }
}

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);

/** The spoke's own word for why it did not take the request. */
async function refusalReason(response: Response): Promise<HubSignInReason> {
  try {
    const body: unknown = await response.json();
    const kind = typeof body === "object" && body !== null && "kind" in body ? body.kind : "";
    if (isReason(kind)) return kind;
  } catch {
    // An answer that is not JSON is a refusal without a reason.
  }
  return "answer-refused";
}

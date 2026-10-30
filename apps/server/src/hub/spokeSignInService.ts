// Hub-started sign-in from a spoke's side. The hub asks; this spoke's person
// answers. A request is held only if the person ticked Sign-in for the hub, and
// nothing starts until a person in this spoke's own window (or this spoke's own
// unlocked owner device) accepts. Accepting shows the provider's own sign-in
// command on this spoke, which the person runs in a terminal here: the code or
// address the provider prints appears only in that terminal, and no token,
// code, address, or account name ever passes through this service or goes back
// to the hub. The hub is told one word when the request ends.

import {
  HUB_SIGN_IN_LIFETIME_MS,
  UtcTimestamp,
  type AuditActingPrincipal,
  type HubMemberId,
  type HubMembershipChangedPayload,
  type HubSignInDelivery,
  type HubSignInKind,
  type HubSignInOutcome,
  type HubSignInReason,
  type HubSignInRequestId,
  type HubSignInRequestView,
} from "@octant/contracts";
import { decideSignInAdmission, isHubSignInKind, settleSignInRequests } from "@octant/domain";
import { Schema } from "effect";
import { listenerPinFromDigest } from "./hubCrypto";
import { sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type {
  HubLinkState,
  HubStatePort,
  SignInRequestRecord,
  SpokeSignInState,
} from "./hubStateStore";
import type { HubTransport } from "./pinnedHubTransport";
import type { SpokeLinkService } from "./spokeLinkService";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const HOUR_MS = 60 * 60_000;
const MAX_REQUESTS = 8;
/** More arrivals than the hourly limit are kept only to hold a flood off; the oldest go first. */
const MAX_ARRIVALS = 32;

/** What this host can say about a provider account, as the provider's own app holds it. */
export type SignInAccountState = "signed-in" | "signed-out" | "unavailable";

/**
 * What this host does for a kind of request. It only reads: whether the
 * provider's own app holds a sign-in. It never runs a sign-in and never reads a
 * token, so a spoke without a provider for the kind reports `unavailable`.
 */
export interface SignInHostPorts {
  readonly accountState: (kind: HubSignInKind) => Promise<SignInAccountState>;
}

/** The provider's own sign-in command, in plain words, for each kind. */
const GUIDANCE: Readonly<Record<HubSignInKind, string>> = {
  "claude-subscription":
    "Open a terminal on this computer and run claude auth login. Finish the sign-in there, then choose Check sign-in.",
  "codex-subscription":
    "Open a terminal on this computer and run codex login. Finish the sign-in there, then choose Check sign-in.",
};

export interface SpokeSignInOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly spoke: Pick<SpokeLinkService, "hubMayUse">;
  readonly ports: SignInHostPorts;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
}

type Unavailable = "not-a-spoke" | "hub-revoked";

export type SignInReceipt =
  | { readonly status: "asked" }
  | { readonly status: "refused"; readonly kind: Unavailable | HubSignInReason };

export type SignInDecision =
  | { readonly status: "accepted"; readonly guidance: string }
  | { readonly status: "declined" }
  | { readonly status: "refused"; readonly kind: Unavailable | HubSignInReason };

export type SignInCheck =
  | { readonly status: "pending" }
  | { readonly status: "ended"; readonly outcome: HubSignInOutcome }
  | { readonly status: "refused"; readonly kind: Unavailable | HubSignInReason };

export interface SpokeSignInView {
  /** Whether this spoke's hub grant ticks Sign-in, which is the only reason it keeps a request. */
  readonly accepting: boolean;
  readonly requests: ReadonlyArray<HubSignInRequestView>;
}

/** Who a lapsed request, or one dropped when the grant was unticked, is journaled under: this spoke's own window. */
const WINDOW: AuditActingPrincipal = { kind: "local-window" };

export class SpokeSignInService {
  readonly #options: SpokeSignInOptions;
  #flushing = false;

  constructor(options: SpokeSignInOptions) {
    this.#options = options;
  }

  view(): SpokeSignInView {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true) return { accepting: false, requests: [] };
    this.#settle();
    return {
      accepting: this.#granted(),
      requests: (this.#options.state.load().link?.signIn?.requests ?? []).map((request) => ({
        requestId: request.requestId,
        kind: request.kind,
        state: request.state,
        receivedAt: decodeTimestamp(new Date(request.receivedAtMs).toISOString()),
        expiresAt: decodeTimestamp(new Date(request.expiresAtMs).toISOString()),
        ...(request.state === "accepted" ? { guidance: GUIDANCE[request.kind] } : {}),
      })),
    };
  }

  /**
   * The hub's request, already authenticated as the hub's. This decides whether
   * it is a question for the person at all. It starts nothing and shows nothing
   * but the request itself.
   */
  async receive(sender: HubMemberId, delivery: HubSignInDelivery): Promise<SignInReceipt> {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    this.#settle();
    const principal: AuditActingPrincipal = { kind: "hub", memberId: sender };
    const granted = this.#granted();
    const now = this.#options.now();
    const current = this.#options.state.load().link?.signIn;
    const recent = (current?.arrivedAtMs ?? []).filter((at) => at > now - HOUR_MS);
    // The account is read only for a hub that may ask, so a hub without the item learns nothing of it.
    const kind = delivery.kind;
    const account: SignInAccountState =
      granted && isHubSignInKind(kind) ? await this.#accountState(kind) : "unavailable";
    const decision = decideSignInAdmission({
      granted,
      kind,
      supportedKinds: account === "unavailable" || !isHubSignInKind(kind) ? [] : [kind],
      recentRequests: recent.length,
      alreadyAsked: (current?.requests ?? []).some(
        (request) => request.kind === kind || String(request.requestId) === delivery.requestId,
      ),
      signedIn: account === "signed-in",
    });
    if (decision.status === "refuse") {
      // A refusal after the grant counts toward the hour, so asking cannot be used to probe.
      if (decision.kind !== "sign-in-not-granted" && decision.kind !== "unknown-kind") {
        this.#update((state) => ({ ...state, arrivedAtMs: [...recent, now].slice(-MAX_ARRIVALS) }));
      }
      this.#journal(
        "sign-in-refused",
        principal,
        delivery.requestId,
        isHubSignInKind(kind) ? kind : undefined,
        {
          reason: decision.kind,
        },
      );
      return { status: "refused", kind: decision.kind };
    }
    this.#update((state) => ({
      ...state,
      arrivedAtMs: [...recent, now].slice(-MAX_ARRIVALS),
      requests: [
        ...state.requests,
        {
          requestId: delivery.requestId,
          kind: decision.kind,
          receivedAtMs: now,
          expiresAtMs: now + HUB_SIGN_IN_LIFETIME_MS,
          state: "asked" as const,
        },
      ].slice(-MAX_REQUESTS),
    }));
    this.#journal("sign-in-requested", principal, delivery.requestId, decision.kind, {});
    return { status: "asked" };
  }

  /** The person accepting in this spoke's window, or this spoke's owner device after its unlock. */
  accept(requestId: HubSignInRequestId, principal: AuditActingPrincipal): SignInDecision {
    const found = this.#open(requestId);
    if (found.status === "refused") return found;
    const { request } = found;
    if (request.state === "asked") {
      this.#update((state) => ({
        ...state,
        requests: state.requests.map((entry) =>
          entry.requestId === request.requestId ? { ...entry, state: "accepted" as const } : entry,
        ),
      }));
      this.#journal("sign-in-accepted", principal, request.requestId, request.kind, {});
    }
    return { status: "accepted", guidance: GUIDANCE[request.kind] };
  }

  async decline(
    requestId: HubSignInRequestId,
    principal: AuditActingPrincipal,
  ): Promise<SignInDecision> {
    const found = this.#open(requestId);
    if (found.status === "refused") return found;
    this.#end(found.request, "declined", principal);
    await this.tick();
    return { status: "declined" };
  }

  /**
   * Asks the provider's own app whether the sign-in now exists. A request not
   * yet accepted is not checked: nothing is read about an account the person
   * has not agreed to sign in.
   */
  async check(
    requestId: HubSignInRequestId,
    principal: AuditActingPrincipal,
  ): Promise<SignInCheck> {
    const found = this.#open(requestId);
    if (found.status === "refused") return found;
    const { request } = found;
    if (request.state !== "accepted") return { status: "refused", kind: "not-accepted-yet" };
    const account = await this.#accountState(request.kind);
    if (account === "signed-out") return { status: "pending" };
    const outcome: HubSignInOutcome = account === "signed-in" ? "signed-in" : "failed";
    this.#end(request, outcome, principal);
    await this.tick();
    return { status: "ended", outcome };
  }

  /** Lets lapsed requests end and tells the hub any outcome word it has not yet been told. */
  async tick(): Promise<void> {
    if (this.#options.state.load().link === undefined) return;
    this.#settle();
    await this.#flush();
  }

  #open(
    requestId: HubSignInRequestId,
  ):
    | { readonly status: "open"; readonly request: SignInRequestRecord }
    | { readonly status: "refused"; readonly kind: Unavailable | HubSignInReason } {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    this.#settle();
    const request = this.#options.state
      .load()
      .link?.signIn?.requests.find((entry) => entry.requestId === requestId);
    return request === undefined
      ? { status: "refused", kind: "unknown-request" }
      : { status: "open", request };
  }

  async #accountState(kind: HubSignInKind): Promise<SignInAccountState> {
    try {
      return await this.#options.ports.accountState(kind);
    } catch {
      return "unavailable";
    }
  }

  #granted(): boolean {
    return this.#options.spoke.hubMayUse("sign-in").status === "allowed";
  }

  /**
   * Ends requests that lapsed, and every request once the person no longer
   * ticks Sign-in: what the hub may ask is the grant's to say, not the moment
   * the request arrived.
   */
  #settle(): void {
    const requests = this.#options.state.load().link?.signIn?.requests ?? [];
    if (requests.length === 0) return;
    const granted = this.#granted();
    const { expired } = settleSignInRequests(requests, this.#options.now());
    for (const request of granted ? expired : requests) {
      this.#end(request, granted ? "expired" : "declined", WINDOW);
    }
  }

  /** Removes a request, journals how it ended, and queues the one word for the hub. */
  #end(
    request: SignInRequestRecord,
    outcome: HubSignInOutcome,
    principal: AuditActingPrincipal,
  ): void {
    this.#update((state) => ({
      ...state,
      requests: state.requests.filter((entry) => entry.requestId !== request.requestId),
      unreported: [...state.unreported, { requestId: request.requestId, outcome }],
    }));
    this.#journal(
      outcome === "declined" ? "sign-in-declined" : "sign-in-ended",
      principal,
      request.requestId,
      request.kind,
      { outcome },
    );
  }

  async #flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      const link = this.#options.state.load().link;
      if (link === undefined || link.removed === true) return;
      for (const report of link.signIn?.unreported ?? []) {
        const sent = await this.#report(link, report);
        if (sent) {
          this.#update((state) => ({
            ...state,
            unreported: state.unreported.filter((entry) => entry.requestId !== report.requestId),
          }));
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  /** Whether the word is settled: the hub took it, or answered that it does not know the request. */
  async #report(
    link: HubLinkState,
    report: { readonly requestId: HubSignInRequestId; readonly outcome: HubSignInOutcome },
  ): Promise<boolean> {
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(link.selfMemberId),
      recipientMemberId: String(link.hubMemberId),
      method: "POST",
      path: "/api/hub/sign-in-outcome",
      body: JSON.stringify({ requestId: report.requestId, outcome: report.outcome }),
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return false;
    return answer.response.ok || answer.response.status === 403;
  }

  #update(change: (current: SpokeSignInState) => SpokeSignInState): void {
    const state = this.#options.state.load();
    if (state.link === undefined) return;
    this.#options.state.save({
      ...state,
      link: {
        ...state.link,
        signIn: change(state.link.signIn ?? { requests: [], arrivedAtMs: [], unreported: [] }),
      },
    });
  }

  #journal(
    change: HubMembershipChangedPayload["change"],
    principal: AuditActingPrincipal,
    requestId: string,
    kind: HubSignInKind | undefined,
    extra: { readonly reason?: HubSignInReason; readonly outcome?: HubSignInOutcome },
  ): void {
    this.#options.record({
      change,
      actingPrincipal: principal,
      signInRequestId: requestId,
      ...(kind === undefined ? {} : { signInKind: kind }),
      ...(extra.reason === undefined ? {} : { signInReason: extra.reason }),
      ...(extra.outcome === undefined ? {} : { signInOutcome: extra.outcome }),
    });
  }
}

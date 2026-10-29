// Push through the hub from a spoke's side. A spoke whose hub grant ticks Push
// hands the hub each sealed delivery request it has already signed with its own
// host key, instead of calling the push gateway itself. It follows the roster it
// holds to find who to hand it to: the hub, or a standby that stands in only
// where the person ticked Standby too and only while the hub cannot be reached.
// When the hub is unreachable or refuses, the caller falls back to the gateway
// itself. The hub or a standby asks the spoke, before it forwards anything,
// whether the grant still stands; the spoke is the only one who knows.

import {
  decodeHubPushAnswer,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubMemberId,
  type HubPushAnswer,
  type HubPushHandoff,
  type HubPushReason,
} from "@octant/contracts";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubLinkState, HubStatePort } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import { handoffTimeoutMs } from "./pushService";
import type { SpokeLinkService } from "./spokeLinkService";

export interface SpokePushOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly spoke: Pick<SpokeLinkService, "hubMayUse">;
  /** Whether this spoke has not reached the hub for the failover time; a standby is handed a request only then. */
  readonly hubUnreachable: () => Promise<boolean>;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  /** The timeout of an ordinary hub-link request, from which the hand-off timeout follows. */
  readonly linkTimeoutMs?: number;
}

export type PushHandoffResult =
  | { readonly status: "forwarded"; readonly answer: HubPushAnswer }
  /** This spoke does not hand its notifications on right now; it sends them itself. */
  | { readonly status: "not-handed"; readonly reason: "not-granted" | "no-coordinator" }
  | { readonly status: "unreachable" }
  /** The hub, or the standby, answered and refused; `kind` is its own word, journaled there. */
  | { readonly status: "declined"; readonly kind: string };

/** Who asked a spoke whether its grant ticks Push, once the signature and the roster said so. */
export type PushGrantAsker =
  | { readonly kind: "hub"; readonly memberId: HubMemberId }
  | { readonly kind: "standby"; readonly memberId: HubMemberId };

export type PushGrantCheckResult =
  | { readonly status: "granted" }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-a-spoke"
        | "hub-revoked"
        | "push-not-granted"
        | "standby-not-granted"
        | "hub-reachable";
    };

export class SpokePushService {
  readonly #options: SpokePushOptions;

  constructor(options: SpokePushOptions) {
    this.#options = options;
  }

  /** Whether this spoke's hub grant ticks Push, which is the only reason it hands a notification on. */
  granted(): boolean {
    const link = this.#options.state.load().link;
    // A standing-in standby is the sender: it has no hub to hand to.
    return (
      link !== undefined &&
      link.removed !== true &&
      link.standIn === undefined &&
      this.#options.spoke.hubMayUse("push").status === "allowed"
    );
  }

  /** Hands one signed delivery request to the hub, or to the standby this spoke follows. */
  async hand(delivery: HubPushHandoff): Promise<PushHandoffResult> {
    const link = this.#options.state.load().link;
    if (link === undefined || !this.granted())
      return { status: "not-handed", reason: "not-granted" };
    const target = coordinator(link);
    if (target === undefined) return { status: "not-handed", reason: "no-coordinator" };
    if (target.kind === "standby") {
      // A standby forwards for this spoke only where its person ticked Standby, and only while the hub is out of reach.
      if (this.#options.spoke.hubMayUse("standby").status === "refused") {
        return { status: "not-handed", reason: "not-granted" };
      }
      if (!(await this.#options.hubUnreachable())) {
        return { status: "not-handed", reason: "no-coordinator" };
      }
    }
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin: target.origin, pin: listenerPinFromDigest(target.pin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(link.selfMemberId),
      recipientMemberId: target.memberId,
      method: "POST",
      path: "/api/hub/push",
      body: JSON.stringify(delivery),
      // A hub that never held this key (a promoted standby) checks it against the roster.
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
      // The hub waits on this spoke (to confirm the grant) and then on the gateway before it answers.
      timeoutMs: handoffTimeoutMs(this.#options.linkTimeoutMs),
    });
    if (answer.status === "unreachable") return { status: "unreachable" };
    if (!answer.response.ok) {
      return { status: "declined", kind: await declinedKind(answer.response) };
    }
    try {
      return { status: "forwarded", answer: decodeHubPushAnswer(await answer.response.json()) };
    } catch {
      return { status: "declined", kind: "answer-invalid" };
    }
  }

  /**
   * The hub, or a standby standing in, asks whether it may forward this spoke's
   * notifications. The sender is already authenticated; this answers from the
   * spoke's own grant. A standby must also be one this spoke let stand in, and
   * only counts while this spoke cannot reach the hub.
   */
  async checkGrant(asker: PushGrantAsker): Promise<PushGrantCheckResult> {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const principal: AuditActingPrincipal = { kind: "hub", memberId: asker.memberId };
    const refuse = (
      kind: "push-not-granted" | "standby-not-granted" | "hub-reachable",
    ): PushGrantCheckResult => {
      this.#journalRefusal(principal, asker.memberId, kind);
      return { status: "refused", kind };
    };
    if (this.#options.spoke.hubMayUse("push").status === "refused")
      return refuse("push-not-granted");
    if (asker.kind === "standby") {
      if (this.#options.spoke.hubMayUse("standby").status === "refused") {
        return refuse("standby-not-granted");
      }
      if (!(await this.#options.hubUnreachable())) return refuse("hub-reachable");
    }
    return { status: "granted" };
  }

  #journalRefusal(
    principal: AuditActingPrincipal,
    memberId: HubMemberId,
    reason: HubPushReason,
  ): void {
    this.#options.record({
      change: "push-refused",
      actingPrincipal: principal,
      memberId,
      pushReason: reason,
    });
  }
}

/** Who to hand to: the hub, or the standby whose roster this spoke follows because it could not reach the hub. */
function coordinator(link: HubLinkState):
  | {
      readonly kind: "hub" | "standby";
      readonly memberId: string;
      readonly origin: string;
      readonly pin: string;
    }
  | undefined {
  const signer = link.roster.signedBy;
  if (signer.kind === "standby") {
    const entry = link.roster.roster.members.find(
      (member) => String(member.memberId) === String(signer.memberId),
    );
    const origin = entry === undefined ? undefined : memberOrigin(entry);
    return entry === undefined || origin === undefined
      ? undefined
      : { kind: "standby", memberId: String(entry.memberId), origin, pin: entry.listenerPin };
  }
  return {
    kind: "hub",
    memberId: String(link.hubMemberId),
    origin: link.hubOrigin,
    pin: link.hubListenerPin,
  };
}

async function declinedKind(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "kind" in body) return String(body.kind);
  } catch {
    // An answer that is not JSON is a refusal without a kind.
  }
  return "refused";
}

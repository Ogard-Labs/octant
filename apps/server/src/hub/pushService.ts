// Push through the hub, from the hub's side and from a standing-in standby's. A
// spoke whose hub grant ticks Push hands the hub a delivery request it has
// already sealed to the phone's key and signed with its own host key, exactly as
// the push gateway requires. The hub forwards that request to the gateway byte
// for byte and relays the answer. It holds no key that opens an envelope, never
// signs for a spoke, and keeps nothing of the request after the forward: the
// journal gets the spoke, a size, and a reason word. The switch is the hub's
// own, off until a person turns it on in a window.

import {
  HUB_PUSH_BODY_MAX_BYTES,
  HubMemberId,
  decodeHubPushGrantAnswer,
  decodeHubPushHandoff,
  decodeRemotePushDeliveryRequestV1,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubPushAnswer,
  type HubPushCopy,
  type HubPushHandoff,
  type HubPushReason,
  type HubPushResult,
  type RemotePushGatewayRefusalCode,
  type RemotePushGatewaySettingsV1,
  type RosterMember,
} from "@octant/contracts";
import { decidePushGateway, decidePushRate } from "@octant/domain";
import { Schema } from "effect";
import {
  gatewayDeliveryHeaders,
  gatewayDeliveryUrl,
  refusalCode,
} from "../remote/gatewayPushDeliveryTransport";
import type { DirectPushGateway } from "./directPushGateway";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_LINK_REQUEST_TIMEOUT_MS, HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort, PushSpokeRecord } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;
/**
 * A standing-in standby's grant question makes the spoke probe the hub before it
 * answers (one link request), so the question waits that long plus this much. At
 * the same length the standby's request timed out first and refused every forward.
 */
const NESTED_PROBE_MARGIN_MS = 4_000;

/** How long the hub or a standby waits for a spoke's grant answer. */
export const grantConfirmTimeoutMs = (linkTimeoutMs = HUB_LINK_REQUEST_TIMEOUT_MS) =>
  linkTimeoutMs + NESTED_PROBE_MARGIN_MS;

/** How long a spoke waits on the hub or standby: its grant question, the gateway call, and a margin. */
export const handoffTimeoutMs = (linkTimeoutMs = HUB_LINK_REQUEST_TIMEOUT_MS) =>
  grantConfirmTimeoutMs(linkTimeoutMs) + DEFAULT_GATEWAY_TIMEOUT_MS + NESTED_PROBE_MARGIN_MS;
/** One spoke's notifications are a trickle; this is far above any real burst and far below a flood. */
const DEFAULT_MAX_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const COPY_EVERY_MS = 300_000;

export interface PushServiceOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  /**
   * This host's own Notifications setting: whether it may contact a gateway at
   * all, and which one. Read before every forward, so turning it off stops the
   * next one.
   */
  readonly gateway: () => Pick<RemotePushGatewaySettingsV1, "enabled" | "gatewayUrl">;
  /**
   * This hub's own gateway, when its person turned on direct sending. While it
   * is on, the hub delivers to Apple and Google itself instead of forwarding to
   * the gateway the Notifications setting names.
   */
  readonly direct?: {
    readonly enabled: () => boolean;
    readonly deliver: DirectPushGateway["deliver"];
  };
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  readonly fetch?: typeof fetch;
  readonly gatewayTimeoutMs?: number;
  /** The timeout of an ordinary hub-link request; the grant question waits longer. Tests cannot wait eight seconds. */
  readonly linkTimeoutMs?: number;
  readonly maxPerMinute?: number;
}

export type PushSwitchOutcome =
  | { readonly status: "changed"; readonly enabled: boolean }
  | { readonly status: "refused"; readonly kind: "hub-role-off" };

export type PushForwardOutcome =
  | { readonly status: "forwarded"; readonly answer: HubPushAnswer }
  | { readonly status: "refused"; readonly kind: HubPushReason };

export type PushCopyOutcome =
  | { readonly status: "recorded"; readonly enabled: boolean }
  | { readonly status: "refused"; readonly kind: "not-a-spoke" | "hub-revoked" };

export interface PushStatus {
  readonly enabled: boolean;
  /** Per spoke the hub counted for: what it forwarded and refused, and how the last one ended. */
  readonly spokes: ReadonlyArray<{
    readonly memberId: string;
    readonly forwarded: number;
    readonly refused: number;
    readonly lastResult?: { readonly at: number; readonly result: HubPushResult };
  }>;
}

const isSpokeLike = (member: RosterMember) =>
  member.role === "spoke" || member.role === "standby-hub";

/** What a forward is judged against: the hub's own roster, or the roster a stand-in standby serves. */
interface Book {
  readonly kind: "hub" | "stand-in";
  readonly roster: ReadonlyArray<RosterMember>;
  readonly selfMemberId: string;
}

export class PushService {
  readonly #options: PushServiceOptions;
  readonly #recent = new Map<string, ReadonlyArray<number>>();
  readonly #rateNotedAt = new Map<string, number>();
  #lastCopyAt = 0;

  constructor(options: PushServiceOptions) {
    this.#options = options;
  }

  status(): PushStatus {
    const push = this.#options.state.load().hub?.push;
    return {
      enabled: push?.enabled === true,
      spokes: (push?.spokes ?? []).map((spoke) => ({
        memberId: String(spoke.memberId),
        forwarded: spoke.forwarded,
        refused: spoke.refused,
        ...(spoke.lastResult === undefined ? {} : { lastResult: spoke.lastResult }),
      })),
    };
  }

  /** The push sender's own switch. Turning it off forgets the counts and tells the standbys. */
  async setEnabled(enabled: boolean, principal: AuditActingPrincipal): Promise<PushSwitchOutcome> {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    this.#options.state.save({
      ...state,
      hub: { ...hub, push: { enabled, spokes: enabled ? (hub.push?.spokes ?? []) : [] } },
    });
    this.#options.record({ change: "push-switch-changed", actingPrincipal: principal });
    await this.#shareCopy();
    return { status: "changed", enabled };
  }

  /**
   * A spoke handed over a sealed delivery request, signed with its own identity
   * key. The sender is the member whose key signed the member-link request, so
   * the body cannot name another. The hub, or a standby that is standing in,
   * checks the roster, its own switch, the size and rate, the gateway, and with
   * the spoke itself that its grant ticks Push, and only then forwards.
   */
  async forward(senderMemberId: string, raw: unknown): Promise<PushForwardOutcome> {
    const memberId = decodeMemberId(senderMemberId);
    const principal: AuditActingPrincipal = { kind: "peer", memberId };
    const rawBytes = rawBodyBytes(raw);
    // Counted per spoke only once the sender is known to be one; a stranger's refusal is journaled, not kept.
    let counting: Book | undefined;
    const refuse = (kind: HubPushReason): PushForwardOutcome => {
      this.#refused({ principal, memberId, kind, bytes: rawBytes, counting });
      return { status: "refused", kind };
    };
    const book = this.#book();
    if (book === "not-coordinating") return refuse("not-coordinating");
    if (book === "handing-back") return refuse("handing-back");
    if (book === "off") return refuse("push-service-off");
    const sender = book.roster.find((member) => String(member.memberId) === senderMemberId);
    // Only a spoke or a standby runs agents that notify. A guest, the hub, and anyone unlisted are refused.
    if (sender === undefined || !isSpokeLike(sender) || senderMemberId === book.selfMemberId) {
      return refuse("not-a-spoke");
    }
    counting = book;
    if (!this.#withinRate(senderMemberId)) return refuse("rate-limited");
    if (rawBytes !== undefined && rawBytes > HUB_PUSH_BODY_MAX_BYTES) return refuse("too-large");
    let handoff: HubPushHandoff;
    try {
      handoff = decodeHubPushHandoff(raw);
      // Shape only: the hub reads no field of the envelope and has no key to open it.
      decodeRemotePushDeliveryRequestV1(JSON.parse(handoff.body));
    } catch {
      return refuse("malformed");
    }
    const bytes = Buffer.byteLength(handoff.body, "utf8");
    // A hub that sends directly is its own gateway: the request goes to the
    // platforms through its own rules, and the Notifications setting, which names
    // a gateway to contact, is not consulted. A standing-in standby holds no
    // credentials and still forwards.
    const sendDirect = book.kind === "hub" ? this.#options.direct : undefined;
    const direct = sendDirect?.enabled() === true ? sendDirect : undefined;
    let target: { readonly gatewayUrl: string } | undefined;
    if (direct === undefined) {
      const gateway = this.#options.gateway();
      if (!gateway.enabled) return refuse("gateway-off");
      const decision = decidePushGateway({
        requested: handoff.gatewayUrl,
        configured: gateway.gatewayUrl,
      });
      if (decision.status === "refuse") return refuse(decision.kind);
      target = decision;
    }
    const confirmed = await this.#confirmGrant(book, sender);
    if (confirmed.status === "refused") return refuse(confirmed.kind);

    let gatewayStatus: number;
    let code: RemotePushGatewayRefusalCode | undefined;
    if (direct !== undefined) {
      const answer = await direct.deliver(handoff.body, {
        hostKey: handoff.hostKey,
        timestamp: handoff.timestamp,
        signature: handoff.signature,
      });
      gatewayStatus = answer.status;
      code = "code" in answer ? answer.code : undefined;
    } else if (target !== undefined) {
      let response: Response;
      try {
        response = await (this.#options.fetch ?? fetch)(gatewayDeliveryUrl(target.gatewayUrl), {
          method: "POST",
          headers: gatewayDeliveryHeaders(handoff),
          body: handoff.body,
          // The signed request goes only to the address the hub's person set, never to a redirect.
          redirect: "manual",
          signal: AbortSignal.timeout(this.#options.gatewayTimeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS),
        });
      } catch {
        this.#note(book, memberId, "failed");
        this.#options.record({
          change: "push-refused",
          actingPrincipal: principal,
          memberId,
          pushBytes: bytes,
          pushReason: "gateway-unreachable",
        });
        return { status: "refused", kind: "gateway-unreachable" };
      }
      gatewayStatus = response.status;
      code = await refusalCode(response);
    } else {
      return refuse("gateway-off");
    }
    this.#note(
      book,
      memberId,
      gatewayStatus >= 200 && gatewayStatus < 300 ? "forwarded" : "failed",
    );
    this.#options.record({
      change: "push-forwarded",
      actingPrincipal: principal,
      memberId,
      pushBytes: bytes,
    });
    return {
      status: "forwarded",
      answer: {
        status: "forwarded",
        gatewayStatus,
        ...(code === undefined ? {} : { code }),
      },
    };
  }

  /** A standby keeps whether the hub's push switch is on, to forward only then if it has to stand in. */
  receiveCopy(copy: HubPushCopy): PushCopyOutcome {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    if (link.pushCopy?.enabled !== copy.enabled) {
      this.#options.state.save({
        ...state,
        link: { ...link, pushCopy: { enabled: copy.enabled } },
      });
      this.#options.record({
        change: "push-switch-changed",
        actingPrincipal: { kind: "hub", memberId: link.hubMemberId },
      });
    }
    return { status: "recorded", enabled: copy.enabled };
  }

  /** One look: forget old rate marks, and hand the standbys the switch now and then. */
  async tick(): Promise<void> {
    const now = this.#options.now();
    for (const [memberId, times] of this.#recent) {
      if (!times.some((at) => at > now - RATE_WINDOW_MS)) this.#recent.delete(memberId);
    }
    for (const [memberId, at] of this.#rateNotedAt) {
      if (at <= now - RATE_WINDOW_MS) this.#rateNotedAt.delete(memberId);
    }
    if (this.#options.state.load().hub?.enabled !== true) return;
    if (now - this.#lastCopyAt < COPY_EVERY_MS) return;
    this.#lastCopyAt = now;
    await this.#shareCopy();
  }

  #book(): Book | "off" | "not-coordinating" | "handing-back" {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled === true) {
      if (hub.push?.enabled !== true || hub.roster === undefined) return "off";
      return {
        kind: "hub",
        roster: hub.roster.roster.members,
        selfMemberId: String(this.#options.identity().hostId),
      };
    }
    const link = state.link;
    if (link === undefined || link.removed === true || link.standIn === undefined) {
      return "not-coordinating";
    }
    // Spokes follow a hand-back right after it is built; one filed now would reach no one.
    if (link.standIn.handingBack === true) return "handing-back";
    // A standby has no switch of its own: it forwards only while the hub's is on.
    if (link.pushCopy?.enabled !== true) return "off";
    return {
      kind: "stand-in",
      roster: link.roster.roster.members,
      selfMemberId: String(link.selfMemberId),
    };
  }

  #withinRate(senderMemberId: string): boolean {
    const now = this.#options.now();
    const decision = decidePushRate({
      recent: this.#recent.get(senderMemberId) ?? [],
      nowMs: now,
      windowMs: RATE_WINDOW_MS,
      max: this.#options.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE,
    });
    if (decision.status === "refuse") return false;
    this.#recent.set(senderMemberId, decision.recent);
    return true;
  }

  /**
   * Only the spoke knows its own grant, so the hub asks it, over the pinned
   * link, before it forwards. A spoke that cannot be reached, or that answers
   * anything but granted, gets no forward: the hub never assumes a grant.
   */
  async #confirmGrant(
    book: Book,
    member: RosterMember,
  ): Promise<
    { readonly status: "granted" } | { readonly status: "refused"; readonly kind: HubPushReason }
  > {
    const state = this.#options.state.load();
    const origin =
      state.hub?.members.find((record) => String(record.memberId) === String(member.memberId))
        ?.listenerOrigin ?? memberOrigin(member);
    if (origin === undefined) return { status: "refused", kind: "grant-unconfirmed" };
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: book.selfMemberId,
      recipientMemberId: String(member.memberId),
      method: "POST",
      path: "/api/hub/push-grant",
      body: "{}",
      // A standby is known to the spoke by the fingerprint the roster lists for it.
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
      timeoutMs: grantConfirmTimeoutMs(this.#options.linkTimeoutMs),
    });
    if (answer.status === "unreachable") return { status: "refused", kind: "grant-unconfirmed" };
    if (!answer.response.ok) {
      return { status: "refused", kind: await spokeRefusal(answer.response) };
    }
    try {
      decodeHubPushGrantAnswer(await answer.response.json());
      return { status: "granted" };
    } catch {
      return { status: "refused", kind: "grant-unconfirmed" };
    }
  }

  #refused(input: {
    readonly principal: AuditActingPrincipal;
    readonly memberId: HubMemberId;
    readonly kind: HubPushReason;
    readonly bytes: number | undefined;
    readonly counting: Book | undefined;
  }): void {
    if (input.counting !== undefined) this.#note(input.counting, input.memberId, "refused");
    // A spoke that keeps asking past its limit is journaled once a window, not once a request.
    if (input.kind === "rate-limited") {
      const now = this.#options.now();
      const noted = this.#rateNotedAt.get(String(input.memberId));
      if (noted !== undefined && noted > now - RATE_WINDOW_MS) return;
      this.#rateNotedAt.set(String(input.memberId), now);
    }
    this.#options.record({
      change: "push-refused",
      actingPrincipal: input.principal,
      memberId: input.memberId,
      ...(input.bytes === undefined ? {} : { pushBytes: input.bytes }),
      pushReason: input.kind,
    });
  }

  /** The hub keeps counts and the last result per spoke; a standing-in standby journals and keeps nothing. */
  #note(book: Book, memberId: HubMemberId, result: HubPushResult): void {
    if (book.kind !== "hub") return;
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.push === undefined) return;
    const previous = hub.push.spokes.find((spoke) => String(spoke.memberId) === String(memberId));
    const next: PushSpokeRecord = {
      memberId,
      forwarded: (previous?.forwarded ?? 0) + (result === "refused" ? 0 : 1),
      refused: (previous?.refused ?? 0) + (result === "refused" ? 1 : 0),
      lastResult: { at: this.#options.now(), result },
    };
    this.#options.state.save({
      ...state,
      hub: {
        ...hub,
        push: {
          ...hub.push,
          spokes: [
            ...hub.push.spokes.filter((spoke) => String(spoke.memberId) !== String(memberId)),
            next,
          ],
        },
      },
    });
  }

  /** Tells every named standby whether the push switch is on. */
  async #shareCopy(): Promise<void> {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true || hub.roster === undefined) return;
    const roster = hub.roster.roster;
    const body = JSON.stringify({ enabled: hub.push?.enabled === true } satisfies HubPushCopy);
    const identity = this.#options.identity();
    await Promise.allSettled(
      roster.standbyOrder.map(async (id) => {
        const member = roster.members.find(
          (entry) => String(entry.memberId) === String(id) && entry.role === "standby-hub",
        );
        if (member === undefined) return;
        const origin =
          hub.members.find((record) => String(record.memberId) === String(member.memberId))
            ?.listenerOrigin ?? memberOrigin(member);
        if (origin === undefined) return;
        await sendHubLinkRequest({
          transport: this.#options.transport,
          target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
          signHostPayload: identity.signing.signHostPayload,
          senderMemberId: String(identity.hostId),
          recipientMemberId: String(member.memberId),
          method: "PUT",
          path: "/api/hub/push-copy",
          body,
          now: this.#options.now(),
        });
      }),
    );
  }
}

/** The size of the `body` a request claims, when it is text; the hub reads nothing else of it before the checks. */
function rawBodyBytes(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || !("body" in raw)) return undefined;
  return typeof raw.body === "string" ? Buffer.byteLength(raw.body, "utf8") : undefined;
}

/** The spoke's own word for why it did not grant, when it is one the journal knows. */
async function spokeRefusal(response: Response): Promise<HubPushReason> {
  try {
    const body: unknown = await response.json();
    const kind =
      typeof body === "object" && body !== null && "kind" in body ? String(body.kind) : "";
    if (kind === "push-not-granted" || kind === "standby-not-granted" || kind === "hub-reachable") {
      return kind;
    }
  } catch {
    // An answer that is not JSON is a refusal without a reason.
  }
  return "grant-unconfirmed";
}

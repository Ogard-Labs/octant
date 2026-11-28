// Push through the hub, from the hub's side and from a standing-in standby's.
// A spoke whose hub grant ticks Push hands the hub a v2 delivery (`HubPushHandoffV2`)
// containing the phone's platform, token, and checked push message. The hub
// (or a standing-in standby holding its own credentials) checks the roster, its
// own switch, the size and rate, and with the spoke itself that its grant ticks
// Push, repeats the host-side secret check against its own held secrets, and
// sends directly to Apple (APNs) or Google (FCM). No push gateway exists.

import {
  HUB_PUSH_BODY_MAX_BYTES,
  HubMemberId,
  decodeHubPushGrantAnswer,
  decodeHubPushHandoffV2,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubPushAnswer,
  type HubPushCopy,
  type HubPushHandoffV2,
  type HubPushReason,
  type HubPushResult,
  type RosterMember,
} from "@octant/contracts";
import { decidePushRate } from "@octant/domain";
import {
  recheckHubPushMessage,
  type HeldSecretSnapshot,
} from "@octant/domain/push-notification-policy";
import { Schema } from "effect";
import type { DirectPushSender } from "../push/directPushSenders";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_LINK_REQUEST_TIMEOUT_MS, HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort, PushSpokeRecord } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const DEFAULT_PLATFORM_TIMEOUT_MS = 10_000;
/**
 * A standing-in standby's grant question makes the spoke probe the hub before it
 * answers (one link request), so the question waits that long plus this much. At
 * the same length the standby's request timed out first and refused every forward.
 */
const NESTED_PROBE_MARGIN_MS = 4_000;

/** How long the hub or a standby waits for a spoke's grant answer. */
export const grantConfirmTimeoutMs = (linkTimeoutMs = HUB_LINK_REQUEST_TIMEOUT_MS) =>
  linkTimeoutMs + NESTED_PROBE_MARGIN_MS;

/** How long a spoke waits on the hub or standby: its grant question, the platform call, and a margin. */
export const handoffTimeoutMs = (linkTimeoutMs = HUB_LINK_REQUEST_TIMEOUT_MS) =>
  grantConfirmTimeoutMs(linkTimeoutMs) + DEFAULT_PLATFORM_TIMEOUT_MS + NESTED_PROBE_MARGIN_MS;
/** One spoke's notifications are a trickle; this is far above any real burst and far below a flood. */
const DEFAULT_MAX_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const COPY_EVERY_MS = 300_000;

export interface PushServiceOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  /**
   * This host's own direct push sender (credentials + APNs/FCM delivery). Both
   * the hub and a standing-in standby send only with their own credentials.
   */
  readonly direct: {
    readonly enabled: () => boolean;
    readonly sender: DirectPushSender;
  };
  /** Re-checks the spoke's labels against this hub's own held secrets before sending. */
  readonly readHeldSecrets: () => Promise<HeldSecretSnapshot>;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
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

/** Recognizes a legacy v1 sealed-gateway handoff from an older spoke so we refuse with `update-member`. */
function isLegacyV1Handoff(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return (
    record["version"] === undefined &&
    typeof record["body"] === "string" &&
    typeof record["hostKey"] === "string" &&
    typeof record["signature"] === "string"
  );
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
   * A spoke handed over a v2 delivery (`HubPushHandoffV2`). The sender is the
   * member whose key signed the member-link request, so the body cannot name
   * another. The hub (or a standing-in standby with its own credentials) checks
   * the roster, its own switches, the size and rate, confirms the spoke's Push
   * grant, repeats the secret check, and sends directly to APNs or FCM.
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
    if (isLegacyV1Handoff(raw)) {
      return refuse("update-member");
    }
    let handoff: HubPushHandoffV2;
    try {
      handoff = decodeHubPushHandoffV2(raw);
    } catch {
      return refuse("malformed");
    }
    if (!this.#options.direct.enabled()) {
      return refuse("sender-off");
    }
    const confirmed = await this.#confirmGrant(book, sender);
    if (confirmed.status === "refused") return refuse(confirmed.kind);

    let heldSecrets: HeldSecretSnapshot;
    try {
      heldSecrets = await this.#options.readHeldSecrets();
    } catch {
      heldSecrets = { status: "unavailable" };
    }
    const checkedMessage = recheckHubPushMessage(handoff.message, heldSecrets);
    const outcome = await this.#options.direct.sender.send({
      platform: handoff.platform,
      token: handoff.token,
      message: checkedMessage,
    });
    const bytes = rawBytes ?? Buffer.byteLength(JSON.stringify(handoff.message), "utf8");
    this.#note(book, memberId, outcome === "accepted" ? "forwarded" : "failed");
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
        outcome,
      },
    };
  }

  /** A standby keeps whether the hub's push switch is on, to send only then if it has to stand in. */
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
    // A standby has no switch of its own: it sends only while the hub's is on (and with its own credentials).
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
   * link, before it sends. A spoke that cannot be reached, or that answers
   * anything but granted, gets no send: the hub never assumes a grant.
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

function rawBodyBytes(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    return undefined;
  }
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

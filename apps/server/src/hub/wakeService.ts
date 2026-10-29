// The wake service from the hub's side, and from a standing-in standby's. Spokes
// whose hub grant ticks Wake tell it each routine's next occurrence under an
// opaque id; shortly before one, it wakes the spoke with a Wake-on-LAN magic
// packet (when the person entered the spoke's hardware address there) and a
// signed nudge over the private network. The nudge is information: the spoke
// decides, fires its own timer, and follows the routine's own missed-run
// policy. Nothing here knows a routine's prompt, Project, or profile, because
// none is ever sent. The switch is the hub's own, off until a person turns it
// on in a window.

import {
  HubMemberId,
  decodeHubWakeNudgeAnswer,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubWakeCopy,
  type HubWakeNudge,
  type HubWakeReason,
  type HubWakeReport,
  type HubWakeResult,
  type HubWakeSpokeTimes,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import { buildWakeOnLanPacket, wakeIsDue } from "@octant/domain";
import { Schema } from "effect";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort, WakeSpokeRecord } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import type { WakeOnLanPort } from "./wakeOnLan";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const DEFAULT_LEAD_MS = 120_000;
/** An occurrence this far past is the spoke's own missed-run policy to settle. */
const STALE_AFTER_MS = 600_000;
/** How often the hub hands its standbys a fresh copy even if no spoke reported. */
const COPY_EVERY_MS = 300_000;
const REMEMBER_FOR_MS = 3_600_000;

export interface WakeServiceOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly wakeOnLan: WakeOnLanPort;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  /** How long before an occurrence the hub starts waking the spoke; a test cannot wait minutes. */
  readonly leadMs?: number;
}

export type WakeSwitchOutcome =
  | { readonly status: "changed"; readonly enabled: boolean }
  | { readonly status: "refused"; readonly kind: "hub-role-off" };

export type WakeReportOutcome =
  | { readonly status: "recorded"; readonly count: number }
  | {
      readonly status: "refused";
      readonly kind: "wake-service-off" | "not-a-spoke" | "not-coordinating";
    };

export type WakeCopyOutcome =
  | { readonly status: "recorded"; readonly count: number }
  | { readonly status: "refused"; readonly kind: "not-a-spoke" | "hub-revoked" };

export interface WakeStatus {
  readonly enabled: boolean;
  /** Per spoke the hub holds times for: how many wakes are still ahead and how the last one went. */
  readonly spokes: ReadonlyArray<{
    readonly memberId: string;
    readonly upcoming: number;
    readonly lastResult?: { readonly at: number; readonly result: HubWakeResult };
  }>;
}

/** Where the times being acted on live: the hub's own record, or what a stand-in standby holds. */
interface Book {
  readonly kind: "hub" | "stand-in";
  readonly roster: SignedHubRoster["roster"];
  readonly spokes: ReadonlyArray<WakeSpokeRecord>;
  readonly selfMemberId: string;
}

const isSpokeLike = (member: RosterMember) =>
  member.role === "spoke" || member.role === "standby-hub";

const times = (spoke: WakeSpokeRecord): HubWakeSpokeTimes => ({
  memberId: spoke.memberId,
  times: spoke.times,
  ...(spoke.hardwareAddress === undefined ? {} : { hardwareAddress: spoke.hardwareAddress }),
});

export class WakeService {
  readonly #options: WakeServiceOptions;
  readonly #leadMs: number;
  readonly #attempts = new Map<string, { wolSent: boolean; at: number }>();
  readonly #done = new Map<string, number>();
  #lastCopyAt = 0;
  #ticking = false;

  constructor(options: WakeServiceOptions) {
    this.#options = options;
    this.#leadMs = options.leadMs ?? DEFAULT_LEAD_MS;
  }

  status(): WakeStatus {
    const wake = this.#options.state.load().hub?.wake;
    const now = this.#options.now();
    return {
      enabled: wake?.enabled === true,
      spokes: (wake?.spokes ?? []).map((spoke) => ({
        memberId: String(spoke.memberId),
        upcoming: spoke.times.filter((time) => Date.parse(time.nextAt) >= now).length,
        ...(spoke.lastResult === undefined ? {} : { lastResult: spoke.lastResult }),
      })),
    };
  }

  /** The wake service's own switch. Turning it off forgets every time the hub held. */
  async setEnabled(enabled: boolean, principal: AuditActingPrincipal): Promise<WakeSwitchOutcome> {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    this.#options.state.save({
      ...state,
      hub: { ...hub, wake: { enabled, spokes: enabled ? (hub.wake?.spokes ?? []) : [] } },
    });
    this.#options.record({ change: "wake-switch-changed", actingPrincipal: principal });
    // Standbys hold a copy only while the service is on.
    await this.#shareCopy();
    return { status: "changed", enabled };
  }

  /**
   * A spoke reported its routine times, signed with its own identity key. The
   * hub, or a standby that is standing in, records them under that spoke and
   * nobody else: the body names no member. A guest runs no routines and a
   * report from one is refused.
   */
  async receiveReport(senderMemberId: string, report: HubWakeReport): Promise<WakeReportOutcome> {
    const state = this.#options.state.load();
    const now = this.#options.now();
    const memberId = decodeMemberId(senderMemberId);
    const principal: AuditActingPrincipal = { kind: "peer", memberId };
    const hub = state.hub;
    if (hub?.enabled === true) {
      if (hub.wake?.enabled !== true || hub.roster === undefined) {
        return { status: "refused", kind: "wake-service-off" };
      }
      const roster = hub.roster.roster;
      const sender = roster.members.find((member) => String(member.memberId) === senderMemberId);
      if (sender === undefined || !isSpokeLike(sender)) {
        return { status: "refused", kind: "not-a-spoke" };
      }
      const previous = hub.wake.spokes.find((spoke) => String(spoke.memberId) === senderMemberId);
      const held = hub.wake.spokes.filter(
        (spoke) =>
          String(spoke.memberId) !== senderMemberId &&
          roster.members.some((member) => String(member.memberId) === String(spoke.memberId)),
      );
      const next: WakeSpokeRecord[] =
        report.times.length === 0 && report.hardwareAddress === undefined
          ? held
          : [
              ...held,
              {
                memberId,
                times: report.times,
                ...(report.hardwareAddress === undefined
                  ? {}
                  : { hardwareAddress: report.hardwareAddress }),
                reportedAt: now,
                ...(previous?.lastResult === undefined ? {} : { lastResult: previous.lastResult }),
              },
            ];
      this.#options.state.save({
        ...state,
        hub: { ...hub, wake: { enabled: true, spokes: next } },
      });
      this.#options.record({
        change: "wake-times-reported",
        actingPrincipal: principal,
        memberId,
        wakeCount: report.times.length,
      });
      void this.#shareCopy();
      return { status: "recorded", count: report.times.length };
    }
    const link = state.link;
    if (link === undefined || link.removed === true || link.standIn === undefined) {
      return { status: "refused", kind: "not-coordinating" };
    }
    const sender = link.roster.roster.members.find(
      (member) => String(member.memberId) === senderMemberId,
    );
    if (sender === undefined || !isSpokeLike(sender)) {
      return { status: "refused", kind: "not-a-spoke" };
    }
    // An empty report stays on file while standing in: it is what overrides the copy.
    const reports = [
      ...(link.standIn.wakeReports ?? []).filter(
        (spoke) => String(spoke.memberId) !== senderMemberId,
      ),
      {
        memberId,
        times: report.times,
        ...(report.hardwareAddress === undefined
          ? {}
          : { hardwareAddress: report.hardwareAddress }),
        reportedAt: now,
      },
    ];
    this.#options.state.save({
      ...state,
      link: { ...link, standIn: { ...link.standIn, wakeReports: reports } },
    });
    this.#options.record({
      change: "wake-times-reported",
      actingPrincipal: principal,
      memberId,
      wakeCount: report.times.length,
    });
    return { status: "recorded", count: report.times.length };
  }

  /** A standby keeps the copy the hub handed it, to wake spokes if it has to stand in. */
  receiveCopy(copy: HubWakeCopy): WakeCopyOutcome {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const now = this.#options.now();
    const held = copy.spokes.map((spoke) => ({ ...spoke, reportedAt: now }));
    this.#options.state.save({ ...state, link: { ...link, wakeCopy: held } });
    const count = copy.spokes.reduce((total, spoke) => total + spoke.times.length, 0);
    this.#options.record({
      change: "wake-times-reported",
      actingPrincipal: { kind: "hub", memberId: link.hubMemberId },
      memberId: link.hubMemberId,
      wakeCount: count,
    });
    return { status: "recorded", count };
  }

  /**
   * The times a standby gathered while it stood in, taken back by the hub after
   * the membership merge. Only spokes the hub still lists are kept, and a
   * standby's report replaces what the hub held for that spoke.
   */
  mergeHandback(
    senderMemberId: string,
    handed: ReadonlyArray<HubWakeSpokeTimes>,
  ): { readonly merged: number } {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true || hub.wake?.enabled !== true || hub.roster === undefined) {
      return { merged: 0 };
    }
    const roster = hub.roster.roster;
    const now = this.#options.now();
    const accepted = handed.filter((spoke) =>
      roster.members.some(
        (member) => String(member.memberId) === String(spoke.memberId) && isSpokeLike(member),
      ),
    );
    if (accepted.length === 0) return { merged: 0 };
    const previous = hub.wake.spokes;
    const replaced = new Set(accepted.map((spoke) => String(spoke.memberId)));
    const next: WakeSpokeRecord[] = [
      ...previous.filter((spoke) => !replaced.has(String(spoke.memberId))),
      ...accepted.map((spoke): WakeSpokeRecord => {
        const lastResult = previous.find(
          (held) => String(held.memberId) === String(spoke.memberId),
        )?.lastResult;
        return {
          ...spoke,
          reportedAt: now,
          ...(lastResult === undefined ? {} : { lastResult }),
        };
      }),
    ];
    this.#options.state.save({ ...state, hub: { ...hub, wake: { enabled: true, spokes: next } } });
    this.#options.record({
      change: "wake-times-merged",
      actingPrincipal: { kind: "hub", memberId: decodeMemberId(senderMemberId) },
      memberId: decodeMemberId(senderMemberId),
      wakeCount: accepted.reduce((total, spoke) => total + spoke.times.length, 0),
    });
    return { merged: accepted.length };
  }

  /**
   * One look at the times. Called on a timer by the server and directly by
   * tests. Every occurrence inside its lead time gets a wake, once: a magic
   * packet if the spoke's address is known, then a nudge until the spoke
   * answers or the occurrence arrives, whichever is first.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#wakeDue();
    } finally {
      this.#ticking = false;
    }
  }

  #book(): Book | undefined {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled === true) {
      if (hub.wake?.enabled !== true || hub.roster === undefined) return undefined;
      return {
        kind: "hub",
        roster: hub.roster.roster,
        spokes: hub.wake.spokes,
        selfMemberId: String(this.#options.identity().hostId),
      };
    }
    const link = state.link;
    if (link === undefined || link.removed === true || link.standIn === undefined) return undefined;
    const reports = link.standIn.wakeReports ?? [];
    const copy = (link.wakeCopy ?? []).filter(
      (held) => !reports.some((report) => String(report.memberId) === String(held.memberId)),
    );
    return {
      kind: "stand-in",
      roster: link.roster.roster,
      spokes: [...copy, ...reports],
      selfMemberId: String(link.selfMemberId),
    };
  }

  async #wakeDue(): Promise<void> {
    const book = this.#book();
    if (book === undefined) return;
    const now = this.#options.now();
    this.#forget(now);
    if (book.kind === "hub" && now - this.#lastCopyAt >= COPY_EVERY_MS) {
      this.#lastCopyAt = now;
      void this.#shareCopy();
    }
    const work: Array<Promise<void>> = [];
    for (const spoke of book.spokes) {
      const member = book.roster.members.find(
        (entry) =>
          String(entry.memberId) === String(spoke.memberId) &&
          isSpokeLike(entry) &&
          String(entry.memberId) !== book.selfMemberId,
      );
      if (member === undefined) continue;
      for (const time of spoke.times) {
        const at = Date.parse(time.nextAt);
        if (
          !wakeIsDue({
            occurrenceAtMs: at,
            nowMs: now,
            leadMs: this.#leadMs,
            staleAfterMs: STALE_AFTER_MS,
          })
        ) {
          continue;
        }
        const key = `${String(spoke.memberId)}:${time.routineId}:${time.nextAt}`;
        if (this.#done.has(key)) continue;
        work.push(
          this.#wake({
            book,
            member,
            hardwareAddress: spoke.hardwareAddress,
            nudge: { routineId: time.routineId, occurrenceAt: time.nextAt },
            at,
            key,
          }),
        );
      }
    }
    await Promise.allSettled(work);
  }

  async #wake(input: {
    readonly book: Book;
    readonly member: RosterMember;
    readonly hardwareAddress: string | undefined;
    readonly nudge: HubWakeNudge;
    readonly at: number;
    readonly key: string;
  }): Promise<void> {
    const attempt = this.#attempts.get(input.key) ?? { wolSent: false, at: input.at };
    this.#attempts.set(input.key, attempt);
    if (!attempt.wolSent && input.hardwareAddress !== undefined) {
      attempt.wolSent = true;
      const packet = buildWakeOnLanPacket(input.hardwareAddress);
      if (packet !== undefined) await this.#options.wakeOnLan.broadcast(packet);
    }
    const answer = await this.#sendNudge(input.book, input.member, input.nudge);
    if (answer.status === "unreachable") {
      // The machine may still be waking: ask again on the next look, and give up at the occurrence.
      if (this.#options.now() < input.at) return;
      this.#finish(input, "unreachable", "wake-unreachable");
      return;
    }
    if (answer.status === "sent") {
      this.#finish(input, "nudged", "wake-nudge-sent");
      return;
    }
    this.#finish(
      input,
      answer.status === "ignored" ? "ignored" : "refused",
      "wake-nudge-refused",
      answer.reason,
    );
  }

  async #sendNudge(
    book: Book,
    member: RosterMember,
    nudge: HubWakeNudge,
  ): Promise<
    | { readonly status: "sent" }
    | { readonly status: "ignored" | "refused"; readonly reason: HubWakeReason }
    | { readonly status: "unreachable" }
  > {
    const state = this.#options.state.load();
    const origin =
      state.hub?.members.find((record) => String(record.memberId) === String(member.memberId))
        ?.listenerOrigin ?? memberOrigin(member);
    if (origin === undefined) return { status: "unreachable" };
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: book.selfMemberId,
      recipientMemberId: String(member.memberId),
      method: "POST",
      path: "/api/hub/wake-nudge",
      body: JSON.stringify(nudge),
      // A standby is known to the spoke by the fingerprint the roster lists for it.
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return { status: "unreachable" };
    if (!answer.response.ok) {
      return { status: "refused", reason: await refusalReason(answer.response) };
    }
    try {
      const decoded = decodeHubWakeNudgeAnswer(await answer.response.json());
      return decoded.status === "accepted"
        ? { status: "sent" }
        : { status: "ignored", reason: decoded.kind };
    } catch {
      return { status: "refused", reason: "answer-refused" };
    }
  }

  #finish(
    input: { readonly book: Book; readonly member: RosterMember; readonly key: string },
    result: HubWakeResult,
    change: "wake-nudge-sent" | "wake-nudge-refused" | "wake-unreachable",
    reason?: HubWakeReason,
  ): void {
    this.#done.set(input.key, this.#attempts.get(input.key)?.at ?? this.#options.now());
    this.#attempts.delete(input.key);
    const now = this.#options.now();
    this.#options.record({
      change,
      actingPrincipal: { kind: "hub", memberId: decodeMemberId(input.book.selfMemberId) },
      memberId: input.member.memberId,
      ...(reason === undefined ? {} : { wakeReason: reason }),
    });
    if (input.book.kind !== "hub") return;
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.wake === undefined) return;
    this.#options.state.save({
      ...state,
      hub: {
        ...hub,
        wake: {
          ...hub.wake,
          spokes: hub.wake.spokes.map((spoke) =>
            String(spoke.memberId) === String(input.member.memberId)
              ? { ...spoke, lastResult: { at: now, result } }
              : spoke,
          ),
        },
      },
    });
  }

  #forget(now: number): void {
    for (const [key, at] of this.#done) {
      if (at < now - REMEMBER_FOR_MS) this.#done.delete(key);
    }
    for (const [key, attempt] of this.#attempts) {
      if (attempt.at < now - REMEMBER_FOR_MS) this.#attempts.delete(key);
    }
  }

  /** Hands every named standby the times the hub holds, so it can wake spokes while it stands in. */
  async #shareCopy(): Promise<void> {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true || hub.roster === undefined) return;
    const roster = hub.roster.roster;
    const copy: HubWakeCopy = {
      spokes: hub.wake?.enabled === true ? hub.wake.spokes.map(times) : [],
    };
    const body = JSON.stringify(copy);
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
          path: "/api/hub/wake-copy",
          body,
          now: this.#options.now(),
        });
      }),
    );
  }
}

/** The spoke's own word for why it refused, when it is one the journal knows. */
async function refusalReason(response: Response): Promise<HubWakeReason> {
  try {
    const body: unknown = await response.json();
    const kind =
      typeof body === "object" && body !== null && "kind" in body ? String(body.kind) : "";
    if (kind === "wake-not-granted" || kind === "standby-not-granted" || kind === "hub-reachable") {
      return kind;
    }
  } catch {
    // An answer that is not JSON is a refusal without a reason.
  }
  return "answer-refused";
}

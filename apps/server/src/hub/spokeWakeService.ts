// The wake service from a spoke's side. A spoke whose hub grant ticks Wake tells
// the hub each enabled routine's next occurrence under a random id of its own
// making, and nothing else: no prompt, Project, profile, name, or schedule. A
// nudge back names only that id and an occurrence time. The spoke believes it
// only when the id maps to a routine it has, the time is that routine's own
// next occurrence, the occurrence is near, and its grant still ticks Wake (and
// Standby, for a standby). Believing it means one thing: poke the host's own
// scheduler awake. The scheduler claims only occurrences that are due by its own
// clock, under the routine's own missed-run policy, so a nudge never starts a run.

import { randomBytes } from "node:crypto";
import {
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubMemberId,
  type HubWakeNudge,
  type HubWakeReason,
  type HubWakeReport,
  type UtcTimestamp,
  type WakeNudgeIgnoredKind,
  WakeRoutineId,
} from "@octant/contracts";
import { decideWakeNudge, normalizeHardwareAddress } from "@octant/domain";
import { Schema } from "effect";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubLinkState, HubStatePort } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import type { SpokeLinkService } from "./spokeLinkService";

const decodeRoutineId = Schema.decodeUnknownSync(WakeRoutineId);
const MAX_REPORTED_ROUTINES = 256;
const DEFAULT_MATCH_WINDOW_MS = 60_000;
const DEFAULT_MAX_LEAD_MS = 600_000;

/** The only facts about a routine this service reads: that it exists, is enabled, and when it is next due. */
export interface WakeRoutineView {
  readonly id: string;
  readonly enabled: boolean;
  readonly nextDueAt: UtcTimestamp | null;
}

export interface SpokeWakeOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly spoke: Pick<SpokeLinkService, "hubMayUse">;
  readonly routines: () => ReadonlyArray<WakeRoutineView>;
  /** The host's own scheduler. A nudge may wake its loop; it has no way to claim or start a run. */
  readonly scheduler: { readonly poke: () => void };
  /** Whether this spoke has not reached the hub for the failover time; a standby's nudge is believed only then. */
  readonly hubUnreachable: () => Promise<boolean>;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  readonly newRoutineId?: () => string;
  readonly matchWindowMs?: number;
  readonly maxLeadMs?: number;
}

/** What a report says before the spoke numbers it. */
type WakeReportContent = Omit<HubWakeReport, "sequence">;

export type WakeReportResult =
  | { readonly status: "sent"; readonly count: number }
  | { readonly status: "unchanged" }
  | { readonly status: "unreachable" }
  | {
      readonly status: "refused";
      readonly kind: "not-a-spoke" | "hub-revoked" | "wake-not-granted" | "stand-in";
    }
  | { readonly status: "declined"; readonly kind: string };

/** Who sent a nudge, once the signature and the roster said so. */
export type WakeNudgeSender =
  | { readonly kind: "hub"; readonly memberId: HubMemberId }
  | { readonly kind: "standby"; readonly memberId: HubMemberId };

export type WakeNudgeResult =
  | { readonly status: "accepted" }
  | { readonly status: "ignored"; readonly kind: WakeNudgeIgnoredKind }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-a-spoke"
        | "hub-revoked"
        | "wake-not-granted"
        | "standby-not-granted"
        | "hub-reachable";
    };

export type HardwareAddressResult =
  | { readonly status: "changed"; readonly hardwareAddress?: string }
  | {
      readonly status: "refused";
      readonly kind: "not-a-spoke" | "hub-revoked" | "invalid-address";
    };

export interface SpokeWakeStatus {
  /** Whether this spoke's hub grant ticks Wake, which is the only reason it reports anything. */
  readonly sharing: boolean;
  readonly hardwareAddress?: string;
  /** How many routine times the last report carried. */
  readonly reported: number;
}

export class SpokeWakeService {
  readonly #options: SpokeWakeOptions;
  #lastSent: string | undefined;
  #lastCount = 0;
  /** The report being sent, with any follow-up it owes; never more than one at a time. */
  #flight: Promise<WakeReportResult> | undefined;
  /** Something changed while a report was in flight, so the latest state is sent when it completes. */
  #pending = false;
  /** Moves each time what the hub holds is forgotten, so an answer that predates it is not believed. */
  #forgotten = 0;
  /** The hub's wake generation as of the last report it took or heartbeat that carried it. */
  #hubGeneration: number | undefined;

  constructor(options: SpokeWakeOptions) {
    this.#options = options;
  }

  status(): SpokeWakeStatus {
    const link = this.#options.state.load().link;
    return {
      sharing: link !== undefined && this.#wakeGranted(),
      ...(link?.wake?.hardwareAddress === undefined
        ? {}
        : { hardwareAddress: link.wake.hardwareAddress }),
      reported: this.#lastCount,
    };
  }

  /**
   * The person entering, or clearing, this computer's hardware address. It
   * leaves this computer only inside a wake report, and only while the hub grant
   * ticks Wake.
   */
  setHardwareAddress(raw: string | null): HardwareAddressResult {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const text = raw?.trim() ?? "";
    const address = text === "" ? undefined : normalizeHardwareAddress(text);
    if (text !== "" && address === undefined) return { status: "refused", kind: "invalid-address" };
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        wake: {
          routines: link.wake?.routines ?? [],
          ...(address === undefined ? {} : { hardwareAddress: address }),
          ...(link.wake?.shared === true ? { shared: true as const } : {}),
          ...keptSequence(link.wake),
        },
      },
    });
    void this.report().catch(() => undefined);
    return { status: "changed", ...(address === undefined ? {} : { hardwareAddress: address }) };
  }

  /**
   * The wake generation the hub's heartbeat carried. A hub that cleared its wake
   * state (the person turned the service off and on) moves it, and what this
   * spoke last sent is then gone from the hub: forget it so the next report is
   * sent in full instead of answering "unchanged".
   */
  noteHubWakeGeneration(generation: number): void {
    if (this.#hubGeneration !== undefined && this.#hubGeneration !== generation) {
      this.#lastSent = undefined;
      this.#forgotten += 1;
      if (this.#flight !== undefined) this.#pending = true;
    }
    this.#hubGeneration = generation;
  }

  /** One look at this spoke's routines; called on a timer by the server. */
  async tick(): Promise<void> {
    await this.report();
  }

  /**
   * Sends the hub every enabled routine's next occurrence, when that differs
   * from what it last accepted. A routine that is removed or disabled is left
   * out, which withdraws it. A spoke that does not tick Wake sends nothing, and
   * withdraws what it sent before it was unticked. Every way into a report comes
   * here: one is in flight at most, and a change asked for meanwhile is sent once
   * when it completes, so an older report cannot overtake a newer one.
   */
  report(): Promise<WakeReportResult> {
    if (this.#flight !== undefined) {
      this.#pending = true;
      return this.#flight;
    }
    const flight = this.#sendUntilCurrent().finally(() => {
      this.#flight = undefined;
    });
    this.#flight = flight;
    return flight;
  }

  async #sendUntilCurrent(): Promise<WakeReportResult> {
    let result: WakeReportResult;
    do {
      this.#pending = false;
      result = await this.#send();
    } while (this.#pending);
    return result;
  }

  async #send(): Promise<WakeReportResult> {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    // A standing-in standby is awake and runs its own scheduler: no one wakes it.
    if (link.standIn !== undefined) return { status: "refused", kind: "stand-in" };
    const granted = this.#wakeGranted();
    // What this spoke shared stays on the hub until a withdrawal is confirmed, also across a restart.
    if (!granted && link.wake?.shared !== true) {
      return { status: "refused", kind: "wake-not-granted" };
    }
    const report: WakeReportContent = granted ? this.#build(link) : { times: [] };
    const target = coordinator(link);
    if (target === undefined) return { status: "unreachable" };
    if (granted) this.#markShared(true);
    const signature = `${target.memberId}|${JSON.stringify(report)}`;
    if (signature === this.#lastSent) return { status: "unchanged" };
    const body = JSON.stringify({ ...report, sequence: this.#nextSequence() });
    const forgotten = this.#forgotten;
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin: target.origin, pin: listenerPinFromDigest(target.pin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(link.selfMemberId),
      recipientMemberId: target.memberId,
      method: "POST",
      path: "/api/hub/wake-times",
      body,
      // A hub that never held this key (a promoted standby) checks it against the roster.
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return { status: "unreachable" };
    if (!answer.response.ok) {
      return { status: "declined", kind: await declinedKind(answer.response) };
    }
    const { status, generation } = await answered(answer.response);
    // What the hub forgot while this was in flight is not on the hub, whatever it answered.
    this.#lastSent = granted && forgotten === this.#forgotten ? signature : undefined;
    if (!granted) this.#markShared(false);
    if (generation !== undefined) this.#hubGeneration = generation;
    // The hub already applied a newer report from this spoke: there is nothing to resend.
    if (status === "stale-report") return { status: "unchanged" };
    this.#lastCount = report.times.length;
    return { status: "sent", count: report.times.length };
  }

  /**
   * A nudge from the hub, or from a standby that is standing in. The sender is
   * already authenticated; this decides whether to believe it. Believing it only
   * wakes the host's own scheduler, which fires or skips each occurrence by its
   * own clock and the routine's own missed-run policy.
   */
  async receiveNudge(sender: WakeNudgeSender, nudge: HubWakeNudge): Promise<WakeNudgeResult> {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const principal: AuditActingPrincipal = { kind: "hub", memberId: sender.memberId };
    const refuse = (
      kind: "wake-not-granted" | "standby-not-granted" | "hub-reachable",
    ): WakeNudgeResult => {
      this.#journalRefusal(principal, sender.memberId, kind);
      return { status: "refused", kind };
    };
    if (!this.#wakeGranted()) return refuse("wake-not-granted");
    if (sender.kind === "standby") {
      if (this.#options.spoke.hubMayUse("standby").status === "refused") {
        return refuse("standby-not-granted");
      }
      // A standby stands in only for a hub this spoke cannot reach.
      if (!(await this.#options.hubUnreachable())) return refuse("hub-reachable");
    }
    const ignore = (kind: WakeNudgeIgnoredKind): WakeNudgeResult => {
      this.#journalRefusal(principal, sender.memberId, kind);
      return { status: "ignored", kind };
    };
    const mapped = link.wake?.routines.find((entry) => entry.routineId === nudge.routineId);
    const routine =
      mapped === undefined
        ? undefined
        : this.#options
            .routines()
            .find((entry) => entry.id === mapped.automationId && entry.enabled);
    if (routine === undefined || routine.nextDueAt === null) return ignore("unknown-routine");
    const decision = decideWakeNudge({
      ownNextDueAtMs: Date.parse(routine.nextDueAt),
      occurrenceAtMs: Date.parse(nudge.occurrenceAt),
      nowMs: this.#options.now(),
      matchWindowMs: this.#options.matchWindowMs ?? DEFAULT_MATCH_WINDOW_MS,
      maxLeadMs: this.#options.maxLeadMs ?? DEFAULT_MAX_LEAD_MS,
    });
    if (decision.status === "ignore") return ignore(decision.kind);
    this.#options.scheduler.poke();
    return { status: "accepted" };
  }

  #markShared(shared: boolean): void {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined || (link.wake?.shared === true) === shared) return;
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        wake: {
          routines: link.wake?.routines ?? [],
          ...(link.wake?.hardwareAddress === undefined
            ? {}
            : { hardwareAddress: link.wake.hardwareAddress }),
          ...(shared ? { shared: true as const } : {}),
          ...keptSequence(link.wake),
        },
      },
    });
  }

  /** Above the last one this spoke used, and never below the clock, so it keeps rising across a restart or lost state. */
  #nextSequence(): number {
    const state = this.#options.state.load();
    const link = state.link;
    const sequence = Math.max((link?.wake?.reportSequence ?? 0) + 1, this.#options.now());
    if (link !== undefined) {
      this.#options.state.save({
        ...state,
        link: { ...link, wake: { routines: [], ...link.wake, reportSequence: sequence } },
      });
    }
    return sequence;
  }

  #wakeGranted(): boolean {
    return this.#options.spoke.hubMayUse("wake").status === "allowed";
  }

  #journalRefusal(
    principal: AuditActingPrincipal,
    memberId: HubMemberId,
    reason: HubWakeReason,
  ): void {
    this.#options.record({
      change: "wake-nudge-refused",
      actingPrincipal: principal,
      memberId,
      wakeReason: reason,
    });
  }

  /** Every enabled, scheduled routine under its random id; ids of routines that are gone or disabled are dropped. */
  #build(link: HubLinkState): WakeReportContent {
    const scheduled = this.#options
      .routines()
      .filter((routine) => routine.enabled && routine.nextDueAt !== null);
    const known = link.wake?.routines ?? [];
    const kept = known.filter((entry) =>
      scheduled.some((routine) => routine.id === entry.automationId),
    );
    const routines = [...kept];
    for (const routine of scheduled) {
      if (routines.some((entry) => entry.automationId === routine.id)) continue;
      routines.push({
        automationId: routine.id,
        routineId: decodeRoutineId(
          (this.#options.newRoutineId ?? (() => randomBytes(18).toString("base64url")))(),
        ),
      });
    }
    if (routines.length !== known.length || routines.some((entry, i) => entry !== known[i])) {
      const state = this.#options.state.load();
      if (state.link !== undefined) {
        this.#options.state.save({
          ...state,
          link: {
            ...state.link,
            wake: {
              routines,
              ...(state.link.wake?.hardwareAddress === undefined
                ? {}
                : { hardwareAddress: state.link.wake.hardwareAddress }),
              ...(state.link.wake?.shared === true ? { shared: true as const } : {}),
              ...keptSequence(state.link.wake),
            },
          },
        });
      }
    }
    const times = scheduled.flatMap((routine) => {
      const entry = routines.find((candidate) => candidate.automationId === routine.id);
      return entry === undefined || routine.nextDueAt === null
        ? []
        : [{ routineId: entry.routineId, nextAt: routine.nextDueAt }];
    });
    times.sort((left, right) => Date.parse(left.nextAt) - Date.parse(right.nextAt));
    return {
      times: times.slice(0, MAX_REPORTED_ROUTINES),
      ...(link.wake?.hardwareAddress === undefined
        ? {}
        : { hardwareAddress: link.wake.hardwareAddress }),
    };
  }
}

/**
 * Where to report: the hub, or the standby whose roster this spoke follows
 * because it could not reach the hub.
 */
function coordinator(
  link: HubLinkState,
): { readonly memberId: string; readonly origin: string; readonly pin: string } | undefined {
  const signer = link.roster.signedBy;
  if (signer.kind === "standby") {
    const entry = link.roster.roster.members.find(
      (member) => String(member.memberId) === String(signer.memberId),
    );
    const origin = entry === undefined ? undefined : memberOrigin(entry);
    return entry === undefined || origin === undefined
      ? undefined
      : { memberId: String(entry.memberId), origin, pin: entry.listenerPin };
  }
  return { memberId: String(link.hubMemberId), origin: link.hubOrigin, pin: link.hubListenerPin };
}

/** What the hub answered a report: whether it was too old to apply, and the wake generation it was filed under (a standing-in standby sends none). */
async function answered(
  response: Response,
): Promise<{ readonly status?: string; readonly generation?: number }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      return {
        ...("status" in body && typeof body.status === "string" ? { status: body.status } : {}),
        ...("generation" in body && typeof body.generation === "number"
          ? { generation: body.generation }
          : {}),
      };
    }
  } catch {
    // An answer without a readable body carries neither.
  }
  return {};
}

const keptSequence = (wake: HubLinkState["wake"]) =>
  wake?.reportSequence === undefined ? {} : { reportSequence: wake.reportSequence };

async function declinedKind(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "kind" in body) return String(body.kind);
  } catch {
    // An answer that is not JSON is a refusal without a kind.
  }
  return "refused";
}

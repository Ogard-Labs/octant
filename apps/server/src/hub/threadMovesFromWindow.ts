// What a window on the source asks of a thread move: which member computers
// could take the thread and into which Projects, the destination's owner
// challenge for this Mac's Touch ID or holding the move until an owner phone
// confirms it, starting the move now or once the running turn ends, and where
// the thread stands. Canonical: docs/design/hub-and-spokes.md "Moving a thread
// to another member".
//
// A move can take minutes (there is no size limit), so starting one answers at
// once and the move runs on; the window reads its progress from the status.

import { randomUUID } from "node:crypto";
import {
  THREAD_MOVE_PHONE_WAIT_MS,
  type AuditActingPrincipal,
  type HubMemberId,
  type MovedThreadReference,
  type ProjectId,
  type RosterMember,
  type ShutdownBatchRow,
  type ShutdownChallengeRequest,
  type ShutdownListing,
  type ShutdownPhoneAskRequest,
  type ShutdownPlacement,
  type ShutdownStartOutcome,
  type ShutdownStartRequest,
  type ShutdownThreadRow,
  type ThreadMoveChallengeOutcome,
  type ThreadMoveDestination,
  type ThreadMoveDestinations,
  type ThreadMoveFailureReason,
  type ThreadMovePhoneAskOutcome,
  type ThreadMovePhoneAskRequest,
  type ThreadMovePhoneConfirmations,
  type ThreadMoveStartOutcome,
  type ThreadMoveStartRequest,
  type ThreadMoveThreadStatus,
  type UtcTimestamp,
} from "@octant/contracts";
import { mayActivateAnyway, shutdownListing } from "@octant/domain";
import type { ThreadMoveTicketClient } from "./threadMoveTicketClient";
import {
  THREAD_MOVE_CHUNK_BYTES,
  type ThreadMoveService,
  type ThreadMoveSourceHost,
} from "./threadMoveService";
import type { SentMove, ThreadMoveStatePort } from "./threadMoveStateStore";

/** How often a thread set to move after its turn is checked. */
const TURN_POLL_MS = 2_000;

export interface ThreadMovesFromWindowOptions {
  readonly moves: Pick<
    ThreadMoveService,
    | "askProjects"
    | "start"
    | "cancel"
    | "takeBack"
    | "activateAnyway"
    | "dismissFailure"
    | "refuseBeforeStart"
  >;
  readonly state: ThreadMoveStatePort;
  readonly tickets: ThreadMoveTicketClient;
  readonly source: Pick<ThreadMoveSourceHost, "read">;
  /** The roster this host holds; empty when it is in no hub. */
  readonly members: () => ReadonlyArray<RosterMember>;
  readonly selfMemberId: () => string;
  /** Every thread on this host, as Prepare to shut down reads it. */
  readonly listThreads: () => Promise<ReadonlyArray<ShutdownThreadFacts>>;
  readonly now: () => number;
  readonly pollMs?: number;
}

/** One thread on this host, as Prepare to shut down reads it. */
export interface ShutdownThreadFacts {
  readonly thread: MovedThreadReference;
  readonly title: string;
  readonly projectName?: string;
  readonly busy: boolean;
  readonly delegated: boolean;
  /** Not completed, archived, or being deleted. */
  readonly open: boolean;
  /** The thread's last journaled activity, in milliseconds. */
  readonly lastActivityAt: number | undefined;
  /** For Code: the remote URLs the checkout has. */
  readonly repositoryRemotes: ReadonlyArray<string>;
}

/** A thread as its mode's projection records it, as far as Prepare to shut down reads it. */
interface RecordedThread {
  readonly id: unknown;
  readonly title: string;
  readonly completedAt?: string | undefined;
}

/** One thread on this host before its own host is asked whether it is busy. */
export interface HostThread {
  readonly thread: MovedThreadReference;
  readonly title: string;
  readonly projectId: string | undefined;
  /** Not completed, archived, or being deleted, as its own mode records that. */
  readonly open: boolean;
}

/**
 * Every Chat, Code and Work thread on this host, with whether it is open.
 * Putting a thread away as completed sets `completedAt` and leaves its
 * lifecycle active in every mode, so the lifecycle alone would list a
 * completed thread as open and preselect it to move.
 */
export function hostThreads(input: {
  readonly chat: ReadonlyArray<
    RecordedThread & {
      readonly projectId?: unknown;
      readonly lifecycle: "active" | "archived" | "deleting" | "deleted";
    }
  >;
  readonly code: ReadonlyArray<
    RecordedThread & {
      readonly projectId: unknown;
      readonly lifecycle: "active" | "archived" | "waiting" | "interrupted";
    }
  >;
  readonly work: ReadonlyArray<
    RecordedThread & {
      readonly projectId: unknown;
      readonly lifecycle: "active" | "archived" | "deleting" | "deleted";
      readonly completionConfirmed?: boolean | undefined;
    }
  >;
}): ReadonlyArray<HostThread> {
  return [
    ...input.chat.map((thread) => ({
      thread: { mode: "chat" as const, threadId: String(thread.id) },
      title: thread.title,
      projectId: thread.projectId === undefined ? undefined : String(thread.projectId),
      open: thread.lifecycle === "active" && thread.completedAt === undefined,
    })),
    ...input.code.map((thread) => ({
      thread: { mode: "code" as const, threadId: String(thread.id) },
      title: thread.title,
      projectId: String(thread.projectId),
      open: thread.lifecycle !== "archived" && thread.completedAt === undefined,
    })),
    ...input.work.map((thread) => ({
      thread: { mode: "work" as const, threadId: String(thread.id) },
      title: thread.title,
      projectId: String(thread.projectId),
      open:
        thread.lifecycle === "active" &&
        thread.completionConfirmed !== true &&
        thread.completedAt === undefined,
    })),
  ];
}

/** The longest title or Project name a listing row carries. */
const LISTING_TEXT_MAX = 256;

/**
 * A thread's own title has no length limit and may keep surrounding spaces,
 * and the window decodes the listing as a whole, so one such title would keep
 * every other thread from being listed. The row carries it trimmed and
 * shortened, never split inside a character.
 */
export function shortenedForListing(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "Untitled thread";
  if (trimmed.length <= LISTING_TEXT_MAX) return trimmed;
  let shortened = "";
  for (const character of trimmed) {
    if (shortened.length + character.length > LISTING_TEXT_MAX - 1) break;
    shortened += character;
  }
  return `${shortened.trimEnd()}…`;
}

interface Waiting {
  readonly destinationMemberId: HubMemberId;
  readonly timer: ReturnType<typeof setInterval>;
}

/** The most moves held for a phone at once; each names up to a batch of threads. */
const MAX_PHONE_WAITS = 16;

type HeldRow = ShutdownBatchRow & { readonly title: string };

/** A move held until an owner phone hands over the destination's ticket. */
interface PhoneWait {
  readonly destinationMemberId: HubMemberId;
  /** The threads still waiting; Don't move takes one out. */
  readonly rows: ReadonlyArray<HeldRow>;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** What an owner phone's confirmation came to. */
export type PhoneConfirmOutcome =
  | { readonly status: "started" }
  | { readonly status: "refused"; readonly kind: "no-such-confirmation" };

export class ThreadMovesFromWindow {
  readonly #options: ThreadMovesFromWindowOptions;
  readonly #waiting = new Map<string, Waiting>();
  // In memory only: a restart ends every wait, and the window asks again.
  readonly #phoneWaits = new Map<string, PhoneWait>();
  // When the last move or wait a window started for each thread ended, until
  // that thread starts another; a failure notice can be dismissed, this cannot.
  readonly #settledAt = new Map<string, UtcTimestamp>();

  constructor(options: ThreadMovesFromWindowOptions) {
    this.#options = options;
  }

  /** The member computers the Computer card lists for one thread. */
  async destinations(thread: MovedThreadReference): Promise<ThreadMoveDestinations> {
    const reading = await this.#options.source.read(thread);
    if (reading.status === "missing") {
      return { status: "listed", blocked: "refused", busy: false, destinations: [] };
    }
    if (reading.delegated) {
      return { status: "listed", blocked: "delegated", busy: reading.busy, destinations: [] };
    }
    const destinations = await Promise.all(
      this.#candidates().map(async (member): Promise<ThreadMoveDestination> => {
        const answer = await this.#options.moves.askProjects(String(member.memberId), {
          mode: thread.mode,
          ...(thread.mode === "code" ? { repositoryRemotes: reading.repositoryRemotes } : {}),
        });
        const base = {
          memberId: member.memberId,
          name: member.name,
          role: member.role === "hub" ? ("hub" as const) : ("spoke" as const),
        };
        if (answer === "unreachable") {
          return { ...base, reachable: false, projects: [], noProjectAllowed: false };
        }
        if (answer === "refused") {
          return {
            ...base,
            reachable: true,
            refusal: "refused",
            projects: [],
            noProjectAllowed: false,
          };
        }
        const eligible = answer.projects.length > 0 || answer.noProjectAllowed;
        return {
          ...base,
          reachable: true,
          ...(eligible ? {} : { refusal: "no-eligible-project" as const }),
          projects: answer.projects,
          noProjectAllowed: answer.noProjectAllowed,
        };
      }),
    );
    return { status: "listed", busy: reading.busy, destinations };
  }

  challenge(destinationMemberId: string): Promise<ThreadMoveChallengeOutcome> {
    return this.#options.tickets.challenge(destinationMemberId);
  }

  /**
   * Redeems the person's unlock for the destination's ticket, then moves the
   * thread now, or once its running turn ends. A thread that cannot move ends
   * in the explicit error the thread shows until it is dismissed.
   */
  async start(request: ThreadMoveStartRequest): Promise<ThreadMoveStartOutcome> {
    const { thread } = request;
    if (this.#isWaiting(thread)) return refuse(this.#options, thread, "busy");
    const reading = await this.#options.source.read(thread);
    if (reading.status === "missing") return refuse(this.#options, thread, "refused");
    if (reading.delegated) return refuse(this.#options, thread, "delegated");
    if (reading.busy && request.timing === "now") return refuse(this.#options, thread, "busy");

    const ticket = await this.#options.tickets.redeem({
      destinationMemberId: String(request.destinationMemberId),
      challengeId: request.unlock.challengeId,
      signature: request.unlock.signature,
    });
    if (ticket.status === "refused") return refuse(this.#options, thread, ticket.reason);

    this.#launch({
      thread,
      destinationMemberId: request.destinationMemberId,
      ticketId: ticket.ticketId,
      ...(request.destinationProjectId === undefined
        ? {}
        : { destinationProjectId: request.destinationProjectId }),
      waitForTurn: reading.busy,
      queue: undefined,
    });
    return reading.busy ? { status: "waiting-for-turn" } : { status: "started" };
  }

  /**
   * Holds one thread's move until an owner phone confirms it: nothing is
   * frozen or sent before then. The checks Move with Touch ID makes run
   * first, so a thread that cannot move says so here rather than on the phone.
   */
  async askPhone(request: ThreadMovePhoneAskRequest): Promise<ThreadMovePhoneAskOutcome> {
    const { thread } = request;
    if (this.#isWaiting(thread)) return refuse(this.#options, thread, "busy");
    const reading = await this.#options.source.read(thread);
    if (reading.status === "missing") return refuse(this.#options, thread, "refused");
    if (reading.delegated) return refuse(this.#options, thread, "delegated");
    if (reading.busy && request.timing === "now") return refuse(this.#options, thread, "busy");
    return this.#holdForPhone(request.destinationMemberId, [
      {
        thread,
        timing: request.timing,
        ...(request.destinationProjectId === undefined
          ? {}
          : { destinationProjectId: request.destinationProjectId }),
        title: shortenedForListing(reading.title),
      },
    ]);
  }

  /** Holds one destination's Prepare to shut down batch until an owner phone confirms it. */
  async shutdownAskPhone(request: ShutdownPhoneAskRequest): Promise<ThreadMovePhoneAskOutcome> {
    const rows: HeldRow[] = [];
    for (const row of request.rows) {
      // A thread already moving or waiting keeps that move, as a Touch ID batch does.
      if (this.#isWaiting(row.thread)) continue;
      const reading = await this.#options.source.read(row.thread);
      if (reading.status === "missing") continue;
      rows.push({ ...row, title: shortenedForListing(reading.title) });
    }
    if (rows.length === 0) return { status: "refused", reason: "busy" };
    return this.#holdForPhone(request.destinationMemberId, rows);
  }

  /** The moves held here for an owner phone, as the phone lists them. */
  phoneConfirmations(): ThreadMovePhoneConfirmations {
    this.#expirePhoneWaits();
    return {
      status: "listed",
      confirmations: [...this.#phoneWaits.entries()].map(([confirmationId, wait]) => ({
        confirmationId,
        destinationMemberId: wait.destinationMemberId,
        destinationName: this.#nameOf(String(wait.destinationMemberId)),
        threads: wait.rows.map((row) => ({ thread: row.thread, title: row.title })),
        expiresAt: wait.expiresAt,
      })),
    };
  }

  /**
   * An owner phone hands over the ticket the destination issued it after its
   * own fresh unlock there. The confirmation is spent whatever the ticket
   * turns out to be, and the threads, destination, and Projects are the ones
   * held here: the phone only carries the person's consent. A ticket the
   * destination did not issue, or issued for another source or other threads,
   * is refused by the destination at the offer, and that move ends as one
   * that could not move.
   */
  confirmOnPhone(input: {
    readonly confirmationId: string;
    readonly ticketId: string;
    readonly principal: AuditActingPrincipal;
  }): PhoneConfirmOutcome {
    this.#expirePhoneWaits();
    const wait = this.#phoneWaits.get(input.confirmationId);
    if (wait === undefined) return { status: "refused", kind: "no-such-confirmation" };
    clearTimeout(wait.timer);
    this.#phoneWaits.delete(input.confirmationId);
    const queue = { tail: Promise.resolve() };
    void (async () => {
      for (const row of wait.rows) {
        const reading = await this.#options.source.read(row.thread);
        this.#launch({
          thread: row.thread,
          destinationMemberId: wait.destinationMemberId,
          ticketId: input.ticketId,
          ...(row.destinationProjectId === undefined
            ? {}
            : { destinationProjectId: row.destinationProjectId }),
          waitForTurn: reading.status === "found" && reading.busy && row.timing === "after-turn",
          queue,
          principal: input.principal,
        });
      }
    })();
    return { status: "started" };
  }

  #holdForPhone(
    destinationMemberId: HubMemberId,
    rows: ReadonlyArray<HeldRow>,
  ): ThreadMovePhoneAskOutcome {
    this.#expirePhoneWaits();
    if (this.#phoneWaits.size >= MAX_PHONE_WAITS) return { status: "refused", reason: "busy" };
    const confirmationId = randomUUID();
    const expiresAt = this.#options.now() + THREAD_MOVE_PHONE_WAIT_MS;
    const timer = setTimeout(() => this.#expirePhoneWaits(), THREAD_MOVE_PHONE_WAIT_MS + 1_000);
    timer.unref?.();
    for (const row of rows) this.#settledAt.delete(key(row.thread));
    this.#phoneWaits.set(confirmationId, { destinationMemberId, rows, expiresAt, timer });
    return { status: "waiting-for-phone", expiresAt };
  }

  /** A wait the phone did not answer in time ends as an unlock that never came. */
  #expirePhoneWaits(): void {
    const now = this.#options.now();
    for (const [confirmationId, wait] of this.#phoneWaits) {
      if (now <= wait.expiresAt) continue;
      clearTimeout(wait.timer);
      this.#phoneWaits.delete(confirmationId);
      for (const row of wait.rows) {
        this.#options.moves.refuseBeforeStart(row.thread, "unlock-required");
        this.#settle(row.thread);
      }
    }
  }

  #phoneWaitFor(
    thread: MovedThreadReference,
  ): { readonly confirmationId: string; readonly wait: PhoneWait } | undefined {
    for (const [confirmationId, wait] of this.#phoneWaits) {
      if (wait.rows.some((row) => same(row.thread, thread))) return { confirmationId, wait };
    }
    return undefined;
  }

  #isWaiting(thread: MovedThreadReference): boolean {
    return this.#waiting.has(key(thread)) || this.#phoneWaitFor(thread) !== undefined;
  }

  #nameOf(memberId: string): string {
    return (
      this.#options.members().find((member) => String(member.memberId) === memberId)?.name ??
      "another computer"
    );
  }

  /**
   * Every thread on this host that Prepare to shut down lists, with whether
   * each member could take it. Older open threads are marked to fold; closed
   * ones are left out.
   */
  async shutdownListing(): Promise<ShutdownListing> {
    const now = this.#options.now();
    const facts = (await this.#options.listThreads()).filter(
      (entry) =>
        shutdownListing({
          thread: {
            activity: entry.busy ? "running" : "idle",
            open: entry.open,
            lastTurnAt: entry.lastActivityAt,
          },
          now,
        }) !== "absent",
    );
    const members = this.#candidates();
    // One question per member for each distinct placement, not per thread.
    const placementKey = (entry: ShutdownThreadFacts) =>
      `${entry.thread.mode}|${entry.thread.mode === "code" ? entry.repositoryRemotes.join(" ") : ""}`;
    const asked = new Map<string, Awaited<ReturnType<ThreadMoveService["askProjects"]>>>();
    await Promise.all(
      members.flatMap((member) =>
        [...new Map(facts.map((entry) => [placementKey(entry), entry])).values()].map(
          async (entry) => {
            const answer = await this.#options.moves.askProjects(String(member.memberId), {
              mode: entry.thread.mode,
              ...(entry.thread.mode === "code"
                ? { repositoryRemotes: entry.repositoryRemotes }
                : {}),
            });
            asked.set(`${String(member.memberId)}#${placementKey(entry)}`, answer);
          },
        ),
      ),
    );
    const reachable = (memberId: string) =>
      [...asked.entries()].some(
        ([askedKey, answer]) => askedKey.startsWith(`${memberId}#`) && answer !== "unreachable",
      );
    const refusedBy = (memberId: string) =>
      [...asked.entries()].some(
        ([askedKey, answer]) => askedKey.startsWith(`${memberId}#`) && answer === "refused",
      );
    const rows: ShutdownThreadRow[] = facts.map((entry) => ({
      thread: entry.thread,
      title: shortenedForListing(entry.title),
      ...(entry.projectName === undefined
        ? {}
        : { projectName: shortenedForListing(entry.projectName) }),
      busy: entry.busy,
      older:
        shutdownListing({
          thread: { activity: "idle", open: entry.open, lastTurnAt: entry.lastActivityAt },
          now,
        }) === "older" && !entry.busy,
      placements: members.map((member): ShutdownPlacement => {
        const answer = asked.get(`${String(member.memberId)}#${placementKey(entry)}`);
        const base = { memberId: member.memberId };
        if (entry.delegated) {
          return { ...base, reason: "delegated", projects: [], noProjectAllowed: false };
        }
        if (answer === undefined || answer === "unreachable") {
          return {
            ...base,
            reason: "destination-unreachable",
            projects: [],
            noProjectAllowed: false,
          };
        }
        if (answer === "refused") {
          return { ...base, reason: "refused", projects: [], noProjectAllowed: false };
        }
        const fits = answer.projects.length > 0 || answer.noProjectAllowed;
        return {
          ...base,
          ...(fits ? {} : { reason: "no-eligible-project" as const }),
          projects: answer.projects,
          noProjectAllowed: answer.noProjectAllowed,
        };
      }),
    }));
    const lastDeparture = this.#options.state.load().departures?.at(-1);
    return {
      status: "listed",
      members: members.map((member) => ({
        memberId: member.memberId,
        name: member.name,
        role: member.role === "hub" ? ("hub" as const) : ("spoke" as const),
        reachable: reachable(String(member.memberId)),
        ...(refusedBy(String(member.memberId)) ? { refusal: "refused" as const } : {}),
      })),
      rows,
      ...(lastDeparture === undefined ? {} : { lastMovedTo: lastDeparture.destinationMemberId }),
    };
  }

  /** The destination's challenge for one batch: one unlock covers exactly these threads. */
  shutdownChallenge(request: ShutdownChallengeRequest): Promise<ThreadMoveChallengeOutcome> {
    return this.#options.tickets.challenge(String(request.destinationMemberId), request.threads);
  }

  /**
   * Starts one destination's batch on a single ticket. Threads moving now go
   * one after another, so most finish early; one set to move after its turn
   * joins when that turn ends. Every way each ends is recorded by its move.
   */
  async shutdownStart(request: ShutdownStartRequest): Promise<ShutdownStartOutcome> {
    const threads = request.rows.map((row) => row.thread);
    const ticket = await this.#options.tickets.redeem({
      destinationMemberId: String(request.destinationMemberId),
      challengeId: request.unlock.challengeId,
      signature: request.unlock.signature,
      threads,
    });
    if (ticket.status === "refused") {
      for (const thread of threads) {
        this.#options.moves.refuseBeforeStart(thread, ticket.reason);
        this.#settle(thread);
      }
      return { status: "refused", reason: ticket.reason };
    }
    const queue = { tail: Promise.resolve() };
    for (const row of request.rows) {
      if (this.#isWaiting(row.thread)) continue;
      const reading = await this.#options.source.read(row.thread);
      this.#launch({
        thread: row.thread,
        destinationMemberId: request.destinationMemberId,
        ticketId: ticket.ticketId,
        ...(row.destinationProjectId === undefined
          ? {}
          : { destinationProjectId: row.destinationProjectId }),
        waitForTurn: reading.status === "found" && reading.busy && row.timing === "after-turn",
        queue,
      });
    }
    return { status: "started" };
  }

  #candidates(): ReadonlyArray<RosterMember> {
    const self = this.#options.selfMemberId();
    return this.#options
      .members()
      .filter(
        (member) =>
          String(member.memberId) !== self && (member.role === "hub" || member.role === "spoke"),
      );
  }

  /**
   * Moves one thread on a ticket already in hand: now, or once its running
   * turn ends, so nothing more is asked of the person when it does. A batch
   * passes its queue, and its moves run one after another.
   */
  #launch(input: {
    readonly thread: MovedThreadReference;
    readonly destinationMemberId: HubMemberId;
    readonly ticketId: string;
    readonly destinationProjectId?: ProjectId;
    readonly waitForTurn: boolean;
    readonly queue: { tail: Promise<void> } | undefined;
    /** Who unlocked it: this window's Touch ID, or the owner phone that confirmed it. */
    readonly principal?: AuditActingPrincipal;
  }): void {
    const { thread } = input;
    this.#settledAt.delete(key(thread));
    const run = async () => {
      await this.#options.moves
        .start({
          thread,
          targetMemberId: String(input.destinationMemberId),
          ticketId: input.ticketId,
          ...(input.destinationProjectId === undefined
            ? {}
            : { destinationProjectId: input.destinationProjectId }),
          principal: input.principal ?? { kind: "local-window" },
        })
        // Every way it ends is recorded by the move itself, notice included.
        .catch(() => undefined);
      // An interrupted move keeps its sending record, so it still reads as moving.
      this.#settle(thread);
    };
    const enqueue = () => {
      if (input.queue === undefined) {
        void run();
        return;
      }
      input.queue.tail = input.queue.tail.then(run);
    };
    if (!input.waitForTurn) {
      enqueue();
      return;
    }
    const startedWaitingAt = this.#options.now();
    const timer = setInterval(() => {
      void (async () => {
        const current = () => this.#waiting.get(key(thread))?.timer === timer;
        if (!current()) return;
        const now = await this.#options.source.read(thread);
        // Don't move may have been pressed, or another tick may have started
        // the move, while the thread was read: only the wait still current acts.
        if (!current()) return;
        if (now.status === "found" && now.busy) {
          if (this.#options.now() - startedWaitingAt > TICKET_WAIT_LIMIT_MS) {
            this.#stopWaiting(thread);
            this.#options.moves.refuseBeforeStart(thread, "unlock-required");
            this.#settle(thread);
          }
          return;
        }
        this.#stopWaiting(thread);
        enqueue();
      })();
    }, this.#options.pollMs ?? TURN_POLL_MS);
    timer.unref?.();
    this.#waiting.set(key(thread), { destinationMemberId: input.destinationMemberId, timer });
  }

  /** The person changed their mind before the turn ended. */
  stopWaiting(thread: MovedThreadReference): { readonly status: "stopped" } {
    if (this.#isWaiting(thread)) this.#settle(thread);
    this.#stopWaiting(thread);
    // Taken out of a phone's wait, the thread no longer moves when the phone
    // confirms; a wait with no thread left ends.
    const held = this.#phoneWaitFor(thread);
    if (held !== undefined) {
      const rows = held.wait.rows.filter((row) => !same(row.thread, thread));
      if (rows.length === 0) {
        clearTimeout(held.wait.timer);
        this.#phoneWaits.delete(held.confirmationId);
      } else {
        this.#phoneWaits.set(held.confirmationId, { ...held.wait, rows });
      }
    }
    return { status: "stopped" };
  }

  async cancel(moveId: string) {
    return this.#options.moves.cancel(moveId);
  }

  async takeBack(moveId: string): Promise<{ readonly status: "taken-back" }> {
    await this.#options.moves.takeBack(moveId);
    return { status: "taken-back" };
  }

  async activateAnyway(
    moveId: string,
  ): Promise<{ readonly status: string; readonly kind?: string }> {
    const answer = await this.#options.moves.activateAnyway(moveId);
    return answer.httpStatus === 200
      ? { status: "activated" }
      : { status: "refused", kind: "refused" };
  }

  dismiss(thread: MovedThreadReference): { readonly status: "dismissed" } {
    this.#options.moves.dismissFailure(thread);
    return { status: "dismissed" };
  }

  /** Where one thread stands, for its Environment tool, its bar, and its notice. */
  status(thread: MovedThreadReference): ThreadMoveThreadStatus {
    const state = this.#options.state.load();
    const nameOf = (memberId: string) =>
      this.#options.members().find((member) => String(member.memberId) === memberId)?.name ??
      "another computer";
    const sent = state.sent.find((move) => same(move.thread, thread));
    const received = state.received.find(
      (move) => move.state === "arrived" && move.thread !== undefined && same(move.thread, thread),
    );
    const failure = (state.failures ?? []).find((notice) => same(notice.thread, thread));
    const handedOver = (state.handovers ?? []).find((entry) => same(entry.thread, thread));
    const departure = (state.departures ?? []).findLast((entry) => same(entry.thread, thread));
    const waiting = this.#waiting.get(key(thread));
    this.#expirePhoneWaits();
    const phoneWait = this.#phoneWaitFor(thread)?.wait;
    const settledAt = this.#settledAt.get(key(thread));
    const status: ThreadMoveThreadStatus = {
      status: "read",
      ...(sent === undefined
        ? {}
        : {
            sending: {
              moveId: sent.moveId,
              destinationMemberId: sent.targetMemberId,
              destinationName: nameOf(String(sent.targetMemberId)),
              state: sent.state,
              bytesSent: bytesSent(sent),
              bytesTotal: (sent.offer?.manifest.parts ?? []).reduce(
                (total, part) => total + part.bytes,
                0,
              ),
              startedAt: sent.startedAt,
            },
          }),
      ...(waiting === undefined
        ? {}
        : {
            waiting: {
              destinationMemberId: waiting.destinationMemberId,
              destinationName: nameOf(String(waiting.destinationMemberId)),
            },
          }),
      ...(phoneWait === undefined
        ? {}
        : {
            waitingForPhone: {
              destinationMemberId: phoneWait.destinationMemberId,
              destinationName: nameOf(String(phoneWait.destinationMemberId)),
              expiresAt: phoneWait.expiresAt,
            },
          }),
      ...(settledAt === undefined ? {} : { settled: { settledAt } }),
      ...(received === undefined
        ? {}
        : {
            arriving: {
              moveId: received.moveId,
              originMemberId: received.senderMemberId,
              originName: nameOf(String(received.senderMemberId)),
              mayActivateAnyway: mayActivateAnyway({
                state: "arriving",
                lastHeardFromSourceAt: Date.parse(received.lastHeardAt),
                now: this.#options.now(),
              }),
            },
          }),
      ...(failure === undefined
        ? {}
        : {
            failure: {
              moveId: failure.moveId,
              reason: failure.reason,
              failedAt: failure.failedAt,
            },
          }),
      ...(handedOver === undefined ? {} : { handedOver }),
      ...(departure === undefined
        ? {}
        : {
            departed: {
              ...departure,
              destinationName: nameOf(String(departure.destinationMemberId)),
            },
          }),
    };
    return status;
  }

  /** Stops every wait, for shutdown. */
  close(): void {
    for (const waiting of this.#waiting.values()) clearInterval(waiting.timer);
    this.#waiting.clear();
    for (const wait of this.#phoneWaits.values()) clearTimeout(wait.timer);
    this.#phoneWaits.clear();
  }

  #settle(thread: MovedThreadReference): void {
    this.#settledAt.set(key(thread), new Date(this.#options.now()).toISOString() as UtcTimestamp);
  }

  #stopWaiting(thread: MovedThreadReference): void {
    const waiting = this.#waiting.get(key(thread));
    if (waiting !== undefined) clearInterval(waiting.timer);
    this.#waiting.delete(key(thread));
  }
}

/** A turn that outlasts the ticket ends the wait with `unlock-required`. */
const TICKET_WAIT_LIMIT_MS = 14 * 60_000;

function refuse(
  options: ThreadMovesFromWindowOptions,
  thread: MovedThreadReference,
  reason: ThreadMoveFailureReason,
): { readonly status: "refused"; readonly reason: ThreadMoveFailureReason } {
  options.moves.refuseBeforeStart(thread, reason);
  return { status: "refused", reason };
}

function key(thread: MovedThreadReference): string {
  return `${thread.mode}:${thread.threadId}`;
}

function same(left: MovedThreadReference, right: MovedThreadReference): boolean {
  return left.mode === right.mode && left.threadId === right.threadId;
}

function bytesSent(move: SentMove): number {
  return move.parts.reduce((total, part) => {
    const size =
      move.offer?.manifest.parts.find((entry) => entry.partId === part.partId)?.bytes ?? 0;
    return total + Math.min(size, part.acknowledgedChunks * THREAD_MOVE_CHUNK_BYTES);
  }, 0);
}

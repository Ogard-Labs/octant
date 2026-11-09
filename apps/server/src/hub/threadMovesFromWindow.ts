// What a window on the source asks of a thread move: which member computers
// could take the thread and into which Projects, the destination's owner
// challenge for this Mac's Touch ID, starting the move now or once the running
// turn ends, and where the thread stands. Canonical:
// docs/design/hub-and-spokes.md "Moving a thread to another member".
//
// A move can take minutes (there is no size limit), so starting one answers at
// once and the move runs on; the window reads its progress from the status.

import type {
  HubMemberId,
  MovedThreadReference,
  ProjectId,
  RosterMember,
  ShutdownChallengeRequest,
  ShutdownListing,
  ShutdownPlacement,
  ShutdownStartOutcome,
  ShutdownStartRequest,
  ShutdownThreadRow,
  ThreadMoveChallengeOutcome,
  ThreadMoveDestination,
  ThreadMoveDestinations,
  ThreadMoveFailureReason,
  ThreadMoveStartOutcome,
  ThreadMoveStartRequest,
  ThreadMoveThreadStatus,
  UtcTimestamp,
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

export class ThreadMovesFromWindow {
  readonly #options: ThreadMovesFromWindowOptions;
  readonly #waiting = new Map<string, Waiting>();
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
    if (this.#waiting.has(key(thread))) return refuse(this.#options, thread, "busy");
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
      if (this.#waiting.has(key(row.thread))) continue;
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
          principal: { kind: "local-window" },
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
    if (this.#waiting.has(key(thread))) this.#settle(thread);
    this.#stopWaiting(thread);
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
    const departure = (state.departures ?? []).findLast((entry) => same(entry.thread, thread));
    const waiting = this.#waiting.get(key(thread));
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
): ThreadMoveStartOutcome {
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

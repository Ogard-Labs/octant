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
  RosterMember,
  ThreadMoveChallengeOutcome,
  ThreadMoveDestination,
  ThreadMoveDestinations,
  ThreadMoveFailureReason,
  ThreadMoveStartOutcome,
  ThreadMoveStartRequest,
  ThreadMoveThreadStatus,
} from "@octant/contracts";
import { mayActivateAnyway } from "@octant/domain";
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
  readonly now: () => number;
  readonly pollMs?: number;
}

interface Waiting {
  readonly destinationMemberId: HubMemberId;
  readonly timer: ReturnType<typeof setInterval>;
}

export class ThreadMovesFromWindow {
  readonly #options: ThreadMovesFromWindowOptions;
  readonly #waiting = new Map<string, Waiting>();

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
    const self = this.#options.selfMemberId();
    const candidates = this.#options
      .members()
      .filter(
        (member) =>
          String(member.memberId) !== self && (member.role === "hub" || member.role === "spoke"),
      );
    const destinations = await Promise.all(
      candidates.map(async (member): Promise<ThreadMoveDestination> => {
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

    const run = () =>
      this.#options.moves.start({
        thread,
        targetMemberId: String(request.destinationMemberId),
        ticketId: ticket.ticketId,
        ...(request.destinationProjectId === undefined
          ? {}
          : { destinationProjectId: request.destinationProjectId }),
        principal: { kind: "local-window" },
      });

    if (!reading.busy) {
      // Every way it ends is recorded by the move itself, notice included.
      void run().catch(() => undefined);
      return { status: "started" };
    }

    // Move after this turn: the ticket is already in hand, so nothing more is
    // asked of the person when the turn ends.
    const startedWaitingAt = this.#options.now();
    const timer = setInterval(() => {
      void (async () => {
        const waiting = this.#waiting.get(key(thread));
        if (waiting === undefined || waiting.timer !== timer) return;
        const now = await this.#options.source.read(thread);
        if (now.status === "found" && now.busy) {
          if (this.#options.now() - startedWaitingAt > TICKET_WAIT_LIMIT_MS) {
            this.#stopWaiting(thread);
            this.#options.moves.refuseBeforeStart(thread, "unlock-required");
          }
          return;
        }
        this.#stopWaiting(thread);
        await run().catch(() => undefined);
      })();
    }, this.#options.pollMs ?? TURN_POLL_MS);
    timer.unref?.();
    this.#waiting.set(key(thread), {
      destinationMemberId: request.destinationMemberId,
      timer,
    });
    return { status: "waiting-for-turn" };
  }

  /** The person changed their mind before the turn ended. */
  stopWaiting(thread: MovedThreadReference): { readonly status: "stopped" } {
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

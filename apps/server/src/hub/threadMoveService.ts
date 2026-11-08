// Moving a thread from one of the person's computers to another before a
// planned shutdown. Both halves live here, because every host can be either.
//
// The source freezes the thread and records the freeze before anything leaves
// it, packs the thread into parts, and sends them over the pinned member link.
// The destination opens what arrived as a new thread that cannot take a turn
// until the source commits, and the source erases its copy only after the
// destination answers `committed`. So at most one copy can take a turn unless
// the person chose Take back here or Activate anyway.
//
// The destination's owner unlocks there first and gets a one-use ticket naming
// the source (an own-unlock action, like a sign-in copy); the ticket, not the
// sender, is what authorizes the move. Every later request names the move id
// and is idempotent, so a lost answer is asked again rather than repeated.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  HubMemberId,
  ThreadMoveId,
  decodeThreadMoveDestinationState,
  decodeThreadMoveOffer,
  THREAD_MOVE_FAILURE_REASONS,
  type AuditActingPrincipal,
  type MovedThreadReference,
  type ThreadMoveDestinationState,
  type ThreadMoveFailureReason,
  type ThreadMoveOffer,
  type ThreadMovePartKind,
  type UtcTimestamp,
} from "@octant/contracts";
import { mayActivateAnyway, recoverSourceMove } from "@octant/domain";
import { Schema } from "effect";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import { listenerPinFromDigest } from "./hubCrypto";
import type { HubHostIdentity } from "./hubService";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import type { MemberTarget } from "./spokeLinkService";
import type { ReceivedMove, SentMove, ThreadMoveStatePort } from "./threadMoveStateStore";

export const THREAD_MOVE_ROUTES = {
  offer: "/api/hub/peer/thread-moves",
  chunk: "/api/hub/peer/thread-moves/chunk",
  finish: "/api/hub/peer/thread-moves/finish",
  commit: "/api/hub/peer/thread-moves/commit",
  status: "/api/hub/peer/thread-moves/status",
  discard: "/api/hub/peer/thread-moves/discard",
} as const;

/** Bytes of one part per chunk; a chunk travels base64 in a JSON body under the route's 1 MiB cap. */
export const THREAD_MOVE_CHUNK_BYTES = 512 * 1024;
/** The body cap the gateway holds the chunk route to. */
export const THREAD_MOVE_CHUNK_MAX_BODY_BYTES = 1024 * 1024;
/** A move ticket outlives one unlock, because the person goes back to the source next. */
export const THREAD_MOVE_TICKET_LIFETIME_MS = 120_000;
/** How long a destination keeps a transfer that stopped part way. */
export const THREAD_MOVE_PARTIAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_TICKETS = 16;

/** A part the source packed, as a file in the move's staging folder. */
export interface PackedPart {
  readonly partId: string;
  readonly kind: ThreadMovePartKind;
  readonly path: string;
}

/** What the source host knows about a thread it may move. */
export type MovableThreadReading =
  | {
      readonly status: "found";
      readonly title: string;
      readonly busy: boolean;
      readonly delegated: boolean;
      readonly repositoryRemotes: ReadonlyArray<string>;
    }
  | { readonly status: "missing" };

/** The source host's side of a move: reading, freezing, packing, and erasing one thread. */
export interface ThreadMoveSourceHost {
  readonly read: (thread: MovedThreadReference) => Promise<MovableThreadReading>;
  /** Stops the thread from taking a turn; the caller records the freeze first. */
  readonly freeze: (thread: MovedThreadReference) => void;
  readonly unfreeze: (thread: MovedThreadReference) => void;
  readonly isFrozen: (thread: MovedThreadReference) => boolean;
  /** Writes the thread's parts into `folder`; exactly one part is the thread bundle. */
  readonly pack: (
    thread: MovedThreadReference,
    folder: string,
    moveId: ThreadMoveId,
  ) => Promise<
    | { readonly status: "packed"; readonly parts: ReadonlyArray<PackedPart> }
    | { readonly status: "refused"; readonly reason: ThreadMoveFailureReason }
  >;
  /** Erases the thread through the ordinary purge once the destination committed. */
  readonly erase: (input: {
    readonly thread: MovedThreadReference;
    readonly moveId: ThreadMoveId;
  }) => Promise<{ readonly worktreeKept: boolean }>;
}

/** The destination host's side: accepting a Project, opening a thread from parts, and activating it. */
export interface ThreadMoveDestinationHost {
  /** Whether the offer's destination Project fits the thread's mode (and, for Code, its repository). */
  readonly acceptsProject: (offer: ThreadMoveOffer) => boolean | Promise<boolean>;
  /**
   * Opens the new thread under the id the move planned for it, held so it
   * cannot take a turn. Called again with the same id after a stop between
   * opening the thread and recording it, so a thread that already exists
   * under that id is held and answered as arrived, never opened twice.
   */
  readonly arrive: (input: {
    readonly thread: MovedThreadReference;
    readonly offer: ThreadMoveOffer;
    readonly parts: ReadonlyMap<string, string>;
    readonly origin: { readonly memberId: HubMemberId; readonly thread: MovedThreadReference };
    readonly ownerMemberId: HubMemberId;
  }) => Promise<
    | { readonly status: "arrived"; readonly thread: MovedThreadReference }
    | {
        readonly status: "refused";
        readonly reason: "no-eligible-project" | "transfer-failed" | "no-matching-provider";
      }
  >;
  /** Lets the arrived thread take turns. */
  readonly activate: (thread: MovedThreadReference) => Promise<void>;
  /** Removes an arrived thread that will not be committed. */
  readonly discard: (thread: MovedThreadReference) => Promise<void>;
}

/** What each step records; the wiring writes these to the journal. */
export interface ThreadMoveRecorder {
  readonly moveStarted: (input: {
    readonly moveId: ThreadMoveId;
    readonly thread: MovedThreadReference;
    readonly destinationMemberId: HubMemberId;
  }) => void;
  readonly movedIn: (input: {
    readonly moveId: ThreadMoveId;
    readonly thread: MovedThreadReference;
    readonly origin: { readonly memberId: HubMemberId; readonly thread: MovedThreadReference };
    readonly ownerMemberId: HubMemberId;
  }) => void;
  readonly moveCommitted: (input: {
    readonly moveId: ThreadMoveId;
    readonly thread: MovedThreadReference;
    readonly by: "source" | "activated-anyway";
  }) => void;
  readonly movedOut: (input: {
    readonly moveId: ThreadMoveId;
    readonly thread: MovedThreadReference;
    readonly destination: { readonly memberId: HubMemberId; readonly thread: MovedThreadReference };
    readonly worktreeKept: boolean;
  }) => void;
  readonly moveFailed: (input: {
    readonly moveId: ThreadMoveId;
    readonly thread: MovedThreadReference;
    readonly reason: ThreadMoveFailureReason;
  }) => void;
}

export interface ThreadMoveServiceOptions {
  readonly state: ThreadMoveStatePort;
  readonly source: ThreadMoveSourceHost;
  readonly destination: ThreadMoveDestinationHost;
  readonly record: ThreadMoveRecorder;
  readonly identity: () => HubHostIdentity;
  readonly target: (memberId: string) => MemberTarget;
  readonly transport: HubTransport;
  /**
   * Who signed a request, as this host's role judges it: a spoke checks the
   * roster it holds and its peer grants, the hub the roster it signs and its
   * Accept moved threads setting. A guest is never a sender.
   */
  readonly authenticate: (request: SignedRequest) => MoveSender;
  /** Whether this host still lists the owner as an owner device that is not revoked. */
  readonly ownerIsCurrent: (ownerMemberId: string) => boolean;
  readonly now: () => number;
  readonly uuid?: () => string;
}

export type MoveSender =
  | { readonly status: "member"; readonly memberId: string; readonly moveIn: boolean }
  | { readonly status: "refused" };

export interface SignedRequest {
  readonly header: string | null;
  readonly publicKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export type TicketOutcome =
  | { readonly status: "issued"; readonly ticketId: string; readonly expiresAt: number }
  | { readonly status: "refused"; readonly reason: "refused" };

/** How a move a person started ended, or where it stopped. */
export type MoveOutcome =
  | {
      readonly status: "moved";
      readonly destination: MovedThreadReference;
      readonly worktreeKept: boolean;
    }
  | { readonly status: "failed"; readonly reason: ThreadMoveFailureReason }
  /** The destination stopped answering; the thread stays frozen and the move resumes on retry. */
  | { readonly status: "interrupted" };

/** The answer a destination route gives, with the HTTP status the route sends. */
export type DestinationAnswer = {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
};

interface Ticket {
  readonly ownerMemberId: string;
  readonly sourceMemberId: string;
  readonly expiresAt: number;
}

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeMoveId = Schema.decodeUnknownSync(ThreadMoveId);

export class ThreadMoveService {
  readonly #options: ThreadMoveServiceOptions;
  readonly #tickets = new Map<string, Ticket>();

  constructor(options: ThreadMoveServiceOptions) {
    this.#options = options;
  }

  // ── Destination ────────────────────────────────────────────────────────

  /** An owner device, unlocked here, lets one named computer move one thread here. */
  issueTicket(input: {
    readonly ownerMemberId: string;
    readonly sourceMemberId: string;
  }): TicketOutcome {
    const now = this.#options.now();
    for (const [ticketId, ticket] of this.#tickets) {
      if (ticket.expiresAt < now) this.#tickets.delete(ticketId);
    }
    const source = this.#options.target(input.sourceMemberId);
    if (source.status === "refused" || source.member.role === "guest") {
      return { status: "refused", reason: "refused" };
    }
    if (this.#tickets.size >= MAX_OPEN_TICKETS) return { status: "refused", reason: "refused" };
    const ticketId = this.#uuid();
    const expiresAt = now + THREAD_MOVE_TICKET_LIFETIME_MS;
    this.#tickets.set(ticketId, {
      ownerMemberId: input.ownerMemberId,
      sourceMemberId: input.sourceMemberId,
      expiresAt,
    });
    return { status: "issued", ticketId, expiresAt };
  }

  async receiveOffer(request: SignedRequest): Promise<DestinationAnswer> {
    const sender = this.#authenticate(request);
    if (sender === undefined) return refusedAnswer(undefined, "refused");
    let body: { ticketId: string; offer: ThreadMoveOffer };
    try {
      const parsed: unknown = JSON.parse(request.body);
      body = {
        ticketId: stringField(parsed, "ticketId"),
        offer: decodeThreadMoveOffer(objectField(parsed, "offer")),
      };
    } catch {
      return { httpStatus: 400, body: { status: "refused", reason: "invalid" } };
    }
    const { offer } = body;
    const existing = this.#received(offer.moveId);
    if (existing !== undefined) {
      if (String(existing.senderMemberId) !== sender.memberId) {
        return refusedAnswer(offer.moveId, "refused");
      }
      return this.#stateAnswer(existing);
    }
    // The ticket is single-use: it is gone once any offer answers it.
    const ticket = this.#tickets.get(body.ticketId);
    this.#tickets.delete(body.ticketId);
    if (ticket === undefined || ticket.sourceMemberId !== sender.memberId) {
      return refusedAnswer(offer.moveId, "refused");
    }
    if (this.#options.now() > ticket.expiresAt) {
      return refusedAnswer(offer.moveId, "unlock-required");
    }
    if (!sender.moveIn || !this.#options.ownerIsCurrent(ticket.ownerMemberId)) {
      return refusedAnswer(offer.moveId, "refused");
    }
    if (!(await this.#options.destination.acceptsProject(offer))) {
      return refusedAnswer(offer.moveId, "no-eligible-project");
    }
    const now = this.#timestamp();
    const move: ReceivedMove = {
      moveId: offer.moveId,
      senderMemberId: decodeMemberId(sender.memberId),
      ownerMemberId: decodeMemberId(ticket.ownerMemberId),
      offer,
      state: "receiving",
      chunks: Object.fromEntries(offer.manifest.parts.map((part) => [part.partId, 0])),
      receivedAt: now,
      lastHeardAt: now,
    };
    this.#saveReceived(move);
    return {
      httpStatus: 200,
      body: { status: "ready", moveId: offer.moveId, ticket: offer.moveId },
    };
  }

  async receiveChunk(request: SignedRequest): Promise<DestinationAnswer> {
    const sender = this.#authenticate(request);
    if (sender === undefined) return refusedAnswer(undefined, "refused");
    let chunk: { moveId: ThreadMoveId; partId: string; index: number; data: Buffer };
    try {
      const parsed: unknown = JSON.parse(request.body);
      const index = numberField(parsed, "index");
      if (!Number.isInteger(index) || index < 0) throw new Error("index");
      chunk = {
        moveId: decodeMoveId(stringField(parsed, "moveId")),
        partId: stringField(parsed, "partId"),
        index,
        data: Buffer.from(stringField(parsed, "data"), "base64"),
      };
    } catch {
      return { httpStatus: 400, body: { status: "refused", reason: "invalid" } };
    }
    const move = this.#heardFrom(chunk.moveId, sender.memberId);
    if (move === undefined || move.state !== "receiving") {
      return refusedAnswer(chunk.moveId, "refused");
    }
    const part = move.offer.manifest.parts.find((entry) => entry.partId === chunk.partId);
    const have = move.chunks[chunk.partId];
    if (part === undefined || have === undefined) return refusedAnswer(chunk.moveId, "refused");
    // A chunk already held is acknowledged again; one past the next is refused with the count.
    if (chunk.index === have) {
      if (chunk.data.length > THREAD_MOVE_CHUNK_BYTES)
        return refusedAnswer(chunk.moveId, "refused");
      const folder = this.#options.state.partsDirectory(String(move.moveId));
      await appendFile(join(folder, safePartFile(chunk.partId)), chunk.data, { mode: 0o600 });
      this.#saveReceived({ ...move, chunks: { ...move.chunks, [chunk.partId]: have + 1 } });
      return acknowledged(chunk.moveId, chunk.partId, have + 1);
    }
    if (chunk.index < have) return acknowledged(chunk.moveId, chunk.partId, have);
    return {
      httpStatus: 409,
      body: { status: "out-of-order", moveId: chunk.moveId, partId: chunk.partId, chunks: have },
    };
  }

  async finish(request: SignedRequest): Promise<DestinationAnswer> {
    const named = this.#namedMove(request);
    if (named.status === "answer") return named.answer;
    const { move } = named;
    if (move.state !== "receiving") return this.#stateAnswer(move);
    const folder = this.#options.state.partsDirectory(String(move.moveId));
    const parts = new Map<string, string>();
    for (const part of move.offer.manifest.parts) {
      const path = join(folder, safePartFile(part.partId));
      const intact =
        (await fileBytes(path)) === part.bytes && (await fileSha256(path)) === part.sha256;
      if (!intact) {
        // A part that does not match is dropped so the source sends it again from the start.
        await rm(path, { force: true });
        this.#saveReceived({ ...move, chunks: { ...move.chunks, [part.partId]: 0 } });
        return refusedAnswer(move.moveId, "transfer-failed");
      }
      parts.set(part.partId, path);
    }
    const origin = { memberId: move.senderMemberId, thread: move.offer.source };
    // The new thread's id is recorded before the thread exists, so a host that
    // stops between the two finds it on restart, holds it, and opens no second.
    const planned: MovedThreadReference = move.thread ?? {
      mode: move.offer.source.mode,
      threadId: this.#uuid(),
    };
    if (move.thread === undefined) this.#saveReceived({ ...move, thread: planned });
    const arrival = await this.#options.destination.arrive({
      thread: planned,
      offer: move.offer,
      parts,
      origin,
      ownerMemberId: move.ownerMemberId,
    });
    if (arrival.status === "refused") return refusedAnswer(move.moveId, arrival.reason);
    this.#options.record.movedIn({
      moveId: move.moveId,
      thread: arrival.thread,
      origin,
      ownerMemberId: move.ownerMemberId,
    });
    const arrived: ReceivedMove = { ...move, state: "arrived", thread: arrival.thread };
    this.#saveReceived(arrived);
    return this.#stateAnswer(arrived);
  }

  async commit(request: SignedRequest): Promise<DestinationAnswer> {
    const named = this.#namedMove(request);
    if (named.status === "answer") return named.answer;
    const { move } = named;
    if (move.state !== "arrived" || move.thread === undefined) return this.#stateAnswer(move);
    return this.#commitReceived(move, "source");
  }

  async status(request: SignedRequest): Promise<DestinationAnswer> {
    const sender = this.#authenticate(request);
    if (sender === undefined) return refusedAnswer(undefined, "refused");
    let moveId: ThreadMoveId;
    try {
      moveId = decodeMoveId(stringField(JSON.parse(request.body), "moveId"));
    } catch {
      return { httpStatus: 400, body: { status: "refused", reason: "invalid" } };
    }
    const move = this.#heardFrom(moveId, sender.memberId);
    if (move === undefined) return { httpStatus: 200, body: { state: "unknown", moveId } };
    return { httpStatus: 200, body: destinationState(move) };
  }

  async discard(request: SignedRequest): Promise<DestinationAnswer> {
    const named = this.#namedMove(request);
    if (named.status === "answer") return named.answer;
    const { move } = named;
    if (move.state === "committed") return this.#stateAnswer(move);
    await this.#discardReceived(move);
    return { httpStatus: 200, body: { state: "discarded", moveId: move.moveId } };
  }

  /**
   * A person on this host activates a thread whose source went silent after it
   * arrived. The source froze before it sent anything, so it cannot have gone on.
   */
  async activateAnyway(moveId: string): Promise<DestinationAnswer> {
    const move = this.#received(moveId);
    if (move === undefined || move.state !== "arrived" || move.thread === undefined) {
      return refusedAnswer(undefined, "refused");
    }
    const allowed = mayActivateAnyway({
      state: "arriving",
      lastHeardFromSourceAt: Date.parse(move.lastHeardAt),
      now: this.#options.now(),
    });
    if (!allowed) return refusedAnswer(move.moveId, "refused");
    return this.#commitReceived(move, "activated-anyway");
  }

  /** Drops transfers that stopped part way more than seven days ago. */
  async sweepPartial(): Promise<void> {
    const cutoff = this.#options.now() - THREAD_MOVE_PARTIAL_LIFETIME_MS;
    for (const move of this.#options.state.load().received) {
      if (move.state === "receiving" && Date.parse(move.lastHeardAt) < cutoff) {
        await this.#discardReceived(move);
      }
    }
  }

  // ── Source ─────────────────────────────────────────────────────────────

  /**
   * Moves one thread to a member, with the ticket the destination's owner
   * issued. A busy thread is refused here; Move after this turn and Stop and
   * move are the caller's to arrange before it calls.
   */
  async start(input: {
    readonly thread: MovedThreadReference;
    readonly targetMemberId: string;
    readonly ticketId: string;
    readonly destinationProjectId?: ThreadMoveOffer["destinationProjectId"];
    readonly principal: AuditActingPrincipal;
  }): Promise<MoveOutcome> {
    const target = this.#options.target(input.targetMemberId);
    if (target.status === "refused" || memberOrigin(target.member) === undefined) {
      return { status: "failed", reason: "destination-unreachable" };
    }
    const reading = await this.#options.source.read(input.thread);
    if (reading.status === "missing") return { status: "failed", reason: "refused" };
    if (reading.delegated) return { status: "failed", reason: "delegated" };
    if (reading.busy) return { status: "failed", reason: "busy" };
    if (this.#sentFor(input.thread) !== undefined) return { status: "failed", reason: "busy" };

    const moveId = decodeMoveId(this.#uuid());
    // The freeze is recorded before anything leaves this host.
    this.#options.record.moveStarted({
      moveId,
      thread: input.thread,
      destinationMemberId: target.member.memberId,
    });
    this.#options.source.freeze(input.thread);
    const move: SentMove = {
      moveId,
      thread: input.thread,
      targetMemberId: target.member.memberId,
      parts: [],
      state: "frozen",
      startedAt: this.#timestamp(),
    };
    this.#saveSent(move);

    const folder = this.#options.state.partsDirectory(String(moveId));
    const packed = await this.#options.source.pack(input.thread, folder, moveId);
    if (packed.status === "refused") return this.#fail(move, packed.reason);
    let offer: ThreadMoveOffer;
    try {
      offer = decodeThreadMoveOffer({
        moveId,
        source: input.thread,
        title: reading.title,
        ...(input.destinationProjectId === undefined
          ? {}
          : { destinationProjectId: input.destinationProjectId }),
        ...(input.thread.mode === "code" ? { repositoryRemotes: reading.repositoryRemotes } : {}),
        manifest: {
          parts: await Promise.all(
            packed.parts.map(async (part) => ({
              partId: part.partId,
              kind: part.kind,
              bytes: await fileBytes(part.path),
              sha256: await fileSha256(part.path),
            })),
          ),
        },
      });
    } catch {
      return this.#fail(move, "transfer-failed");
    }
    const offered: SentMove = {
      ...move,
      offer,
      parts: offer.manifest.parts.map((part) => ({ partId: part.partId, acknowledgedChunks: 0 })),
    };
    this.#saveSent(offered);
    const answer = await this.#send(offered, THREAD_MOVE_ROUTES.offer, {
      ticketId: input.ticketId,
      offer,
    });
    if (answer.status === "unreachable") return this.#fail(offered, "destination-unreachable");
    if (answer.body.status !== "ready") {
      return this.#fail(offered, refusalReason(answer.body.reason));
    }
    const sending: SentMove = { ...offered, state: "offered" };
    this.#saveSent(sending);
    return this.#continue(sending, packed.parts);
  }

  /**
   * Resumes every move this host was sending when it stopped, from what each
   * destination holds. Only `committed` leads to the erase.
   */
  async recover(): Promise<ReadonlyArray<MoveOutcome>> {
    const outcomes: MoveOutcome[] = [];
    for (const move of this.#options.state.load().sent) {
      if (!this.#options.source.isFrozen(move.thread)) this.#options.source.freeze(move.thread);
      outcomes.push(await this.resume(String(move.moveId)));
    }
    return outcomes;
  }

  /** Continues one move from what its destination holds. */
  async resume(moveId: string): Promise<MoveOutcome> {
    const move = this.#sent(moveId);
    if (move === undefined) return { status: "failed", reason: "refused" };
    if (move.offer === undefined || move.state === "frozen") {
      // The offer never reached the destination; nothing there to resume.
      return this.#fail(move, "destination-unreachable");
    }
    const answer = await this.#send(move, THREAD_MOVE_ROUTES.status, { moveId: move.moveId });
    if (answer.status === "unreachable") return { status: "interrupted" };
    let state: ThreadMoveDestinationState;
    try {
      state = decodeThreadMoveDestinationState(answer.body);
    } catch {
      return { status: "interrupted" };
    }
    const next = recoverSourceMove(state);
    switch (next.action) {
      case "erase":
        return this.#erase(move, "thread" in state ? state.thread : undefined);
      case "commit":
        return this.#commitSent({
          ...move,
          state: "arrived",
          ...("thread" in state ? { destinationThread: state.thread } : {}),
        });
      case "resume-transfer": {
        const acknowledged = "acknowledged" in state ? state.acknowledged : [];
        const resumed: SentMove = {
          ...move,
          state: "offered",
          parts: move.parts.map((part) => ({
            partId: part.partId,
            acknowledgedChunks:
              acknowledged.find((entry) => entry.partId === part.partId)?.chunks ?? 0,
          })),
        };
        this.#saveSent(resumed);
        return this.#continue(resumed, this.#stagedParts(resumed));
      }
      case "unfreeze":
        return this.#fail(move, "destination-unreachable");
    }
  }

  /**
   * The person cancels before the destination committed. The source unfreezes
   * only once the destination discarded what it held, so the two never both run.
   */
  async cancel(
    moveId: string,
  ): Promise<
    | { readonly status: "cancelled" }
    | { readonly status: "already-moved" }
    | { readonly status: "destination-unreachable" }
  > {
    const move = this.#sent(moveId);
    if (move === undefined) return { status: "cancelled" };
    if (move.offer === undefined || move.state === "frozen") {
      await this.#unfreezeSent(move);
      return { status: "cancelled" };
    }
    const answer = await this.#send(move, THREAD_MOVE_ROUTES.discard, { moveId: move.moveId });
    if (answer.status === "unreachable") return { status: "destination-unreachable" };
    if (answer.body.state === "committed") {
      // Activate anyway may have committed it while this host never heard the
      // destination's thread; the committed answer names it.
      const erased = await this.#erase(move, threadOf(answer.body));
      return erased.status === "moved"
        ? { status: "already-moved" }
        : { status: "destination-unreachable" };
    }
    await this.#unfreezeSent(move);
    return { status: "cancelled" };
  }

  /**
   * Take back here: the person unfreezes a thread whose destination cannot be
   * reached to confirm a discard. The destination may still hold a copy.
   */
  async takeBack(moveId: string): Promise<void> {
    const move = this.#sent(moveId);
    if (move !== undefined) await this.#unfreezeSent(move);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  async #continue(
    move: SentMove,
    parts: ReadonlyArray<PackedPart>,
    retried = false,
  ): Promise<MoveOutcome> {
    let current = move;
    for (const part of parts) {
      const sent = await this.#sendPart(current, part);
      if (sent.status !== "sent") return sent.outcome;
      current = sent.move;
    }
    const finish = await this.#send(current, THREAD_MOVE_ROUTES.finish, {
      moveId: current.moveId,
    });
    if (finish.status === "unreachable") return { status: "interrupted" };
    if (finish.body.reason === "transfer-failed") {
      // A part failed its digest check and the destination dropped it. It is
      // sent once more from the start; a second failure ends the move.
      if (retried) return this.#fail(current, "transfer-failed");
      const status = await this.#send(current, THREAD_MOVE_ROUTES.status, {
        moveId: current.moveId,
      });
      if (status.status === "unreachable") return { status: "interrupted" };
      const acknowledged = Array.isArray(status.body.acknowledged)
        ? (status.body.acknowledged as ReadonlyArray<{ partId?: unknown; chunks?: unknown }>)
        : [];
      const resent: SentMove = {
        ...current,
        parts: current.parts.map((part) => {
          const held = acknowledged.find((entry) => entry.partId === part.partId)?.chunks;
          return { partId: part.partId, acknowledgedChunks: typeof held === "number" ? held : 0 };
        }),
      };
      this.#saveSent(resent);
      return this.#continue(resent, parts, true);
    }
    if (finish.body.state !== "arrived" && finish.body.state !== "committed") {
      return this.#fail(current, refusalReason(finish.body.reason));
    }
    const thread = threadOf(finish.body);
    if (finish.body.state === "committed") return this.#erase(current, thread);
    return this.#commitSent({
      ...current,
      state: "arrived",
      ...(thread === undefined ? {} : { destinationThread: thread }),
    });
  }

  async #sendPart(
    move: SentMove,
    part: PackedPart,
  ): Promise<
    | { readonly status: "sent"; readonly move: SentMove }
    | { readonly status: "stopped"; readonly outcome: MoveOutcome }
  > {
    let current = move;
    const bytes = await fileBytes(part.path);
    const total = Math.max(1, Math.ceil(bytes / THREAD_MOVE_CHUNK_BYTES));
    const handle = await open(part.path, "r");
    try {
      let index =
        current.parts.find((entry) => entry.partId === part.partId)?.acknowledgedChunks ?? 0;
      while (index < total && !(bytes === 0 && index > 0)) {
        const buffer = Buffer.alloc(
          Math.min(THREAD_MOVE_CHUNK_BYTES, Math.max(0, bytes - index * THREAD_MOVE_CHUNK_BYTES)),
        );
        if (buffer.length > 0)
          await handle.read(buffer, 0, buffer.length, index * THREAD_MOVE_CHUNK_BYTES);
        const answer = await this.#send(current, THREAD_MOVE_ROUTES.chunk, {
          moveId: current.moveId,
          partId: part.partId,
          index,
          data: buffer.toString("base64"),
        });
        if (answer.status === "unreachable") {
          return { status: "stopped", outcome: { status: "interrupted" } };
        }
        const chunks = answer.body.chunks;
        if (typeof chunks !== "number") {
          return {
            status: "stopped",
            outcome: await this.#fail(current, refusalReason(answer.body.reason)),
          };
        }
        index = chunks;
        current = {
          ...current,
          parts: current.parts.map((entry) =>
            entry.partId === part.partId ? { ...entry, acknowledgedChunks: chunks } : entry,
          ),
        };
        this.#saveSent(current);
        if (bytes === 0) break;
      }
    } finally {
      await handle.close();
    }
    return { status: "sent", move: current };
  }

  async #commitSent(move: SentMove): Promise<MoveOutcome> {
    this.#saveSent(move);
    const answer = await this.#send(move, THREAD_MOVE_ROUTES.commit, { moveId: move.moveId });
    if (answer.status === "unreachable") return { status: "interrupted" };
    if (answer.body.state !== "committed") {
      return this.#fail(move, refusalReason(answer.body.reason));
    }
    return this.#erase(move, threadOf(answer.body) ?? move.destinationThread);
  }

  async #erase(
    move: SentMove,
    destinationThread: MovedThreadReference | undefined,
  ): Promise<MoveOutcome> {
    const destination = destinationThread ?? move.destinationThread;
    if (destination === undefined) return { status: "interrupted" };
    this.#saveSent({ ...move, state: "committed", destinationThread: destination });
    const erased = await this.#options.source.erase({ thread: move.thread, moveId: move.moveId });
    this.#options.record.movedOut({
      moveId: move.moveId,
      thread: move.thread,
      destination: { memberId: move.targetMemberId, thread: destination },
      worktreeKept: erased.worktreeKept,
    });
    this.#options.source.unfreeze(move.thread);
    await this.#forgetSent(move);
    return { status: "moved", destination, worktreeKept: erased.worktreeKept };
  }

  async #fail(move: SentMove, reason: ThreadMoveFailureReason): Promise<MoveOutcome> {
    this.#options.record.moveFailed({ moveId: move.moveId, thread: move.thread, reason });
    await this.#unfreezeSent(move);
    return { status: "failed", reason };
  }

  async #unfreezeSent(move: SentMove): Promise<void> {
    this.#options.source.unfreeze(move.thread);
    await this.#forgetSent(move);
  }

  async #forgetSent(move: SentMove): Promise<void> {
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      sent: state.sent.filter((entry) => String(entry.moveId) !== String(move.moveId)),
    });
    await rm(this.#options.state.partsDirectory(String(move.moveId)), {
      recursive: true,
      force: true,
    });
  }

  async #commitReceived(
    move: ReceivedMove,
    by: "source" | "activated-anyway",
  ): Promise<DestinationAnswer> {
    if (move.thread === undefined) return refusedAnswer(move.moveId, "refused");
    await this.#options.destination.activate(move.thread);
    this.#options.record.moveCommitted({ moveId: move.moveId, thread: move.thread, by });
    const committed: ReceivedMove = { ...move, state: "committed" };
    this.#saveReceived(committed);
    await rm(this.#options.state.partsDirectory(String(move.moveId)), {
      recursive: true,
      force: true,
    });
    return this.#stateAnswer(committed);
  }

  async #discardReceived(move: ReceivedMove): Promise<void> {
    if (move.thread !== undefined) await this.#options.destination.discard(move.thread);
    const { thread: _dropped, ...rest } = move;
    this.#saveReceived({ ...rest, state: "discarded" });
    await rm(this.#options.state.partsDirectory(String(move.moveId)), {
      recursive: true,
      force: true,
    });
  }

  #stagedParts(move: SentMove): ReadonlyArray<PackedPart> {
    const folder = this.#options.state.partsDirectory(String(move.moveId));
    return (move.offer?.manifest.parts ?? []).map((part) => ({
      partId: part.partId,
      kind: part.kind,
      path: join(folder, safePartFile(part.partId)),
    }));
  }

  async #send(
    move: SentMove,
    path: string,
    body: unknown,
  ): Promise<
    | { readonly status: "answered"; readonly body: Record<string, unknown> }
    | { readonly status: "unreachable" }
  > {
    const target = this.#options.target(String(move.targetMemberId));
    if (target.status === "refused") return { status: "unreachable" };
    const origin = memberOrigin(target.member);
    if (origin === undefined) return { status: "unreachable" };
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin, pin: listenerPinFromDigest(target.member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(target.self),
      recipientMemberId: String(target.member.memberId),
      method: "POST",
      path,
      body: JSON.stringify(body),
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return { status: "unreachable" };
    const reply: unknown = await answer.response.json().catch(() => undefined);
    if (typeof reply !== "object" || reply === null) return { status: "unreachable" };
    return { status: "answered", body: reply as Record<string, unknown> };
  }

  #authenticate(
    request: SignedRequest,
  ): { readonly memberId: string; readonly moveIn: boolean } | undefined {
    const authenticated = this.#options.authenticate(request);
    if (authenticated.status === "refused") return undefined;
    return { memberId: authenticated.memberId, moveIn: authenticated.moveIn };
  }

  #namedMove(
    request: SignedRequest,
  ):
    | { readonly status: "move"; readonly move: ReceivedMove }
    | { readonly status: "answer"; readonly answer: DestinationAnswer } {
    const sender = this.#authenticate(request);
    if (sender === undefined)
      return { status: "answer", answer: refusedAnswer(undefined, "refused") };
    let moveId: ThreadMoveId;
    try {
      moveId = decodeMoveId(stringField(JSON.parse(request.body), "moveId"));
    } catch {
      return {
        status: "answer",
        answer: { httpStatus: 400, body: { status: "refused", reason: "invalid" } },
      };
    }
    const move = this.#heardFrom(moveId, sender.memberId);
    if (move === undefined) return { status: "answer", answer: refusedAnswer(moveId, "refused") };
    return { status: "move", move };
  }

  /** The move, if this sender owns it; marks the source as heard from for Activate anyway. */
  #heardFrom(moveId: ThreadMoveId, senderMemberId: string): ReceivedMove | undefined {
    const move = this.#received(moveId);
    if (move === undefined || String(move.senderMemberId) !== senderMemberId) return undefined;
    const heard: ReceivedMove = { ...move, lastHeardAt: this.#timestamp() };
    this.#saveReceived(heard);
    return heard;
  }

  #stateAnswer(move: ReceivedMove): DestinationAnswer {
    if (move.state === "receiving") {
      return {
        httpStatus: 200,
        body: {
          status: "ready",
          moveId: move.moveId,
          ticket: move.moveId,
          ...destinationState(move),
        },
      };
    }
    return { httpStatus: 200, body: destinationState(move) };
  }

  #received(moveId: string): ReceivedMove | undefined {
    return this.#options.state
      .load()
      .received.find((entry) => String(entry.moveId) === String(moveId));
  }

  #saveReceived(move: ReceivedMove): void {
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      received: [
        ...state.received.filter((entry) => String(entry.moveId) !== String(move.moveId)),
        move,
      ],
    });
  }

  #sent(moveId: string): SentMove | undefined {
    return this.#options.state.load().sent.find((entry) => String(entry.moveId) === moveId);
  }

  #sentFor(thread: MovedThreadReference): SentMove | undefined {
    return this.#options.state
      .load()
      .sent.find(
        (entry) => entry.thread.mode === thread.mode && entry.thread.threadId === thread.threadId,
      );
  }

  #saveSent(move: SentMove): void {
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      sent: [...state.sent.filter((entry) => String(entry.moveId) !== String(move.moveId)), move],
    });
  }

  #timestamp(): UtcTimestamp {
    return new Date(this.#options.now()).toISOString() as UtcTimestamp;
  }

  #uuid(): string {
    return (this.#options.uuid ?? randomUUID)();
  }
}

function destinationState(move: ReceivedMove): Record<string, unknown> {
  switch (move.state) {
    case "receiving":
      return {
        state: "receiving",
        moveId: move.moveId,
        acknowledged: Object.entries(move.chunks).map(([partId, chunks]) => ({ partId, chunks })),
      };
    case "arrived":
    case "committed":
      return move.thread === undefined
        ? { state: "unknown", moveId: move.moveId }
        : { state: move.state, moveId: move.moveId, thread: move.thread };
    case "discarded":
      return { state: "discarded", moveId: move.moveId };
  }
}

function refusedAnswer(
  moveId: ThreadMoveId | undefined,
  reason:
    | "refused"
    | "unlock-required"
    | "no-eligible-project"
    | "transfer-failed"
    | "no-matching-provider",
): DestinationAnswer {
  // Every missing permission answers in the same words, with the same status.
  return {
    httpStatus: reason === "refused" ? 403 : 409,
    body: { status: "refused", reason, ...(moveId === undefined ? {} : { moveId }) },
  };
}

function acknowledged(moveId: ThreadMoveId, partId: string, chunks: number): DestinationAnswer {
  return { httpStatus: 200, body: { status: "acknowledged", moveId, partId, chunks } };
}

const FAILURE_REASONS: ReadonlyArray<ThreadMoveFailureReason> = THREAD_MOVE_FAILURE_REASONS;

function refusalReason(reason: unknown): ThreadMoveFailureReason {
  return FAILURE_REASONS.find((known) => known === reason) ?? "refused";
}

function threadOf(body: Record<string, unknown>): MovedThreadReference | undefined {
  const thread = body.thread;
  if (typeof thread !== "object" || thread === null) return undefined;
  const { mode, threadId } = thread as { mode?: unknown; threadId?: unknown };
  if ((mode === "chat" || mode === "work" || mode === "code") && typeof threadId === "string") {
    return { mode, threadId };
  }
  return undefined;
}

/** Part ids come from the manifest; the file name keeps only safe characters so it cannot leave the folder. */
function safePartFile(partId: string): string {
  return `${partId.replace(/[^A-Za-z0-9_-]/g, "_")}.part`;
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch {
    return "";
  }
  return hash.digest("hex");
}

function stringField(value: unknown, key: string): string {
  const field = (value as Record<string, unknown> | null)?.[key];
  if (typeof field !== "string") throw new Error(key);
  return field;
}

function numberField(value: unknown, key: string): number {
  const field = (value as Record<string, unknown> | null)?.[key];
  if (typeof field !== "number") throw new Error(key);
  return field;
}

function objectField(value: unknown, key: string): unknown {
  const field = (value as Record<string, unknown> | null)?.[key];
  if (typeof field !== "object" || field === null) throw new Error(key);
  return field;
}

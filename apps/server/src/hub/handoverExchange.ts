// The two computers' halves of a handover after the source pushed it. The
// source tells the member the person chose (a signed notice), so it shows under
// Handovers there before its next fetch. Continuing it there is a person's act:
// the destination fetches the branch with its own Git identity, opens a Code
// thread on it, gives the first turn the note framed as outside content, and
// tells the source, which then erases its frozen copy. Canonical:
// docs/design/hub-and-spokes.md "Handover".

import { randomUUID } from "node:crypto";
import {
  CodeThreadId,
  HubMemberId,
  ThreadMoveId,
  UtcTimestamp,
  decodeHandoverContinuedReport,
  decodeHandoverNotice,
  type HandoverContinueOutcome,
  type HandoverContinueRequest,
  type HandoverListing,
  type HandoverNotice,
  type MovedThreadReference,
  type ThreadMoveProjectChoice,
} from "@octant/contracts";
import { Schema } from "effect";
import type {
  ThreadMovePlacement,
  ThreadMoveSourceHost,
  MoveSender,
  SignedRequest,
  DestinationAnswer,
} from "./threadMoveService";
import { THREAD_MOVE_DEPARTURES_KEPT, type ThreadMoveStatePort } from "./threadMoveStateStore";

export const HANDOVER_ROUTES = {
  notice: "/api/hub/peer/handovers",
  continued: "/api/hub/peer/handovers/continued",
} as const;

const decodeCodeThreadId = Schema.decodeUnknownSync(CodeThreadId);
const decodeMoveId = Schema.decodeUnknownSync(ThreadMoveId);
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface HandoverExchangeOptions {
  readonly state: ThreadMoveStatePort;
  readonly authenticate: (request: SignedRequest) => MoveSender;
  readonly send: (
    targetMemberId: string,
    path: string,
    body: unknown,
  ) => Promise<
    | { readonly status: "answered"; readonly body: Record<string, unknown> }
    | { readonly status: "unreachable" }
  >;
  readonly memberName: (memberId: string) => string;
  /** This host's active Code Projects. */
  readonly codeProjects: () => ReadonlyArray<ThreadMoveProjectChoice>;
  readonly acceptsProject: (placement: ThreadMovePlacement) => boolean | Promise<boolean>;
  readonly resolveProvider: (
    driverKind: string,
    modelId: string,
  ) => { readonly providerInstanceId: string; readonly modelId: string } | undefined;
  /** Fetches the branch into the Project's clone and reads the handover note from its tip, or nothing. */
  readonly readNote: (input: {
    readonly projectId: string;
    readonly branch: string;
    readonly handoverId: string;
  }) => Promise<string | undefined>;
  /** Whether the Project's clone already has a local branch of this name. */
  readonly branchTaken: (input: {
    readonly projectId: string;
    readonly branch: string;
  }) => Promise<boolean>;
  /**
   * Opens a managed Code thread on its own branch, started from the fetched
   * handover branch, marked as having read outside content.
   */
  readonly createThread: (input: {
    readonly threadId: CodeThreadId;
    readonly projectId: string;
    readonly title: string;
    /** The fetched handover branch the thread starts from. */
    readonly branch: string;
    /** The thread's own branch: the handover's name, or a suffixed one when that name is taken. */
    readonly threadBranch: string;
    readonly provider: { readonly providerInstanceId: string; readonly modelId: string };
    readonly handoverId: string;
  }) => Promise<void>;
  readonly journalNote: (input: {
    readonly threadId: string;
    readonly handoverId: string;
    readonly note: string;
  }) => void;
  /** The source's frozen copy: erased once a destination continued it. */
  readonly source: Pick<ThreadMoveSourceHost, "erase" | "unfreeze">;
  readonly clock: () => string;
  readonly uuid?: () => string;
}

export class HandoverExchange {
  readonly #options: HandoverExchangeOptions;

  constructor(options: HandoverExchangeOptions) {
    this.#options = options;
  }

  // ── Destination ────────────────────────────────────────────────────────

  /** A member's notice of a handover it pushed. It opens nothing; the person decides. */
  async receiveNotice(request: SignedRequest): Promise<DestinationAnswer> {
    const sender = this.#options.authenticate(request);
    if (sender.status === "refused") return refused(403);
    let notice: HandoverNotice;
    try {
      notice = decodeHandoverNotice(JSON.parse(request.body));
    } catch {
      return refused(400);
    }
    const state = this.#options.state.load();
    const others = (state.receivedHandovers ?? []).filter(
      (entry) => String(entry.notice.handoverId) !== String(notice.handoverId),
    );
    this.#options.state.save({
      ...state,
      receivedHandovers: [
        ...others,
        {
          senderMemberId: decodeMemberId(sender.memberId),
          notice,
          receivedAt: decodeTimestamp(this.#options.clock()),
        },
      ].slice(-256),
    });
    return { httpStatus: 200, body: { status: "received", handoverId: notice.handoverId } };
  }

  /** The handovers this computer was told about, each with the Code Projects that fit. */
  async list(): Promise<HandoverListing> {
    const received = this.#options.state.load().receivedHandovers ?? [];
    const projects = this.#options.codeProjects();
    const handovers = await Promise.all(
      received.map(async (entry) => {
        const fitting: ThreadMoveProjectChoice[] = [];
        for (const project of projects) {
          const fits = await this.#options.acceptsProject({
            mode: "code",
            destinationProjectId: String(project.projectId),
            repositoryRemotes: [entry.notice.repositoryRemote],
          });
          if (fits) fitting.push(project);
        }
        return {
          handoverId: entry.notice.handoverId,
          title: entry.notice.title,
          branch: entry.notice.branch,
          repositoryRemote: entry.notice.repositoryRemote,
          originMemberId: entry.senderMemberId,
          originName: this.#options.memberName(String(entry.senderMemberId)),
          projects: fitting,
          receivedAt: entry.receivedAt,
        };
      }),
    );
    return { status: "listed", handovers };
  }

  /**
   * Continue handover, a person's act here: the branch is fetched with this
   * host's own Git identity, the note read from its tip, and a Code thread
   * opened on it. The source is told so it erases its copy; one that cannot
   * be reached learns it the next time it asks.
   */
  async continueHandover(request: HandoverContinueRequest): Promise<HandoverContinueOutcome> {
    const received = (this.#options.state.load().receivedHandovers ?? []).find(
      (entry) => String(entry.notice.handoverId) === String(request.handoverId),
    );
    if (received === undefined) return { status: "refused", reason: "refused" };
    const { notice } = received;
    const fits = await this.#options.acceptsProject({
      mode: "code",
      destinationProjectId: String(request.projectId),
      repositoryRemotes: [notice.repositoryRemote],
    });
    if (!fits) return { status: "refused", reason: "no-eligible-project" };
    const provider =
      notice.providerDriverKind === undefined || notice.modelId === undefined
        ? undefined
        : this.#options.resolveProvider(notice.providerDriverKind, notice.modelId);
    if (provider === undefined) return { status: "refused", reason: "no-matching-provider" };
    const note = await this.#options
      .readNote({
        projectId: String(request.projectId),
        branch: notice.branch,
        handoverId: String(notice.handoverId),
      })
      .catch(() => undefined);
    if (note === undefined) return { status: "refused", reason: "transfer-failed" };
    const threadId = decodeCodeThreadId((this.#options.uuid ?? randomUUID)());
    // A managed thread refuses a branch name its clone already has, even one
    // at the same tip, so a taken name gets a suffix, as a moved thread's does.
    const taken = await this.#options
      .branchTaken({ projectId: String(request.projectId), branch: notice.branch })
      .catch(() => false);
    const threadBranch = taken
      ? `${notice.branch}-handover-${String(threadId).slice(0, 8)}`
      : notice.branch;
    try {
      await this.#options.createThread({
        threadId,
        projectId: String(request.projectId),
        title: notice.title,
        branch: notice.branch,
        threadBranch,
        provider,
        handoverId: String(notice.handoverId),
      });
    } catch {
      return { status: "refused", reason: "transfer-failed" };
    }
    this.#options.journalNote({
      threadId: String(threadId),
      handoverId: String(notice.handoverId),
      note,
    });
    const thread: MovedThreadReference = { mode: "code", threadId: String(threadId) };
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      receivedHandovers: (state.receivedHandovers ?? []).filter(
        (entry) => String(entry.notice.handoverId) !== String(notice.handoverId),
      ),
    });
    void this.#options
      .send(String(received.senderMemberId), HANDOVER_ROUTES.continued, {
        handoverId: notice.handoverId,
        thread,
      })
      .catch(() => undefined);
    return { status: "continued", thread };
  }

  // ── Source ─────────────────────────────────────────────────────────────

  /** Tells the chosen member about a pushed handover; a member that does not answer misses nothing it cannot fetch. */
  async notify(targetMemberId: string, notice: HandoverNotice): Promise<void> {
    await this.#options.send(targetMemberId, HANDOVER_ROUTES.notice, notice).catch(() => undefined);
  }

  /**
   * A member continued a handover this host holds frozen: the thread is
   * erased the way a moved thread is, with a "Moved to" record for old links.
   */
  async receiveContinued(request: SignedRequest): Promise<DestinationAnswer> {
    const sender = this.#options.authenticate(request);
    if (sender.status === "refused") return refused(403);
    let report;
    try {
      report = decodeHandoverContinuedReport(JSON.parse(request.body));
    } catch {
      return refused(400);
    }
    const state = this.#options.state.load();
    const handover = (state.handovers ?? []).find(
      (entry) => String(entry.handoverId) === String(report.handoverId),
    );
    if (handover === undefined) return { httpStatus: 200, body: { status: "unknown" } };
    const moveId = decodeMoveId(String(handover.handoverId));
    const erased = await this.#options.source.erase({ thread: handover.thread, moveId });
    this.#options.source.unfreeze(handover.thread);
    const after = this.#options.state.load();
    this.#options.state.save({
      ...after,
      handovers: (after.handovers ?? []).filter(
        (entry) => String(entry.handoverId) !== String(report.handoverId),
      ),
      departures: [
        ...(after.departures ?? []),
        {
          moveId,
          thread: handover.thread,
          destinationMemberId: decodeMemberId(sender.memberId),
          destinationThread: report.thread,
          ...(erased.keptWorktree === undefined ? {} : { keptWorktree: erased.keptWorktree }),
          changesRemainInCheckout: erased.changesRemainInCheckout === true,
          movedAt: decodeTimestamp(this.#options.clock()),
        },
      ].slice(-THREAD_MOVE_DEPARTURES_KEPT),
    });
    return { httpStatus: 200, body: { status: "erased" } };
  }
}

function refused(httpStatus: number): DestinationAnswer {
  return { httpStatus, body: { status: "refused" } };
}

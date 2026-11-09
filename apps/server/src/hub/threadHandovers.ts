// Handing a Code thread over through its branch, for when it cannot move
// properly: the source freezes the thread, writes a note from the journal,
// commits every change Git does not ignore onto the thread's branch (or a new
// `octant/handover/…` branch), and pushes it. The thread stays frozen, marked
// handed over, until it is continued elsewhere or taken back here. Canonical:
// docs/design/hub-and-spokes.md "Handover".

import { randomUUID } from "node:crypto";
import {
  HandoverId,
  UtcTimestamp,
  type HandedOverThread,
  type HandoverAgentSummary,
  type HandoverNotice,
  type HandoverOutcome,
  type MovedThreadReference,
} from "@octant/contracts";
import { handoverBranch, redactSecrets } from "@octant/domain";
import { Schema } from "effect";
import {
  commitHandover,
  pushHandover,
  readHandoverCheckout,
  unusedHandoverBranch,
  type HandoverCheckout,
} from "./codeThreadHandoverGit";
import type { ThreadHandoverRecorder } from "./threadMoveJournal";
import type { ThreadMoveSourceHost } from "./threadMoveService";
import type { ThreadMoveStatePort } from "./threadMoveStateStore";

/** The note is at most this long, trailers included. */
export const HANDOVER_NOTE_MAX_BYTES = 32 * 1024;
const SECTION_LIMIT = 4_000;
const CHANGE_LINES = 200;
/** The agent's summary turn is cancelled past this, and the note goes without it. */
export const HANDOVER_SUMMARY_TIMEOUT_MS = 120_000;
/**
 * Absolute paths the note must not name once the checkout's own folder reads
 * as `.`: home folders, temporary and system folders, mounted volumes, and
 * Windows drives. The agent's summary is free text, so it can name any of them.
 */
const LOCAL_PATH =
  /(?<![\w.~-])(?:\/(?:Users|home|root|tmp|private|var|opt|Volumes|mnt|etc|srv)\/|[A-Za-z]:\\)[^\s'"`<>)\]]*/g;

const decodeHandoverId = Schema.decodeUnknownSync(HandoverId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/** The Code facts a handover reads, by thread. */
export interface HandoverCodeHost {
  readonly checkoutRoot: (threadId: string) => Promise<string | undefined>;
  /** The provider kind and model the thread runs on, for the destination to continue on its own. */
  readonly provider: (threadId: string) =>
    | {
        readonly driverKind: string;
        readonly modelId: string;
      }
    | undefined;
  /** The person's latest instruction and the agent's latest answer, from the journal. */
  readonly latest: (threadId: string) => Promise<{
    readonly instruction?: string;
    readonly answer?: string;
  }>;
  /**
   * One bounded, tool-free turn of the thread's own agent saying where the
   * work stands and what comes next, cancelled through `signal`. Absent on a
   * host that cannot run one.
   */
  readonly summarize?: (threadId: string, signal: AbortSignal) => Promise<HandoverSummaryAnswer>;
}

/** What the thread's own agent answered when asked to summarize for the note. */
export type HandoverSummaryAnswer =
  | { readonly status: "summarized"; readonly text: string }
  /** The provider is not ready, so no turn was started. */
  | { readonly status: "unavailable" }
  | { readonly status: "failed" };

/** The person's choices on the handover sheet. */
export interface HandoverChoices {
  /** Ask the agent to summarize; only `true` spends a provider turn. */
  readonly summarize?: boolean;
}

export interface ThreadHandoversOptions {
  readonly source: Pick<ThreadMoveSourceHost, "read" | "freeze" | "unfreeze" | "isFrozen">;
  readonly code: HandoverCodeHost;
  readonly record: ThreadHandoverRecorder;
  readonly state: ThreadMoveStatePort;
  /** Tells the member the person chose, so the handover shows under its Handovers. */
  readonly notify?: (destinationMemberId: string, notice: HandoverNotice) => Promise<void>;
  /** This computer's name, for the note and its trailer. */
  readonly originName: () => string;
  readonly clock: () => string;
  readonly uuid?: () => string;
  /** Shared with the exchange that erases a continued handover's thread. */
  readonly claims?: HandoverClaims;
  /** Defaults to {@link HANDOVER_SUMMARY_TIMEOUT_MS}. */
  readonly summaryTimeoutMs?: number;
}

/**
 * The threads a handover step is working on right now: handing one over, or
 * erasing it once a destination continued it. A step claims its thread before
 * it awaits anything and releases it when it ends, and Take back here refuses
 * a claimed thread, so no step can release or erase a thread another step is
 * still holding. One set is shared by everything that acts on handovers.
 */
export class HandoverClaims {
  readonly #claimed = new Set<string>();

  /** Claims the thread; false when another step already holds it. */
  claim(thread: MovedThreadReference): boolean {
    const claim = claimOf(thread);
    if (this.#claimed.has(claim)) return false;
    this.#claimed.add(claim);
    return true;
  }

  release(thread: MovedThreadReference): void {
    this.#claimed.delete(claimOf(thread));
  }

  has(thread: MovedThreadReference): boolean {
    return this.#claimed.has(claimOf(thread));
  }
}

export class ThreadHandovers {
  readonly #options: ThreadHandoversOptions;
  readonly #claims: HandoverClaims;

  constructor(options: ThreadHandoversOptions) {
    this.#options = options;
    this.#claims = options.claims ?? new HandoverClaims();
  }

  /** What a handover of this thread would do, with nothing frozen or written. */
  async preview(thread: MovedThreadReference): Promise<HandoverOutcome> {
    const planned = await this.#plan(thread);
    if (planned.status === "refused") return planned;
    return {
      status: "preview",
      branch: planned.branch,
      newBranch: planned.branch !== planned.checkout.branch,
      ...(planned.remote === undefined ? {} : { remote: planned.remote }),
      note: planned.note("preview"),
    };
  }

  /**
   * Freezes the thread, then commits and pushes. A thread whose work cannot
   * be committed unfreezes with the reason; a push that fails leaves the
   * commit and the freeze, and the outcome says the work is on no other
   * computer yet.
   */
  async handOver(
    thread: MovedThreadReference,
    destinationMemberId?: string,
    choices: HandoverChoices = {},
  ): Promise<HandoverOutcome> {
    // A thread another step claimed, or one a move or handover already
    // holds, is busy: this attempt never freezes or unfreezes it.
    if (this.#options.source.isFrozen(thread) || !this.#claims.claim(thread)) {
      return { status: "refused", reason: "busy" };
    }
    try {
      return await this.#handOverClaimed(thread, destinationMemberId, choices);
    } finally {
      this.#claims.release(thread);
    }
  }

  async #handOverClaimed(
    thread: MovedThreadReference,
    destinationMemberId: string | undefined,
    choices: HandoverChoices,
  ): Promise<HandoverOutcome> {
    // The freeze comes before planning reads whether a turn runs: turn
    // admission checks the freeze, so no turn can start while the checkout
    // is inspected and the note written, and one that started before it is
    // seen as busy by the read that follows.
    this.#options.source.freeze(thread);
    const planned = await this.#plan(thread);
    if (planned.status === "refused") {
      this.#options.source.unfreeze(thread);
      return planned;
    }
    // The summary turn runs on the frozen thread, after the plan refused a busy
    // one and before anything is journaled or saved: a host that stops while
    // the agent writes restarts with nothing handed over and the thread free.
    const summary: { readonly outcome?: HandoverAgentSummary; readonly text?: string } =
      choices.summarize === true ? await this.#summarize(thread) : {};
    const handoverId = decodeHandoverId((this.#options.uuid ?? randomUUID)());
    // The freeze is journaled before anything is written, and the hold is
    // saved before the commit and the push: a stop between them restarts with
    // the thread still held as handed over and not pushed, so it neither
    // becomes writable while its work may be on the remote nor loses the
    // record a continued report looks for. Take back here undoes it.
    this.#options.record.handoverStarted({
      handoverId,
      thread,
      branch: planned.branch,
      ...(summary.outcome === undefined ? {} : { agentSummary: summary.outcome }),
    });
    const handedOverAt = decodeTimestamp(this.#options.clock());
    this.#saveHandover({
      handoverId,
      thread,
      branch: planned.branch,
      pushed: false,
      shortfall: "push-failed",
      refusedFiles: [],
      handedOverAt,
    });
    // A branch that already holds the work and has nothing left to commit
    // still gets a commit carrying the note: the destination reads the note
    // only from a tip whose trailer names this handover.
    const committed = await commitHandover({
      checkoutRoot: planned.root,
      branch: planned.branch,
      message: planned.note(String(handoverId), summary.text),
      noteWhenUnchanged: planned.branch === planned.checkout.branch,
    });
    if (committed.status === "refused") {
      this.#dropHandover(String(handoverId));
      this.#options.source.unfreeze(thread);
      return {
        status: "refused",
        reason: committed.reason === "nothing-to-commit" ? "nothing-to-hand-over" : "commit-failed",
      };
    }
    const pushed = await pushHandover({
      checkoutRoot: planned.root,
      branch: planned.branch,
      defaultBranch: planned.checkout.defaultBranch,
      remote: planned.remote,
    });
    if (pushed.status === "pushed" && destinationMemberId !== undefined) {
      const provider = this.#options.code.provider(thread.threadId);
      const remoteUrl = planned.remoteUrl;
      if (remoteUrl !== undefined) {
        void this.#options.notify?.(destinationMemberId, {
          handoverId,
          title: planned.title,
          repositoryRemote: remoteUrl,
          branch: planned.branch,
          ...(provider === undefined
            ? {}
            : { providerDriverKind: provider.driverKind, modelId: provider.modelId }),
        });
      }
    }
    const record: HandedOverThread = {
      handoverId,
      thread,
      branch: planned.branch,
      pushed: pushed.status === "pushed",
      ...(pushed.status === "pushed" ? {} : { shortfall: pushed.shortfall }),
      refusedFiles: committed.status === "committed" ? committed.refusedFiles : [],
      handedOverAt,
    };
    this.#saveHandover(record);
    return {
      status: "handed-over",
      handoverId,
      branch: record.branch,
      pushed: record.pushed,
      ...(record.shortfall === undefined ? {} : { shortfall: record.shortfall }),
      refusedFiles: record.refusedFiles,
    };
  }

  /**
   * Take back here: the thread unfreezes; the branch and its commit stay where
   * they are. Refused while a step holds the thread: a handover still
   * committing or pushing would save itself as handed over again, and an
   * erase for a continued handover would purge a thread already writable.
   */
  takeBack(
    handoverId: string,
  ): { readonly status: "taken-back" } | { readonly status: "refused"; readonly reason: "busy" } {
    const state = this.#options.state.load();
    const handover = (state.handovers ?? []).find(
      (entry) => String(entry.handoverId) === handoverId,
    );
    if (handover !== undefined && this.#claims.has(handover.thread)) {
      return { status: "refused", reason: "busy" };
    }
    if (handover !== undefined) {
      this.#options.source.unfreeze(handover.thread);
      this.#options.state.save({
        ...state,
        handovers: (state.handovers ?? []).filter(
          (entry) => String(entry.handoverId) !== handoverId,
        ),
      });
    }
    return { status: "taken-back" };
  }

  /**
   * One turn of the thread's own agent, bounded: past the bound it is
   * cancelled and the note goes without it, as it does when the turn fails.
   * A provider that ignores the cancel cannot hold the handover, because the
   * bound settles the wait whether or not the turn ever answers.
   */
  async #summarize(thread: MovedThreadReference): Promise<{
    readonly outcome: HandoverAgentSummary;
    readonly text?: string;
  }> {
    const summarize = this.#options.code.summarize;
    if (summarize === undefined) return { outcome: "unavailable" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timed-out");
      }, this.#options.summaryTimeoutMs ?? HANDOVER_SUMMARY_TIMEOUT_MS);
    });
    try {
      const answer = await Promise.race([
        summarize(thread.threadId, controller.signal).catch(
          (): HandoverSummaryAnswer => ({ status: "failed" }),
        ),
        bound,
      ]);
      if (answer === "timed-out") return { outcome: "timed-out" };
      if (answer.status !== "summarized") return { outcome: answer.status };
      const text = answer.text.trim();
      return text.length === 0 ? { outcome: "failed" } : { outcome: "added", text };
    } finally {
      clearTimeout(timer);
    }
  }

  #saveHandover(record: HandedOverThread): void {
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      handovers: [
        ...(state.handovers ?? []).filter((entry) => !same(entry.thread, record.thread)),
        record,
      ],
    });
  }

  #dropHandover(handoverId: string): void {
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      handovers: (state.handovers ?? []).filter((entry) => String(entry.handoverId) !== handoverId),
    });
  }

  async #plan(thread: MovedThreadReference): Promise<
    | {
        readonly status: "planned";
        readonly root: string;
        readonly checkout: HandoverCheckout;
        readonly branch: string;
        readonly remote: string | undefined;
        readonly remoteUrl: string | undefined;
        readonly title: string;
        readonly note: (handoverId: string, agentSummary?: string) => string;
      }
    | { readonly status: "refused"; readonly reason: "busy" | "delegated" | "refused" }
  > {
    if (thread.mode !== "code") return { status: "refused", reason: "refused" };
    const reading = await this.#options.source.read(thread);
    if (reading.status === "missing") return { status: "refused", reason: "refused" };
    if (reading.delegated) return { status: "refused", reason: "delegated" };
    if (reading.busy) return { status: "refused", reason: "busy" };
    const root = await this.#options.code.checkoutRoot(thread.threadId);
    if (root === undefined) return { status: "refused", reason: "refused" };
    let checkout: HandoverCheckout;
    try {
      checkout = await readHandoverCheckout(root);
    } catch {
      return { status: "refused", reason: "refused" };
    }
    const named = handoverBranch({
      currentBranch: checkout.branch,
      defaultBranch: checkout.defaultBranch,
      threadTitle: reading.title,
      threadId: thread.threadId,
    });
    const branch = named === checkout.branch ? named : await unusedHandoverBranch(root, named);
    const latest = await this.#options.code.latest(thread.threadId).catch(() => ({}));
    const remote = checkout.remote;
    const originName = this.#options.originName();
    return {
      status: "planned",
      root,
      checkout,
      branch,
      remote,
      remoteUrl: checkout.remoteUrl,
      title: reading.title,
      note: (handoverId, agentSummary) =>
        composeHandoverNote({
          title: reading.title,
          originName,
          branch,
          checkout,
          checkoutRoot: root,
          ...latest,
          ...(agentSummary === undefined ? {} : { agentSummary }),
          handoverId,
        }),
    };
  }
}

/**
 * The note a handover commits as its message and the destination's first turn
 * reads: the agent's own summary when it gave one, where the work stands, the
 * latest instruction, what changed, and what stayed behind, with the handover
 * trailers. Secrets are redacted, no folder on this computer appears, and it
 * is at most 32 KiB.
 */
export function composeHandoverNote(input: {
  readonly title: string;
  readonly originName: string;
  readonly branch: string;
  readonly checkout: HandoverCheckout;
  readonly checkoutRoot: string;
  readonly instruction?: string;
  readonly answer?: string;
  /** The agent's own summary turn, filed under its own heading. */
  readonly agentSummary?: string;
  readonly handoverId: string;
}): string {
  const clip = (text: string, limit: number) =>
    text.length <= limit ? text : `${text.slice(0, limit)}…`;
  const changes = input.checkout.changes.slice(0, CHANGE_LINES).map((line) => `- ${line}`);
  const more = input.checkout.changes.length - changes.length;
  const sections = [
    `Hand over: ${input.title}`,
    `Handed over from ${input.originName} through the branch ${input.branch}, because the thread could not move there directly.`,
    ...(input.agentSummary === undefined
      ? []
      : [`## The agent's summary\n\n${clip(input.agentSummary, SECTION_LIMIT)}`]),
    ...(input.answer === undefined
      ? []
      : [`## Where it stands\n\n${clip(input.answer, SECTION_LIMIT)}`]),
    ...(input.instruction === undefined
      ? []
      : [`## The latest instruction\n\n${clip(input.instruction, SECTION_LIMIT)}`]),
    `## What changed\n\n${changes.length === 0 ? "Nothing uncommitted; the branch holds the work." : changes.join("\n")}${more > 0 ? `\n- and ${String(more)} more` : ""}`,
    `## Stayed on ${input.originName}\n\n- Ignored files: ${String(input.checkout.ignoredFiles)} (build output, installed dependencies, .env files)\n- Any changed file holding a secret, left out of this commit\n- Running terminals, previews, and Browser pages`,
  ];
  const trailers = `Octant-Handover: ${input.handoverId}\nOctant-Origin: ${input.originName.replace(/\s+/g, " ")}`;
  let body = redactSecrets(sections.join("\n\n")).text;
  // No absolute path: the checkout's folder reads as the repository itself.
  body = body.split(input.checkoutRoot).join(".");
  body = body.replace(LOCAL_PATH, `[a folder on ${input.originName}]`);
  const room = HANDOVER_NOTE_MAX_BYTES - Buffer.byteLength(`\n\n${trailers}\n`, "utf8");
  while (Buffer.byteLength(body, "utf8") > room)
    body = body.slice(0, Math.floor(body.length * 0.9));
  return `${body}\n\n${trailers}\n`;
}

function claimOf(thread: MovedThreadReference): string {
  return `${thread.mode}:${thread.threadId}`;
}

function same(left: MovedThreadReference, right: MovedThreadReference): boolean {
  return left.mode === right.mode && left.threadId === right.threadId;
}

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
  type HandoverCheckout,
} from "./codeThreadHandoverGit";
import type { ThreadHandoverRecorder } from "./threadMoveJournal";
import type { ThreadMoveSourceHost } from "./threadMoveService";
import type { ThreadMoveStatePort } from "./threadMoveStateStore";

/** The note is at most this long, trailers included. */
export const HANDOVER_NOTE_MAX_BYTES = 32 * 1024;
const SECTION_LIMIT = 4_000;
const CHANGE_LINES = 200;

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
}

export interface ThreadHandoversOptions {
  readonly source: Pick<ThreadMoveSourceHost, "read" | "freeze" | "unfreeze">;
  readonly code: HandoverCodeHost;
  readonly record: ThreadHandoverRecorder;
  readonly state: ThreadMoveStatePort;
  /** Tells the member the person chose, so the handover shows under its Handovers. */
  readonly notify?: (destinationMemberId: string, notice: HandoverNotice) => Promise<void>;
  /** This computer's name, for the note and its trailer. */
  readonly originName: () => string;
  readonly clock: () => string;
  readonly uuid?: () => string;
}

export class ThreadHandovers {
  readonly #options: ThreadHandoversOptions;

  constructor(options: ThreadHandoversOptions) {
    this.#options = options;
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
  ): Promise<HandoverOutcome> {
    const planned = await this.#plan(thread);
    if (planned.status === "refused") return planned;
    const handoverId = decodeHandoverId((this.#options.uuid ?? randomUUID)());
    // The freeze is recorded before anything is written.
    this.#options.record.handoverStarted({ handoverId, thread, branch: planned.branch });
    this.#options.source.freeze(thread);
    const committed = await commitHandover({
      checkoutRoot: planned.root,
      branch: planned.branch,
      message: planned.note(String(handoverId)),
    });
    // Nothing left to commit on a branch that already holds the work is still
    // a handover: the branch is pushed as it is.
    if (
      committed.status === "refused" &&
      !(committed.reason === "nothing-to-commit" && planned.branch === planned.checkout.branch)
    ) {
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
      handedOverAt: decodeTimestamp(this.#options.clock()),
    };
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      handovers: [
        ...(state.handovers ?? []).filter((entry) => !same(entry.thread, thread)),
        record,
      ],
    });
    return {
      status: "handed-over",
      handoverId,
      branch: record.branch,
      pushed: record.pushed,
      ...(record.shortfall === undefined ? {} : { shortfall: record.shortfall }),
      refusedFiles: record.refusedFiles,
    };
  }

  /** Take back here: the thread unfreezes; the branch and its commit stay where they are. */
  takeBack(handoverId: string): { readonly status: "taken-back" } {
    const state = this.#options.state.load();
    const handover = (state.handovers ?? []).find(
      (entry) => String(entry.handoverId) === handoverId,
    );
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

  async #plan(thread: MovedThreadReference): Promise<
    | {
        readonly status: "planned";
        readonly root: string;
        readonly checkout: HandoverCheckout;
        readonly branch: string;
        readonly remote: string | undefined;
        readonly remoteUrl: string | undefined;
        readonly title: string;
        readonly note: (handoverId: string) => string;
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
    const branch = handoverBranch({
      currentBranch: checkout.branch,
      defaultBranch: checkout.defaultBranch,
      threadTitle: reading.title,
      threadId: thread.threadId,
    });
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
      note: (handoverId) =>
        composeHandoverNote({
          title: reading.title,
          originName,
          branch,
          checkout,
          checkoutRoot: root,
          ...latest,
          handoverId,
        }),
    };
  }
}

/**
 * The note a handover commits as its message and the destination's first turn
 * reads: where the work stands, the latest instruction, what changed, and what
 * stayed behind, with the handover trailers. Secrets are redacted, the
 * checkout's folder never appears, and it is at most 32 KiB.
 */
export function composeHandoverNote(input: {
  readonly title: string;
  readonly originName: string;
  readonly branch: string;
  readonly checkout: HandoverCheckout;
  readonly checkoutRoot: string;
  readonly instruction?: string;
  readonly answer?: string;
  readonly handoverId: string;
}): string {
  const clip = (text: string, limit: number) =>
    text.length <= limit ? text : `${text.slice(0, limit)}…`;
  const changes = input.checkout.changes.slice(0, CHANGE_LINES).map((line) => `- ${line}`);
  const more = input.checkout.changes.length - changes.length;
  const sections = [
    `Hand over: ${input.title}`,
    `Handed over from ${input.originName} through the branch ${input.branch}, because the thread could not move there directly.`,
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
  const room = HANDOVER_NOTE_MAX_BYTES - Buffer.byteLength(`\n\n${trailers}\n`, "utf8");
  while (Buffer.byteLength(body, "utf8") > room)
    body = body.slice(0, Math.floor(body.length * 0.9));
  return `${body}\n\n${trailers}\n`;
}

function same(left: MovedThreadReference, right: MovedThreadReference): boolean {
  return left.mode === right.mode && left.threadId === right.threadId;
}

import {
  decodeCodeOperationId,
  type CodeEvidenceReference,
  type CodeOperationEventFrame,
  type CodeOperationId,
  type CodeThread,
  type CodeThreadId,
  type PendingRequest,
  type TurnDecisionAskedBy,
  type WindowId,
} from "@octant/contracts";
import { parseTurnDecision, turnDecisionIsOpen, type TurnDecision } from "@octant/domain";
import { MAX_CODE_OPERATION_REPLAY_LIMIT } from "../code/codeOperationEventStore";
import type { ProjectedCodeRuntimeWork } from "../persistence/codeProjection";

export interface CodeTurnDecisionSources {
  /**
   * The Code threads this window's thread list holds, which is the reach the
   * Code send command checks before it starts a turn.
   */
  readonly threads: (windowId: WindowId) => Promise<ReadonlyArray<CodeThread>>;
  /**
   * Whether the window's Code send command would start a turn on this thread
   * now. The thread list is read with browse reach, which is wider, so a
   * decision is offered only where its answer could land.
   */
  readonly admitsTurn: (windowId: WindowId, thread: CodeThread) => Promise<boolean>;
  readonly runtimeWorks: (threadId: CodeThreadId) => ReadonlyArray<ProjectedCodeRuntimeWork>;
  /**
   * One page of an operation's journaled frames after `afterCursor`, at most
   * {@link MAX_CODE_OPERATION_REPLAY_LIMIT} long; undefined when it cannot be
   * replayed whole.
   */
  readonly replay: (input: {
    readonly threadId: CodeThreadId;
    readonly operationId: CodeOperationId;
    readonly afterCursor: number;
  }) => ReadonlyArray<CodeOperationEventFrame> | undefined;
  readonly readEvidence: (reference: CodeEvidenceReference) => string | undefined;
}

/** A finished turn's reply never changes, so its parse is kept; the bound keeps a long-lived host small. */
const MAX_REMEMBERED_TURNS = 512;

/**
 * The decision a Code thread's latest finished turn closed with, read from
 * the journal so a restart lists exactly what it listed before. The reply is
 * the turn's message content in journal order, the same normalized text its
 * transcript shows; nothing a provider adapter emits outside that content can
 * raise a decision. Only the latest provider turn speaks: a newer turn that
 * started, or one that was interrupted or failed (a turn that died with the
 * process is settled interrupted), closes the decision.
 */
export class CodeTurnDecisions {
  readonly #sources: CodeTurnDecisionSources;
  readonly #parsed = new Map<
    string,
    { readonly decision: TurnDecision; readonly askedBy: TurnDecisionAskedBy | undefined } | null
  >();

  constructor(sources: CodeTurnDecisionSources) {
    this.#sources = sources;
  }

  /** The window's open decisions, one per thread at most. The caller orders and bounds them. */
  async listForWindow(windowId: WindowId): Promise<ReadonlyArray<PendingRequest>> {
    const pending: PendingRequest[] = [];
    for (const thread of await this.#sources.threads(windowId)) {
      const open = this.forThread(thread);
      if (open === undefined || !(await this.#sources.admitsTurn(windowId, thread))) continue;
      pending.push({
        mode: "code",
        kind: "decision",
        projectId: thread.projectId,
        threadId: thread.id,
        threadTitle: thread.title,
        requestedAt: open.endedAt,
        text: open.decision.ask,
        ...(open.decision.why === undefined ? {} : { why: open.decision.why }),
        ...(open.decision.urgent === true ? { urgent: true } : {}),
        options: open.decision.options,
        ...(open.askedBy === undefined ? {} : { askedBy: open.askedBy }),
        answer: {
          threadId: thread.id,
          checkoutId: thread.checkoutId,
          operationId: open.operationId,
        },
      });
    }
    return pending;
  }

  /** The thread's open decision and the turn that asked it, if one is open. */
  forThread(thread: CodeThread):
    | {
        readonly decision: TurnDecision;
        readonly operationId: CodeOperationId;
        readonly endedAt: PendingRequest["requestedAt"];
        /** The model the turn ran on; absent when the turn's journal does not say. */
        readonly askedBy: TurnDecisionAskedBy | undefined;
      }
    | undefined {
    const latest = latestProviderTurn(this.#sources.runtimeWorks(thread.id));
    if (
      latest === undefined ||
      !turnDecisionIsOpen({
        latestTurnCompleted: latest.work.state === "completed",
        archived: thread.lifecycle === "archived",
        completed: thread.completedAt !== undefined,
        snoozed: thread.snooze !== undefined,
      })
    ) {
      return undefined;
    }
    let operationId: CodeOperationId;
    try {
      operationId = decodeCodeOperationId(String(latest.work.id));
    } catch {
      return undefined;
    }
    const read = this.#decisionOf(thread.id, operationId);
    return read === undefined
      ? undefined
      : {
          decision: read.decision,
          operationId,
          endedAt: latest.work.updatedAt,
          askedBy: read.askedBy,
        };
  }

  /** The turn's reply as its transcript shows it, or undefined when it cannot be replayed whole. */
  replyOf(threadId: CodeThreadId, operationId: CodeOperationId): string | undefined {
    return this.#read(threadId, operationId)?.reply;
  }

  #decisionOf(
    threadId: CodeThreadId,
    operationId: CodeOperationId,
  ):
    | { readonly decision: TurnDecision; readonly askedBy: TurnDecisionAskedBy | undefined }
    | undefined {
    const key = `${String(threadId)}:${String(operationId)}`;
    const remembered = this.#parsed.get(key);
    if (remembered !== undefined) return remembered ?? undefined;
    const read = this.#read(threadId, operationId);
    // An unreadable reply is not remembered: the next read tries again.
    if (read === undefined) return undefined;
    const parsed = parseTurnDecision(read.reply);
    const decision = parsed === undefined ? null : { decision: parsed, askedBy: read.askedBy };
    if (this.#parsed.size >= MAX_REMEMBERED_TURNS) {
      const oldest = this.#parsed.keys().next().value;
      if (oldest !== undefined) this.#parsed.delete(oldest);
    }
    this.#parsed.set(key, decision);
    return decision ?? undefined;
  }

  #read(
    threadId: CodeThreadId,
    operationId: CodeOperationId,
  ): { readonly reply: string; readonly askedBy: TurnDecisionAskedBy | undefined } | undefined {
    const parts: string[] = [];
    let askedBy: TurnDecisionAskedBy | undefined;
    let afterCursor = 0;
    for (;;) {
      const frames = this.#sources.replay({ threadId, operationId, afterCursor });
      if (frames === undefined) return undefined;
      for (const frame of frames) {
        // The turn's own start record names what it ran on; the thread's
        // current model may have changed since.
        if (frame.event.kind === "conversation-turn-started") {
          askedBy = {
            providerInstanceId: frame.event.providerInstanceId,
            modelId: frame.event.modelId,
          };
        }
        if (frame.event.kind !== "provider-content" || frame.event.channel !== "message") continue;
        const text = this.#sources.readEvidence(frame.event.content);
        if (text === undefined) return undefined;
        parts.push(text);
      }
      const last = frames.at(-1);
      if (last === undefined || frames.length < MAX_CODE_OPERATION_REPLAY_LIMIT) break;
      afterCursor = last.cursor;
    }
    return { reply: parts.join(""), askedBy };
  }
}

/**
 * The provider turn that started last, by the chronology the projection
 * assigns each record; `updatedAt` cannot order turns that a restart rewrote.
 */
function latestProviderTurn(
  works: ReadonlyArray<ProjectedCodeRuntimeWork>,
): ProjectedCodeRuntimeWork | undefined {
  let latest: ProjectedCodeRuntimeWork | undefined;
  for (const entry of works) {
    if (entry.work.kind !== "provider-turn") continue;
    if (latest === undefined || entry.firstSequence > latest.firstSequence) latest = entry;
  }
  return latest;
}

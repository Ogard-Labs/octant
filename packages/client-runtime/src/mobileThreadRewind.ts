import {
  decodeCodeThreadId,
  decodeHostAnswer,
  decodeWorkThreadId,
  decodeWorkTurnRequestId,
  ChatCommandResult,
  CodeCommandResult,
  WorkThreadCommandResult,
  WorkThreadRewindResult,
  type ChatContentBody,
  type ChatThreadView,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodeRewindFilesUnavailableReason,
  type CodeThread,
  type WorkThread,
  type WorkTurnState,
} from "@octant/contracts";
import { activeChatTurns, decidesCodeEffectsByApproval } from "@octant/domain";
import { executeMobileCodeOperation } from "./mobileCodeOperationsClient";
import {
  MobileInboxFailure,
  type MobileInboxRow,
  type MobileRemoteTransport,
} from "./mobileInboxClient";

/**
 * Fork from here and Rewind to here on the phone. The host decides every
 * effect: which turns a fork carries, what a rewind removes, and whether files
 * may come back. This module only names the point the person pressed and sends
 * the same host commands the desktop and web clients send.
 */

/** The composer after a rewind: the removed message first, any draft below it. */
export function composerAfterRewind(returned: string, draft: string): string {
  return draft.trim().length === 0 ? returned : `${returned}\n\n${draft}`;
}

/** A fork's title: the source's title with one suffix, never stacked. */
export function mobileForkTitle(sourceTitle: string, suffix: "fork" | "branch"): string {
  const base = sourceTitle.replace(/ \((?:fork|branch)(?: \d+)?\)$/, "").trim();
  return `${base.length === 0 ? "Task" : base} (${suffix})`;
}

/** Why a rewind's files cannot come back, in the words the person reads. */
export const MOBILE_REWIND_FILES_UNAVAILABLE: Readonly<
  Record<CodeRewindFilesUnavailableReason, string>
> = {
  "server-project":
    "This thread runs on a server Project, which keeps no file checkpoints. Only the conversation can go back.",
  plan: "A Plan thread writes no files, so there is nothing to put back.",
  unrecorded:
    "A turn after this point changed files without a recorded checkpoint, so the files cannot be put back. Rewind the conversation only.",
  unreadable: "The files could not be compared with this point.",
};

/** Said when a phone cannot put files back; the conversation can still go back. */
export const MOBILE_REWIND_FILES_NEED_COMPUTER =
  "Putting files back needs your approval on the computer, which a phone cannot give. Rewind the conversation here, or restore the files at the computer.";
export const MOBILE_REWIND_NO_FILES_IN_THIS_MODE =
  "This thread keeps no file checkpoints, so only the conversation goes back.";

/**
 * Whether the phone offers the files part of a Code rewind. The host asks an
 * approval for a restore under Ask first and Auto-accept edits, and takes
 * approvals only at a window on the computer, so a phone's restore there would
 * only wait. Under Full access the host asks nothing and allows it; the host
 * still decides, and its refusal is shown as it is.
 */
export function mobileCodeRewindFilesOffer(
  policy: CodeThread["executionPolicy"],
): { readonly kind: "offered" } | { readonly kind: "conversation-only"; readonly reason: string } {
  if (policy === "plan") {
    return { kind: "conversation-only", reason: MOBILE_REWIND_FILES_UNAVAILABLE.plan };
  }
  if (decidesCodeEffectsByApproval(policy)) {
    return { kind: "conversation-only", reason: MOBILE_REWIND_FILES_NEED_COMPUTER };
  }
  return { kind: "offered" };
}

export type MobileRewindScope = "conversation" | "files" | "both";

/** What putting the files back would change, as the host previewed it. */
export type MobileRewindFiles =
  | { readonly kind: "changes"; readonly paths: ReadonlyArray<string>; readonly total: number }
  | { readonly kind: "unchanged" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The scopes the dialog offers: files only where they can really come back. */
export function mobileRewindScopes(files: MobileRewindFiles): ReadonlyArray<MobileRewindScope> {
  return files.kind === "changes" ? ["both", "conversation", "files"] : ["conversation"];
}

/** What a message offers: the turn a fork runs through and the turn a rewind starts at. */
export interface MobileTurnTargets {
  /** Undefined where nothing comes before the message. */
  readonly forkThroughId?: string;
  readonly rewindFromId?: string;
  /** The person's message that returns to the composer on a rewind. */
  readonly rewindPrompt?: string;
  /** Turns the rewind removes, the first one included. */
  readonly removedTurns: number;
}

export interface MobileChatMessage {
  readonly content: ChatContentBody;
  readonly targets?: MobileTurnTargets;
}

/**
 * The messages the thread still holds, in order, each with the targets it
 * offers. A turn a rewind removed or an edit replaced is left out, as it is on
 * the desktop; Chat's `contents` also carry the text of those turns.
 */
export function mobileChatMessages(view: ChatThreadView): ReadonlyArray<MobileChatMessage> {
  const active = activeChatTurns(view.turns);
  const activeIds = new Set(active.map((turn) => String(turn.id)));
  const turnRefs = (turn: ChatThreadView["turns"][number]): ReadonlyArray<string> => [
    String(turn.userMessageRef.contentId),
    ...turn.attempts.flatMap((attempt) => [
      ...attempt.responseRefs.map((ref) => String(ref.contentId)),
      ...(attempt.researchRef === undefined ? [] : [String(attempt.researchRef.contentId)]),
    ]),
  ];
  const hidden = new Set(
    view.turns.filter((turn) => !activeIds.has(String(turn.id))).flatMap((turn) => turnRefs(turn)),
  );
  const byId = new Map(view.contents.map((content) => [String(content.contentId), content]));
  const targetsFor = new Map<string, MobileTurnTargets>();
  active.forEach((turn, index) => {
    const previous = active[index - 1];
    const next = active[index + 1];
    const userId = String(turn.userMessageRef.contentId);
    targetsFor.set(userId, {
      ...(previous === undefined ? {} : { forkThroughId: String(previous.id) }),
      rewindFromId: String(turn.id),
      ...(turn.delivery === undefined && byId.has(userId)
        ? { rewindPrompt: byId.get(userId)?.body ?? "" }
        : {}),
      removedTurns: active.length - index,
    });
    // A reply carries the turn's actions on its last part, once it has finished.
    const answered = turn.attempts.filter((attempt) => attempt.outcome === "completed").at(-1);
    const lastReply = answered?.responseRefs.at(-1);
    if (answered !== undefined && lastReply !== undefined) {
      const nextUser =
        next === undefined ? undefined : byId.get(String(next.userMessageRef.contentId));
      targetsFor.set(String(lastReply.contentId), {
        forkThroughId: String(turn.id),
        ...(next === undefined ? {} : { rewindFromId: String(next.id) }),
        ...(next === undefined || next.delivery !== undefined || nextUser === undefined
          ? {}
          : { rewindPrompt: nextUser.body }),
        removedTurns: active.length - index - 1,
      });
    }
  });
  return view.contents
    .filter((content) => !hidden.has(String(content.contentId)))
    .map((content) => {
      const targets = targetsFor.get(String(content.contentId));
      return targets === undefined ? { content } : { content, targets };
    });
}

async function postJson<T>(input: {
  readonly transport: MobileRemoteTransport;
  readonly path: string;
  readonly body: unknown;
  readonly decode: (value: unknown) => T;
  readonly failure: string;
}): Promise<T> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: input.path,
    body: JSON.stringify(input.body),
    contentType: "application/json",
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : response.status === 409 ? "stale" : "unavailable",
      response.status === 409 ? "The thread changed on the host. Nothing changed." : input.failure,
    );
  }
  try {
    return input.decode(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      `${input.failure} The host returned an invalid response.`,
    );
  }
}

function inboxRow(
  hostId: string,
  mode: MobileInboxRow["mode"],
  thread: { readonly id: string; readonly title: string },
  freshness: string,
): MobileInboxRow {
  return { hostId, mode, threadId: thread.id, title: thread.title, status: "active", freshness };
}

/** Chat's Fork from here is the Chat branch; the host copies the text and picks provider and model. */
export async function forkMobileChatThread(input: {
  readonly transport: MobileRemoteTransport;
  readonly thread: ChatThreadView["thread"];
  readonly throughTurnId: string;
}): Promise<MobileInboxRow> {
  const result = await postJson({
    transport: input.transport,
    path: "/api/chat/commands",
    body: {
      kind: "branch-chat-thread",
      threadId: input.thread.id,
      expectedVersion: input.thread.version,
      turnId: input.throughTurnId,
      title: mobileForkTitle(input.thread.title, "branch"),
    },
    decode: decodeHostAnswer(ChatCommandResult),
    failure: "The thread could not be forked. This thread is unchanged.",
  });
  if (result.kind !== "thread-created") {
    throw new MobileInboxFailure(
      "unavailable",
      "The thread could not be forked. This thread is unchanged.",
    );
  }
  return inboxRow(input.transport.hostId, "chat", result.thread, result.thread.updatedAt);
}

/** Rewinds a Chat thread in place. The caller already holds the removed message. */
export async function rewindMobileChatThread(input: {
  readonly transport: MobileRemoteTransport;
  readonly thread: ChatThreadView["thread"];
  readonly fromTurnId: string;
}): Promise<void> {
  const result = await postJson({
    transport: input.transport,
    path: "/api/chat/commands",
    body: {
      kind: "rewind-chat-thread",
      threadId: input.thread.id,
      expectedVersion: input.thread.version,
      turnId: input.fromTurnId,
    },
    decode: decodeHostAnswer(ChatCommandResult),
    failure: "The rewind did not go through. Nothing changed.",
  });
  if (result.kind !== "thread-rewound") {
    throw new MobileInboxFailure("unavailable", "The rewind did not go through. Nothing changed.");
  }
}

/** Work's Fork from here: a new Work thread carrying the turns through one request. */
export async function forkMobileWorkThread(input: {
  readonly transport: MobileRemoteTransport;
  readonly thread: WorkThread;
  readonly throughRequestId: string;
}): Promise<MobileInboxRow> {
  const result = await postJson({
    transport: input.transport,
    path: "/api/work/threads/commands",
    body: {
      kind: "fork-work-thread",
      threadId: decodeWorkThreadId(globalThis.crypto.randomUUID()),
      sourceThreadId: input.thread.id,
      throughRequestId: input.throughRequestId,
      title: mobileForkTitle(input.thread.title, "fork"),
    },
    decode: decodeHostAnswer(WorkThreadCommandResult),
    failure: "The thread could not be forked. This thread is unchanged.",
  });
  if (!("kind" in result) || result.kind !== "thread-created") {
    throw new MobileInboxFailure(
      "unavailable",
      "message" in result
        ? `${result.message} This thread is unchanged.`
        : "The thread could not be forked. This thread is unchanged.",
    );
  }
  return inboxRow(input.transport.hostId, "work", result.thread, result.thread.updatedAt);
}

/** Rewinds a Work thread's conversation; the host returns the removed prompt. */
export async function rewindMobileWorkThread(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly fromRequestId: string;
}): Promise<WorkThreadRewindResult> {
  return postJson({
    transport: input.transport,
    path: "/api/work/turns/rewind",
    body: {
      kind: "rewind-work-thread",
      rewindId: decodeWorkTurnRequestId(globalThis.crypto.randomUUID()),
      threadId: input.threadId,
      fromRequestId: input.fromRequestId,
    },
    decode: decodeHostAnswer(WorkThreadRewindResult),
    failure: "The rewind did not go through. Nothing changed.",
  });
}

/** What Work's messages offer; a turn that settled has both a prompt and, once answered, a reply. */
export function mobileWorkTurnTargets(
  turns: ReadonlyArray<WorkTurnState>,
  index: number,
  role: "user" | "assistant",
): MobileTurnTargets {
  const turn = turns[index];
  const previous = turns[index - 1];
  const next = turns[index + 1];
  if (turn === undefined) return { removedTurns: 0 };
  if (role === "user") {
    return {
      ...(previous === undefined ? {} : { forkThroughId: String(previous.requestId) }),
      rewindFromId: String(turn.requestId),
      rewindPrompt: turn.prompt,
      removedTurns: turns.length - index,
    };
  }
  return {
    forkThroughId: String(turn.requestId),
    ...(next === undefined
      ? {}
      : { rewindFromId: String(next.requestId), rewindPrompt: next.prompt }),
    removedTurns: turns.length - index - 1,
  };
}

/**
 * What a Code message offers. The phone holds only a thread's newest turns, so
 * the first of them offers no fork: the turn before it is either absent from
 * the thread or not here to name. A reply forks only once its turn has finished.
 */
export function mobileCodeTurnTargets(
  turns: ReadonlyArray<{
    readonly operationId: string;
    readonly status: string;
    readonly prompt: string;
  }>,
  index: number,
  role: "user" | "assistant",
): MobileTurnTargets {
  const turn = turns[index];
  const previous = turns[index - 1];
  const next = turns[index + 1];
  if (turn === undefined) return { removedTurns: 0 };
  if (role === "user") {
    return {
      ...(previous?.status === "completed" ? { forkThroughId: previous.operationId } : {}),
      rewindFromId: turn.operationId,
      ...(turn.prompt.length === 0 ? {} : { rewindPrompt: turn.prompt }),
      removedTurns: turns.length - index,
    };
  }
  return {
    ...(turn.status === "completed" ? { forkThroughId: turn.operationId } : {}),
    ...(next === undefined
      ? {}
      : {
          rewindFromId: next.operationId,
          ...(next.prompt.length === 0 ? {} : { rewindPrompt: next.prompt }),
        }),
    removedTurns: turns.length - index - 1,
  };
}

/** Code's Fork from here: a new thread on its own worktree, the source untouched. */
export async function forkMobileCodeThread(input: {
  readonly transport: MobileRemoteTransport;
  readonly sourceThreadId: string;
  readonly sourceTitle: string;
  readonly throughOperationId: string;
}): Promise<MobileInboxRow> {
  const result = await postJson({
    transport: input.transport,
    path: "/api/code/commands",
    body: {
      kind: "fork-code-thread",
      threadId: decodeCodeThreadId(globalThis.crypto.randomUUID()),
      sourceThreadId: input.sourceThreadId,
      throughOperationId: input.throughOperationId,
      title: mobileForkTitle(input.sourceTitle, "fork"),
    },
    decode: decodeHostAnswer(CodeCommandResult),
    failure: "The thread could not be forked. This thread is unchanged.",
  });
  if (result.kind !== "managed-thread-created") {
    throw new MobileInboxFailure(
      "unavailable",
      "The thread could not be forked. This thread is unchanged.",
    );
  }
  return inboxRow(input.transport.hostId, "code", result.thread, result.thread.updatedAt);
}

export interface MobileCodeRewindPreview {
  readonly removedTurns: number;
  readonly rollback: "native" | "handoff";
  readonly files: MobileRewindFiles;
}

type CodeScope = Pick<CodeOperationCommand, "threadId" | "checkoutId">;

/** Asks the host what a rewind would change. Nothing changes. */
export async function previewMobileCodeRewind(
  transport: MobileRemoteTransport,
  scope: CodeScope & { readonly fromOperationId: string },
): Promise<MobileCodeRewindPreview> {
  const result = await executeMobileCodeOperation(transport, {
    kind: "preview-code-rewind",
    operationId: globalThis.crypto.randomUUID() as CodeOperationCommand["operationId"],
    threadId: scope.threadId,
    checkoutId: scope.checkoutId,
    fromOperationId: scope.fromOperationId as never,
  });
  if (result.kind !== "rewind-preview") {
    throw new MobileInboxFailure(
      "unavailable",
      result.kind === "operation-failed"
        ? result.failure.message
        : "This thread could not be rewound here.",
    );
  }
  return {
    removedTurns: result.removedTurns,
    rollback: result.rollback,
    files:
      result.files.kind === "changes"
        ? {
            kind: "changes",
            paths: result.files.changes.files.map((file) => String(file.path)),
            total: result.files.changes.total,
          }
        : result.files.kind === "unchanged"
          ? { kind: "unchanged" }
          : { kind: "unavailable", reason: MOBILE_REWIND_FILES_UNAVAILABLE[result.files.reason] },
  };
}

/** Rewinds a Code thread in place. The host puts files back first, if asked. */
export async function rewindMobileCodeThread(
  transport: MobileRemoteTransport,
  scope: CodeScope & { readonly fromOperationId: string; readonly scope: MobileRewindScope },
): Promise<Extract<CodeOperationResult, { kind: "thread-rewound" }>> {
  const result = await executeMobileCodeOperation(transport, {
    kind: "rewind-code-thread",
    operationId: globalThis.crypto.randomUUID() as CodeOperationCommand["operationId"],
    threadId: scope.threadId,
    checkoutId: scope.checkoutId,
    fromOperationId: scope.fromOperationId as never,
    scope: scope.scope,
    filesOperationId: globalThis.crypto.randomUUID() as never,
    gitOperationId: globalThis.crypto.randomUUID() as never,
  });
  if (result.kind !== "thread-rewound") {
    throw new MobileInboxFailure(
      "unavailable",
      result.kind === "operation-failed"
        ? result.failure.message
        : "The rewind did not report a result. Refresh before assuming it did nothing.",
    );
  }
  return result;
}

import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  MAX_CODE_EVIDENCE_BATCH_ITEMS,
  MAX_CODE_OPERATION_TEXT_BYTES,
  type CodeConversationTurn,
  type CodeOperationCommand,
  CodeOperationResult,
  type CodePullRequestReview,
  CodeThread,
  CodeBootstrap,
  CodeConversationPage,
  CodeConversationWindow,
  CodeEvidenceBatchResponse,
  CodeEvidenceReference,
  decodeCodeAttachmentId,
  decodeHostAnswer,
  type CodeAttachmentId,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

async function decodeJson<T>(
  response: Response,
  decode: (value: unknown) => T,
  failureMessage: string,
): Promise<T> {
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      failureMessage,
    );
  }
  try {
    return decode(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      `${failureMessage} The host returned an invalid response.`,
    );
  }
}

function newOperationId(): string {
  return crypto.randomUUID();
}

/** Resolve a Code thread (including checkoutId) from the host bootstrap. */
export async function loadMobileCodeThread(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<CodeThread> {
  const bootstrap = await decodeJson(
    await transport.authenticatedFetch({ method: "GET", path: "/api/code/bootstrap" }),
    decodeHostAnswer(CodeBootstrap),
    "Code bootstrap failed over the remote session.",
  );
  const thread = bootstrap.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) {
    throw new MobileInboxFailure("unavailable", "Code thread is not available on this host.");
  }
  return decodeHostAnswer(CodeThread)(thread);
}

export async function executeMobileCodeOperation(
  transport: MobileRemoteTransport,
  command: CodeOperationCommand,
): Promise<CodeOperationResult> {
  const response = await transport.authenticatedFetch({
    method: "POST",
    path: "/api/code/commands",
    body: JSON.stringify(command),
  });
  const result = await decodeJson(
    response,
    decodeHostAnswer(CodeOperationResult),
    "Code operation failed over the remote session.",
  );
  if (result.operationId !== command.operationId) {
    throw new MobileInboxFailure("unavailable", "Code operation identity mismatch.");
  }
  return result;
}

export async function observeMobilePullRequest(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly maxDiffBytes?: number;
}): Promise<CodePullRequestReview> {
  const result = await executeMobileCodeOperation(input.transport, {
    kind: "observe-pull-request",
    operationId: newOperationId() as CodeOperationCommand["operationId"],
    threadId: input.threadId as CodeOperationCommand["threadId"],
    checkoutId: input.checkoutId as CodeOperationCommand["checkoutId"],
    maxDiffBytes: input.maxDiffBytes ?? 262_144,
  });
  if (result.kind !== "pull-request-review") {
    throw new MobileInboxFailure("unavailable", "Pull request observation returned no review.");
  }
  return result;
}

export interface MobileCodeConversationTurn {
  readonly operationId: string;
  readonly status: CodeConversationTurn["status"];
  readonly prompt: string;
  readonly assistant: ReadonlyArray<string>;
  readonly updatedAt: string;
}

/**
 * How many of a Code thread's newest turns the phone shows. The phone has no
 * way to load earlier turns, and a live turn re-reads this page on a short
 * cadence, so the page stays small.
 */
export const MOBILE_CODE_CONVERSATION_TURNS = 20;

/** The forward walk's page bound, for a host without the window read. */
const MAX_MOBILE_FORWARD_PAGES = 100;

export interface MobileCodeConversation {
  /** The thread's newest turns, oldest first. */
  readonly turns: ReadonlyArray<MobileCodeConversationTurn>;
  /** The thread has turns older than the first one here. */
  readonly hasEarlier: boolean;
}

/**
 * A Code thread's newest turns with the text behind every prompt and reply.
 * The window route hands back references; the evidence batch route resolves
 * them in one batch. Turns are kept newest first while their references fit
 * that batch, so the newest turn always shows (a very long one its first
 * parts) and an older turn is left out rather than shown blank.
 */
export async function loadMobileCodeConversation(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<MobileCodeConversation> {
  const read = await readNewestCodeTurns(transport, threadId);
  const kept: CodeConversationTurn[] = [];
  const wanted: Array<{ operationId: string; contentId: string }> = [];
  for (const turn of [...read.turns].reverse()) {
    const items = [
      { operationId: String(turn.operationId), contentId: String(turn.prompt.contentId) },
      ...turn.assistant.map((part) => ({
        operationId: String(turn.operationId),
        contentId: String(part.contentId),
      })),
    ];
    if (kept.length > 0 && wanted.length + items.length > MAX_CODE_EVIDENCE_BATCH_ITEMS) break;
    kept.unshift(turn);
    wanted.push(...items.slice(0, MAX_CODE_EVIDENCE_BATCH_ITEMS - wanted.length));
  }
  const text = new Map<string, string>();
  if (wanted.length > 0) {
    const batch = await decodeJson(
      await transport.authenticatedFetch({
        method: "POST",
        path: "/api/code/evidence/batch",
        body: JSON.stringify({ threadId, items: wanted }),
      }),
      decodeHostAnswer(CodeEvidenceBatchResponse),
      "Could not load the Code conversation text from the host.",
    );
    if (String(batch.threadId) !== threadId) {
      throw new MobileInboxFailure("unavailable", "Code evidence identity mismatch.");
    }
    for (const item of batch.items) {
      text.set(`${item.operationId}:${item.contentId}`, item.text);
    }
  }
  const resolve = (operationId: string, contentId: string) =>
    text.get(`${operationId}:${contentId}`) ?? "";
  return {
    turns: kept.map((turn) => ({
      operationId: String(turn.operationId),
      status: turn.status,
      prompt: resolve(String(turn.operationId), String(turn.prompt.contentId)),
      assistant: turn.assistant
        .map((part) => resolve(String(turn.operationId), String(part.contentId)))
        .filter((part) => part.length > 0),
      updatedAt: turn.updatedAt,
    })),
    hasEarlier: read.hasEarlier || kept.length < read.turns.length,
  };
}

/**
 * The thread's newest page of turns from the window read. A host without that
 * route answers 404; its forward read lists turns oldest first, so it is
 * walked to the end and only its tail is kept.
 */
async function readNewestCodeTurns(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<{ readonly turns: ReadonlyArray<CodeConversationTurn>; readonly hasEarlier: boolean }> {
  const path = `/api/code/threads/${encodeURIComponent(threadId)}/conversation`;
  const response = await transport.authenticatedFetch({
    method: "GET",
    path: `${path}/window`,
    query: `?limit=${MOBILE_CODE_CONVERSATION_TURNS}`,
  });
  if (response.status !== 404) {
    const window = await decodeJson(
      response,
      decodeHostAnswer(CodeConversationWindow),
      "Could not load the Code conversation from the host.",
    );
    if (String(window.threadId) !== threadId) {
      throw new MobileInboxFailure("unavailable", "Code conversation identity mismatch.");
    }
    return { turns: window.turns, hasEarlier: window.hasEarlier };
  }
  const turns: CodeConversationTurn[] = [];
  let listed = 0;
  let cursor = 0;
  for (let pages = 1; ; pages += 1) {
    const page = await decodeJson(
      await transport.authenticatedFetch({
        method: "GET",
        path,
        query: `?afterCursor=${cursor}&limit=${MAX_CODE_CONVERSATION_PAGE_SIZE}`,
      }),
      decodeHostAnswer(CodeConversationPage),
      "Could not load the Code conversation from the host.",
    );
    if (String(page.threadId) !== threadId) {
      throw new MobileInboxFailure("unavailable", "Code conversation identity mismatch.");
    }
    listed += page.turns.length;
    turns.push(...page.turns);
    // Only the tail is shown, so nothing older than it is held while walking.
    turns.splice(0, Math.max(0, turns.length - MOBILE_CODE_CONVERSATION_TURNS));
    if (!page.hasMore) break;
    if (page.nextCursor <= cursor || pages >= MAX_MOBILE_FORWARD_PAGES) {
      throw new MobileInboxFailure("unavailable", "The Code conversation did not advance.");
    }
    cursor = page.nextCursor;
  }
  return { turns, hasEarlier: listed > turns.length };
}

/**
 * Send a follow-up on an existing Code thread: stage the prompt as evidence,
 * then start a provider turn on the thread's own checkout. The posture is the
 * thread's; the phone asks for nothing wider, and approvals the turn raises
 * stay on the host.
 */
function stagedCodeAttachmentIds(ids: ReadonlyArray<string>): ReadonlyArray<CodeAttachmentId> {
  try {
    return ids.map((id) => decodeCodeAttachmentId(id));
  } catch {
    throw new MobileInboxFailure("rejected", "An attachment could not be sent with this turn.");
  }
}

export async function sendMobileCodeTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly prompt: string;
  /** Images already staged for this thread with `uploadMobileCodeAttachment`. */
  readonly attachmentIds?: ReadonlyArray<string>;
}): Promise<Extract<CodeOperationResult, { readonly kind: "provider-turn-state" }>> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new MobileInboxFailure("unavailable", "Prompt text is required.");
  }
  if (new TextEncoder().encode(prompt).byteLength > MAX_CODE_OPERATION_TEXT_BYTES) {
    throw new MobileInboxFailure("rejected", "Code prompts must be at most 64 KiB.");
  }
  const thread = await loadMobileCodeThread(input.transport, input.threadId);
  const evidence = await decodeJson(
    await input.transport.authenticatedFetch({
      method: "PUT",
      path: "/api/code/evidence",
      body: prompt,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-octant-code-thread-id": String(thread.id),
      },
      contentType: "text/plain; charset=utf-8",
    }),
    decodeHostAnswer(CodeEvidenceReference),
    "The prompt could not be staged on the host.",
  );
  const started = await executeMobileCodeOperation(input.transport, {
    kind: "start-provider-turn",
    operationId: newOperationId() as CodeOperationCommand["operationId"],
    threadId: thread.id,
    checkoutId: thread.checkoutId,
    sessionId: newOperationId() as Extract<
      CodeOperationCommand,
      { readonly kind: "start-provider-turn" }
    >["sessionId"],
    prompt: evidence,
    ...(input.attachmentIds === undefined || input.attachmentIds.length === 0
      ? {}
      : {
          attachmentIds: stagedCodeAttachmentIds(input.attachmentIds),
        }),
  });
  if (started.kind !== "provider-turn-state") {
    throw new MobileInboxFailure("unavailable", "The host did not start the Code turn.");
  }
  return started;
}

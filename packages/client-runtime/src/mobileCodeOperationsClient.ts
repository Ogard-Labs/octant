import {
  decodeCodeBootstrap,
  decodeCodeConversationPage,
  decodeCodeEvidenceBatchResponse,
  decodeCodeEvidenceReference,
  decodeCodeOperationResult,
  decodeCodeThread,
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  MAX_CODE_EVIDENCE_BATCH_ITEMS,
  MAX_CODE_OPERATION_TEXT_BYTES,
  type CodeConversationTurn,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodePullRequestReview,
  type CodeThread,
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
    decodeCodeBootstrap,
    "Code bootstrap failed over the remote session.",
  );
  const thread = bootstrap.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) {
    throw new MobileInboxFailure("unavailable", "Code thread is not available on this host.");
  }
  return decodeCodeThread(thread);
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
    decodeCodeOperationResult,
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
 * The most recent page of a Code thread's conversation with the text behind
 * every prompt and reply. The conversation route hands back references; the
 * evidence batch route resolves them, bounded to what one page can carry, so
 * a very long turn shows its first parts and says nothing it did not receive.
 */
export async function loadMobileCodeConversation(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<ReadonlyArray<MobileCodeConversationTurn>> {
  const page = await decodeJson(
    await transport.authenticatedFetch({
      method: "GET",
      path: `/api/code/threads/${encodeURIComponent(threadId)}/conversation`,
      query: `?afterCursor=0&limit=${MAX_CODE_CONVERSATION_PAGE_SIZE}`,
    }),
    decodeCodeConversationPage,
    "Could not load the Code conversation from the host.",
  );
  const wanted = page.turns
    .flatMap((turn) => [
      { operationId: turn.operationId, contentId: turn.prompt.contentId },
      ...turn.assistant.map((part) => ({
        operationId: turn.operationId,
        contentId: part.contentId,
      })),
    ])
    .slice(-MAX_CODE_EVIDENCE_BATCH_ITEMS);
  const text = new Map<string, string>();
  if (wanted.length > 0) {
    const batch = await decodeJson(
      await transport.authenticatedFetch({
        method: "POST",
        path: "/api/code/evidence/batch",
        body: JSON.stringify({ threadId, items: wanted }),
      }),
      decodeCodeEvidenceBatchResponse,
      "Could not load the Code conversation text from the host.",
    );
    for (const item of batch.items) {
      text.set(`${item.operationId}:${item.contentId}`, item.text);
    }
  }
  const resolve = (operationId: string, contentId: string) =>
    text.get(`${operationId}:${contentId}`) ?? "";
  return page.turns.map((turn) => ({
    operationId: String(turn.operationId),
    status: turn.status,
    prompt: resolve(String(turn.operationId), String(turn.prompt.contentId)),
    assistant: turn.assistant
      .map((part) => resolve(String(turn.operationId), String(part.contentId)))
      .filter((part) => part.length > 0),
    updatedAt: turn.updatedAt,
  }));
}

/**
 * Send a follow-up on an existing Code thread: stage the prompt as evidence,
 * then start a provider turn on the thread's own checkout. The posture is the
 * thread's; the phone asks for nothing wider, and approvals the turn raises
 * stay on the host.
 */
export async function sendMobileCodeTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly prompt: string;
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
    decodeCodeEvidenceReference,
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
  });
  if (started.kind !== "provider-turn-state") {
    throw new MobileInboxFailure("unavailable", "The host did not start the Code turn.");
  }
  return started;
}

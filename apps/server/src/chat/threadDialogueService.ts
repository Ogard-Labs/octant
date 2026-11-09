import {
  THREAD_DIALOGUE_TOOL_NAME,
  decodeChatThreadId,
  decodeThreadDialogueMessageInput,
  decodeThreadDialogueResult,
  type ChatThreadId,
  type ChatThreadView,
  type MentionableThreadId,
  type ProviderToolDefinition,
  type ThreadDialogueResult,
  type WindowId,
} from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";

const THREAD_DIALOGUE_TOOL = THREAD_DIALOGUE_TOOL_NAME;
const MAX_THREAD_DIALOGUE_MESSAGES_PER_TURN = 3;
const MAX_THREAD_DIALOGUE_REPLY_LENGTH = 8_000;

export interface ThreadDialogueServiceOptions {
  readonly resolveChatTargets: (
    windowId: WindowId,
    threadIds: ReadonlyArray<MentionableThreadId>,
  ) => Promise<ReadonlyArray<{ readonly threadId: MentionableThreadId; readonly title: string }>>;
  readonly readChatThread: (threadId: ChatThreadId) => ChatThreadView;
  /**
   * Whether a mentioned id names a Chat thread at all. A turn that mentions
   * only Work or Code threads is not offered the ask, because every call would
   * refuse; the call still re-resolves its target on the window's authority.
   */
  readonly isChatThread: (threadId: string) => boolean;
  readonly executeChat: (
    command: unknown,
    context: { readonly windowId: WindowId; readonly coordinationDepth: number },
  ) => Promise<unknown>;
  /**
   * Whether a Chat thread is a Side Chat sidecar. A sidecar exists to read one
   * source thread, and its composer can `#`-mention that source like any other
   * thread; without this check the mention granted the dialogue tool and a
   * Side Chat could append a turn to the thread it promises never to change.
   * Absent means this host records no sidecars.
   */
  readonly isSideChat?: (threadId: string) => boolean;
}

/** Provider-neutral, one-hop Chat coordination through explicit mention grants. */
export class ThreadDialogueService {
  readonly #options: ThreadDialogueServiceOptions;

  constructor(options: ThreadDialogueServiceOptions) {
    this.#options = options;
  }

  #isSideChat(threadId: string): boolean {
    return this.#options.isSideChat?.(threadId) === true;
  }

  forThread(input: {
    readonly windowId: WindowId;
    readonly sourceThreadId: ChatThreadId;
    readonly sourceTitle: string;
    readonly targetThreadIds: ReadonlyArray<MentionableThreadId>;
    readonly coordinationDepth?: number;
  }): AppManagedToolSet | undefined {
    if ((input.coordinationDepth ?? 0) > 0) return undefined;
    if (this.#isSideChat(String(input.sourceThreadId))) return undefined;
    const chatTargetIds = input.targetThreadIds.filter(
      (threadId) =>
        String(threadId) !== String(input.sourceThreadId) &&
        this.#options.isChatThread(String(threadId)),
    );
    const firstTarget = chatTargetIds[0];
    if (firstTarget === undefined) return undefined;
    let sends = 0;
    return {
      definitions: [THREAD_DIALOGUE_TOOL_DEFINITION],
      execute: async ({ name, inputJson, signal }) => {
        if (name !== THREAD_DIALOGUE_TOOL) {
          return {
            result: { status: "failed", message: "Thread dialogue tool is unknown." },
            isError: true,
          };
        }
        if (signal?.aborted) {
          return {
            result: failedResult(firstTarget, "Thread dialogue was interrupted."),
            isError: true,
          };
        }
        if (sends >= MAX_THREAD_DIALOGUE_MESSAGES_PER_TURN) {
          return {
            result: failedResult(
              firstTarget,
              "This turn reached the three-message coordination limit.",
            ),
            isError: true,
          };
        }
        sends += 1;
        let requestedTargetId = firstTarget;
        let requestedTargetTitle = "Target Chat";
        try {
          const request = decodeThreadDialogueMessageInput(JSON.parse(inputJson));
          requestedTargetId = request.targetThreadId;
          // Checked again at call time, before anything reaches the target:
          // the tool set may outlive the turn that resolved it, and neither a
          // sidecar nor a message into one may ever start a turn.
          if (
            this.#isSideChat(String(input.sourceThreadId)) ||
            this.#isSideChat(String(request.targetThreadId))
          ) {
            return {
              result: refusedResult(
                request.targetThreadId,
                "A Side Chat can read threads but cannot send them messages.",
              ),
              isError: true,
            };
          }
          const target = (
            await this.#options.resolveChatTargets(input.windowId, chatTargetIds)
          ).find((candidate) => String(candidate.threadId) === String(request.targetThreadId));
          if (target === undefined || String(target.threadId) === String(input.sourceThreadId)) {
            return {
              result: refusedResult(
                request.targetThreadId,
                "That Chat thread is not available for dialogue.",
              ),
              isError: true,
            };
          }
          requestedTargetTitle = target.title;
          const targetThreadId = decodeChatThreadId(String(target.threadId));
          const targetView = this.#options.readChatThread(targetThreadId);
          const result = await this.#options.executeChat(
            {
              kind: "send-chat-turn",
              threadId: targetThreadId,
              expectedVersion: targetView.thread.version,
              prompt: `Message from Chat thread "${input.sourceTitle}":\n\n${request.message}`,
            },
            { windowId: input.windowId, coordinationDepth: 1 },
          );
          const turnId = turnIdFromResult(result);
          if (turnId === undefined) {
            return {
              result: failedResult(
                request.targetThreadId,
                "The target Chat did not accept the message.",
              ),
              isError: true,
            };
          }
          const reply = extractReply(this.#options.readChatThread(targetThreadId), turnId);
          if (reply === undefined) {
            return {
              result: failedResult(
                request.targetThreadId,
                "The target Chat completed without a readable reply.",
              ),
              isError: true,
            };
          }
          return {
            result: decodeThreadDialogueResult({
              status: "completed",
              targetThreadId: request.targetThreadId,
              targetTitle: target.title,
              response: reply.slice(0, MAX_THREAD_DIALOGUE_REPLY_LENGTH),
            }),
          };
        } catch (error) {
          if (isWaiting(error)) {
            return {
              result: waitingResult(requestedTargetId, requestedTargetTitle, error.message),
              isError: true,
            };
          }
          return { result: failedResult(requestedTargetId, errorMessage(error)), isError: true };
        }
      },
    };
  }
}

const THREAD_DIALOGUE_TOOL_DEFINITION: ProviderToolDefinition = {
  name: THREAD_DIALOGUE_TOOL,
  description:
    "Ask a Chat thread the user mentioned in this message one bounded question or instruction, and wait for its reply. Use it only when the user asks you to coordinate with that thread, never to act on it otherwise; a turn may ask at most three times, and the thread you ask cannot ask onward. Waiting means that thread is busy: tell the user rather than retrying. Put the reply you get in your own answer.",
  inputSchema: {
    type: "object",
    properties: {
      targetThreadId: {
        type: "string",
        description: "The id of a Chat thread the user mentioned in this message.",
      },
      message: {
        type: "string",
        maxLength: 8_000,
        description: "The instruction for the target Chat.",
      },
    },
    required: ["targetThreadId", "message"],
    additionalProperties: false,
  },
};

function turnIdFromResult(value: unknown): string | undefined {
  if (!isRecord(value) || value.kind !== "turn-created" || !isRecord(value.turn)) return undefined;
  return typeof value.turn.id === "string" ? value.turn.id : undefined;
}

/**
 * The text a turn answered with: its completed attempts' assistant replies,
 * joined. Absent when the turn has no completed attempt or answered nothing.
 */
export function extractReply(view: ChatThreadView, turnId: string): string | undefined {
  const turn = view.turns.find((candidate) => String(candidate.id) === turnId);
  if (turn === undefined) return undefined;
  const contents = new Map(view.contents.map((content) => [String(content.contentId), content]));
  const reply = turn.attempts
    .filter((attempt) => attempt.outcome === "completed")
    .flatMap((attempt) => attempt.responseRefs)
    .map((reference) => contents.get(String(reference.contentId)))
    .flatMap((content) => (content?.role === "assistant" ? [content.body] : []))
    .join("")
    .trim();
  return reply.length === 0 ? undefined : reply;
}

function refusedResult(targetThreadId: MentionableThreadId, message: string): ThreadDialogueResult {
  return decodeThreadDialogueResult({ status: "refused", targetThreadId, message });
}

function waitingResult(
  targetThreadId: MentionableThreadId,
  targetTitle: string,
  message: string,
): ThreadDialogueResult {
  return decodeThreadDialogueResult({
    status: "waiting",
    targetThreadId,
    targetTitle,
    message,
  });
}

function failedResult(targetThreadId: MentionableThreadId, message: string): ThreadDialogueResult {
  return decodeThreadDialogueResult({ status: "failed", targetThreadId, message });
}

function isWaiting(
  error: unknown,
): error is Error & { readonly failure: { readonly category: string } } {
  return (
    error instanceof Error &&
    typeof error === "object" &&
    "failure" in error &&
    isRecord(error.failure) &&
    error.failure.category === "waiting"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Thread dialogue failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

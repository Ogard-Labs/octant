import { createHash } from "node:crypto";
import {
  decodeChatSubmissionId,
  type AggregateVersion,
  type AutomationRun,
  type ChatThreadId,
  type ProviderInstanceId,
  type ProviderModelId,
  type UtcTimestamp,
} from "@octant/contracts";
import { ChatServiceError } from "../chat/chatService";
import type {
  AutomationChatDispatchPort,
  AutomationFirstTurnLaunchOutcome,
  AutomationThreadCreationOutcome,
} from "./automationModeDispatchPorts";
import { automationThreadTitle } from "./automationDispatchService";

/** What the adapter needs of the Chat service: the ordinary read and command path. */
export interface AutomationChatService {
  readonly read: (threadId: ChatThreadId) => {
    readonly thread: {
      readonly id: ChatThreadId;
      readonly version: AggregateVersion;
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
    };
  };
  readonly execute: (command: unknown) => Promise<{ readonly kind: string }>;
}

export interface CreateAutomationChatDispatchPortOptions {
  readonly chat: AutomationChatService;
  readonly clock: () => UtcTimestamp;
}

/**
 * Production Chat adapter. Creates the thread inside the routine's Chat
 * Project through `create-chat-thread`, then sends the task as one turn under
 * a submission identity derived from the occurrence, so a retry after a crash
 * finds the turn it already sent. The thread takes the routine's provider and
 * model, not the Chat defaults. Chat has no folder, shell, or Git, so there is
 * no level to carry.
 */
export function createAutomationChatDispatchPort(
  options: CreateAutomationChatDispatchPortOptions,
): AutomationChatDispatchPort {
  return {
    async createThread(input) {
      return createChatThread(options, input);
    },
    async startOrRecoverFirstTurn(input) {
      return startOrRecover(options, input);
    },
  };
}

async function createChatThread(
  options: CreateAutomationChatDispatchPortOptions,
  input: { readonly run: AutomationRun; readonly threadId: ChatThreadId; readonly title: string },
): Promise<AutomationThreadCreationOutcome> {
  if (readThread(options.chat, input.threadId) !== undefined) {
    return { kind: "existing", threadId: input.threadId as never };
  }
  const snapshot = input.run.definitionSnapshot;
  if (snapshot.binding.kind !== "chat") {
    return {
      kind: "failed",
      reason: "thread-creation-failed",
      message: "Chat Automation binding is missing.",
    };
  }
  try {
    const created = await options.chat.execute({
      kind: "create-chat-thread",
      threadId: input.threadId,
      title: input.title.length > 0 ? input.title : automationThreadTitle(snapshot.displayName),
      projectId: snapshot.projectId,
    });
    if (created.kind === "thread-created") {
      return { kind: "created", threadId: input.threadId as never, createdAt: options.clock() };
    }
    return {
      kind: "failed",
      reason: "thread-creation-failed",
      message: "Chat thread creation did not return a thread receipt.",
    };
  } catch (error) {
    if (readThread(options.chat, input.threadId) !== undefined) {
      return { kind: "existing", threadId: input.threadId as never };
    }
    return {
      kind: "failed",
      reason: "thread-creation-failed",
      message: error instanceof Error ? error.message : "Chat thread creation failed.",
    };
  }
}

async function startOrRecover(
  options: CreateAutomationChatDispatchPortOptions,
  input: { readonly run: AutomationRun; readonly threadId: ChatThreadId },
): Promise<AutomationFirstTurnLaunchOutcome> {
  const snapshot = input.run.definitionSnapshot;
  try {
    let thread = readThread(options.chat, input.threadId);
    if (thread === undefined) {
      return {
        kind: "failed",
        reason: "recovery-failed",
        message: "The Chat thread for this run is gone.",
      };
    }
    const { providerInstanceId, modelId } = snapshot.executionProfile;
    if (
      String(thread.providerInstanceId) !== String(providerInstanceId) ||
      String(thread.modelId) !== String(modelId)
    ) {
      await options.chat.execute({
        kind: "change-chat-provider",
        threadId: input.threadId,
        expectedVersion: thread.version,
        providerInstanceId,
        modelId,
      });
      thread = readThread(options.chat, input.threadId);
      if (thread === undefined) {
        return {
          kind: "failed",
          reason: "recovery-failed",
          message: "The Chat thread for this run is gone.",
        };
      }
    }
    await options.chat.execute({
      kind: "send-chat-turn",
      threadId: input.threadId,
      expectedVersion: thread.version,
      prompt: snapshot.taskPrompt,
      submissionId: decodeChatSubmissionId(
        deterministicUuid(`automation-chat-turn:${String(input.run.occurrenceKey)}`),
      ),
    });
    return {
      kind: "accepted",
      runtimeReceipt: `chat-turn:${String(input.run.firstTurnRequestId)}`,
      acceptedAt: options.clock(),
    };
  } catch (error) {
    if (error instanceof ChatServiceError) {
      if (error.failure.category === "waiting") {
        return { kind: "waiting-capacity", message: error.failure.message };
      }
      return { kind: "failed", reason: "provider-launch-failed", message: error.failure.message };
    }
    return {
      kind: "failed",
      reason: "recovery-failed",
      message: error instanceof Error ? error.message : "Chat provider turn recovery failed.",
    };
  }
}

function readThread(
  chat: AutomationChatService,
  threadId: ChatThreadId,
): ReturnType<AutomationChatService["read"]>["thread"] | undefined {
  try {
    return chat.read(threadId).thread;
  } catch {
    return undefined;
  }
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

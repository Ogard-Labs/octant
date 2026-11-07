import {
  decodeChatSubmissionId,
  decodeChatThreadId,
  decodeProjectId,
  type AggregateVersion,
  type ChatAttemptOutcome,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { ChatServiceError } from "../chat/chatService";
import { deterministicUuid } from "../deterministicUuid";

/** Where benchmark threads live: one Chat Project, so its spend ceilings apply. */
export const BENCHMARKS_PROJECT_NAME = "Benchmarks";

/**
 * The Benchmarks Project has one fixed identity, so the host finds it again
 * after a restart without keeping a second record of it.
 */
export const BENCHMARKS_PROJECT_ID = decodeProjectId(deterministicUuid("benchmarks-chat-project"));

export type BenchmarkTurnReading =
  | { readonly status: "gone" }
  | { readonly status: "no-turn" }
  | {
      readonly status: "turn";
      readonly turnId: string;
      /** The attempt a stop would interrupt; absent while the turn has none. */
      readonly attemptId?: string;
      readonly outcome: ChatAttemptOutcome;
      readonly failureMessage?: string;
    };

export type BenchmarkTurnStart =
  | { readonly status: "started"; readonly turnId: string }
  /** The ordinary capacity admission has no room yet; the cell stays queued. */
  | { readonly status: "waiting"; readonly message: string }
  | { readonly status: "refused"; readonly message: string };

export interface BenchmarkTurnInput {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly effort?: string;
  readonly prompt: string;
  readonly submissionId: string;
}

/**
 * What the runner may ask of Chat. Every method goes through the ordinary
 * Chat commands, so the capacity scheduler, the Project spend ceiling, and the
 * provider's capability refusal apply exactly as they do to a person's turn.
 */
export interface BenchmarkChatPort {
  /** Creates the thread if it is missing, puts it on the model, and sends one turn. Safe to repeat. */
  startTurn(input: BenchmarkTurnInput): Promise<BenchmarkTurnStart>;
  readTurn(threadId: string, submissionId: string): BenchmarkTurnReading;
  /** The turn's reply text, absent when it answered nothing. */
  readAnswer(threadId: string, turnId: string): string | undefined;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
}

/** The slice of the Chat service the adapter uses. */
export interface BenchmarkChatService {
  readonly read: (threadId: ReturnType<typeof decodeChatThreadId>) => {
    readonly thread: {
      readonly version: AggregateVersion;
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
      readonly lifecycle: string;
    };
    readonly turns: ReadonlyArray<{
      readonly id: string;
      readonly submissionId?: string | undefined;
      readonly attempts: ReadonlyArray<{
        readonly id: string;
        readonly outcome: ChatAttemptOutcome;
        readonly failure?: { readonly message?: string | undefined } | undefined;
      }>;
    }>;
  };
  readonly execute: (command: unknown) => Promise<{ readonly kind: string }>;
}

export interface CreateBenchmarkChatPortOptions {
  readonly chat: BenchmarkChatService;
  /** The turn's reply text, read from the thread's content. */
  readonly answer: (threadId: string, turnId: string) => string | undefined;
}

export function createBenchmarkChatPort(
  options: CreateBenchmarkChatPortOptions,
): BenchmarkChatPort {
  const { chat } = options;
  const view = (threadId: string) => {
    try {
      return chat.read(decodeChatThreadId(threadId));
    } catch {
      return undefined;
    }
  };
  return {
    async startTurn(input) {
      try {
        const chatThreadId = decodeChatThreadId(input.threadId);
        let current = view(input.threadId);
        if (current === undefined) {
          await chat.execute({
            kind: "create-chat-thread",
            threadId: chatThreadId,
            title: input.title,
            projectId: input.projectId,
          });
          current = view(input.threadId);
          if (current === undefined) {
            return { status: "refused", message: "The benchmark thread could not be created." };
          }
        }
        const existing = current.turns.find((turn) => turn.submissionId === input.submissionId);
        if (existing !== undefined) return { status: "started", turnId: existing.id };
        if (current.turns.length > 0) {
          return { status: "refused", message: "The benchmark thread already holds another turn." };
        }
        if (
          String(current.thread.providerInstanceId) !== String(input.providerInstanceId) ||
          String(current.thread.modelId) !== String(input.modelId) ||
          input.effort !== undefined
        ) {
          await chat.execute({
            kind: "change-chat-provider",
            threadId: chatThreadId,
            expectedVersion: current.thread.version,
            providerInstanceId: input.providerInstanceId,
            modelId: input.modelId,
            ...(input.effort === undefined ? {} : { modelOptionValues: { effort: input.effort } }),
          });
          current = view(input.threadId);
          if (current === undefined) {
            return { status: "refused", message: "The benchmark thread is gone." };
          }
        }
        const sent = await chat.execute({
          kind: "send-chat-turn",
          threadId: chatThreadId,
          expectedVersion: current.thread.version,
          prompt: input.prompt,
          submissionId: decodeChatSubmissionId(input.submissionId),
        });
        const accepted = view(input.threadId)?.turns.find(
          (turn) => turn.submissionId === input.submissionId,
        );
        if (accepted === undefined) {
          return {
            status: "refused",
            message: `The turn was not accepted (${sent.kind}).`,
          };
        }
        return { status: "started", turnId: accepted.id };
      } catch (error) {
        if (error instanceof ChatServiceError) {
          return error.failure.category === "waiting"
            ? { status: "waiting", message: error.failure.message }
            : { status: "refused", message: error.failure.message };
        }
        return {
          status: "refused",
          message: error instanceof Error ? error.message : "The turn could not be started.",
        };
      }
    },
    readTurn(threadId, submissionId) {
      const current = view(threadId);
      if (current === undefined) return { status: "gone" };
      const turn = current.turns.find((candidate) => candidate.submissionId === submissionId);
      if (turn === undefined) return { status: "no-turn" };
      const attempt = turn.attempts.at(-1);
      if (attempt === undefined) {
        return { status: "turn", turnId: turn.id, outcome: "queued" };
      }
      return {
        status: "turn",
        turnId: turn.id,
        attemptId: attempt.id,
        outcome: attempt.outcome,
        ...(attempt.failure?.message === undefined
          ? {}
          : { failureMessage: attempt.failure.message }),
      };
    },
    readAnswer: (threadId, turnId) => options.answer(threadId, turnId),
    async interruptTurn(threadId, turnId) {
      const current = view(threadId);
      const attempt = current?.turns.find((turn) => turn.id === turnId)?.attempts.at(-1);
      if (current === undefined || attempt === undefined) return;
      try {
        await chat.execute({
          kind: "interrupt-chat-turn",
          threadId: decodeChatThreadId(threadId),
          expectedVersion: current.thread.version,
          turnId,
          attemptId: attempt.id,
        });
      } catch {
        // A turn that already ended has nothing to interrupt.
      }
    },
    async archiveThread(threadId) {
      const current = view(threadId);
      if (current === undefined || current.thread.lifecycle !== "active") return;
      try {
        await chat.execute({
          kind: "change-chat-thread-lifecycle",
          threadId: decodeChatThreadId(threadId),
          expectedVersion: current.thread.version,
          lifecycle: "archived",
        });
      } catch {
        // The cell is already settled; a thread left active only shows in the list.
      }
    },
  };
}

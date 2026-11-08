import {
  decodeChatAttemptId,
  decodeChatSubmissionId,
  decodeChatTurnId,
  decodeChatThreadId,
  decodeProjectId,
  type AggregateVersion,
  type ChatAttemptOutcome,
  type ChatCommand,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { ChatServiceError, type ChatServiceExecutionContext } from "../chat/chatService";
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
      /** The closed code the host gave a failed or interrupted attempt. */
      readonly failureCode?: string;
    };

/** The code Chat gives an attempt it could not admit for lack of capacity. */
export const CAPACITY_UNAVAILABLE_FAILURE_CODE = "capacity-unavailable";

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
  /** Resolves once every send the port started in the background has ended; for shutdown and tests. */
  whenIdle?(): Promise<void>;
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
        readonly failure?:
          | { readonly message?: string | undefined; readonly code?: string | undefined }
          | undefined;
      }>;
    }>;
  };
  readonly execute: (
    command: ChatCommand,
    context?: ChatServiceExecutionContext,
  ) => Promise<{ readonly kind: string }>;
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
  // Chat's send and retry commands do not return until the provider has
  // answered, so awaiting one would hold the runner for the whole response. A
  // command runs here in the background, owned by the port: the caller learns
  // when the turn is durably in, and an error after that point is logged and
  // swallowed, because the turn's own attempt records how it ended.
  const background = new Set<Promise<unknown>>();
  const dispatch = (
    command: ChatCommand,
    isAccepted: () => boolean,
  ): Promise<
    { readonly status: "accepted" } | { readonly status: "failed"; readonly error: unknown }
  > =>
    new Promise((resolve) => {
      let answered = false;
      const answer = (outcome: Parameters<typeof resolve>[0]) => {
        if (answered) return;
        answered = true;
        resolve(outcome);
      };
      const running = chat
        .execute(command, { onTurnAccepted: () => answer({ status: "accepted" }) })
        .then(
          () => answer({ status: "accepted" }),
          (error: unknown) => {
            if (answered) {
              console.warn("A benchmark turn ended with an error after it was accepted.", error);
            }
            answer({ status: "failed", error });
          },
        )
        .finally(() => background.delete(running));
      background.add(running);
      // A retry has no acceptance hook; its new attempt is journaled before it
      // runs, so the port watches for it.
      void (async () => {
        while (!answered) {
          if (isAccepted()) return answer({ status: "accepted" });
          await new Promise((wake) => setTimeout(wake, 10));
        }
      })();
    });
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
        if (existing !== undefined) {
          const last = existing.attempts.at(-1);
          if (
            last === undefined ||
            last.outcome !== "interrupted" ||
            last.failure?.code !== CAPACITY_UNAVAILABLE_FAILURE_CODE
          ) {
            return { status: "started", turnId: existing.id };
          }
          // Chat had no room when the attempt was admitted. The turn exists, so
          // it is retried rather than sent again.
          const attemptsBefore = existing.attempts.length;
          const retried = await dispatch(
            {
              kind: "retry-chat-turn",
              threadId: chatThreadId,
              expectedVersion: current.thread.version,
              turnId: decodeChatTurnId(existing.id),
              attemptId: decodeChatAttemptId(last.id),
            },
            () =>
              (view(input.threadId)?.turns.find((turn) => turn.id === existing.id)?.attempts
                .length ?? 0) > attemptsBefore,
          );
          if (retried.status === "failed") throw retried.error;
          return { status: "started", turnId: existing.id };
        }
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
        const sent = await dispatch(
          {
            kind: "send-chat-turn",
            threadId: chatThreadId,
            expectedVersion: current.thread.version,
            prompt: input.prompt,
            submissionId: decodeChatSubmissionId(input.submissionId),
          },
          () =>
            view(input.threadId)?.turns.some((turn) => turn.submissionId === input.submissionId) ===
            true,
        );
        if (sent.status === "failed") throw sent.error;
        const accepted = view(input.threadId)?.turns.find(
          (turn) => turn.submissionId === input.submissionId,
        );
        if (accepted === undefined) {
          return {
            status: "refused",
            message: "The turn was not accepted.",
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
        ...(attempt.failure?.code === undefined ? {} : { failureCode: attempt.failure.code }),
      };
    },
    readAnswer: (threadId, turnId) => options.answer(threadId, turnId),
    async whenIdle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },
    async interruptTurn(threadId, turnId) {
      const current = view(threadId);
      const attempt = current?.turns.find((turn) => turn.id === turnId)?.attempts.at(-1);
      if (current === undefined || attempt === undefined) return;
      try {
        await chat.execute({
          kind: "interrupt-chat-turn",
          threadId: decodeChatThreadId(threadId),
          expectedVersion: current.thread.version,
          turnId: decodeChatTurnId(turnId),
          attemptId: decodeChatAttemptId(attempt.id),
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

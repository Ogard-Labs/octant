import { describe, expect, it } from "vitest";
import { ChatServiceError } from "../chat/chatService";
import { deterministicUuid } from "../deterministicUuid";
import {
  BENCHMARKS_PROJECT_ID,
  createBenchmarkChatPort,
  type BenchmarkChatService,
  type BenchmarkTurnInput,
} from "./benchmarkChatPort";

const thread = deterministicUuid("thread");
const submission = deterministicUuid("submission");
const provider = "66800000-0000-4000-8000-000000000001";

function input(overrides: Partial<BenchmarkTurnInput> = {}): BenchmarkTurnInput {
  return {
    threadId: thread,
    title: "Smoke · Greeting · model-a",
    projectId: BENCHMARKS_PROJECT_ID,
    providerInstanceId: provider as never,
    modelId: "model-a" as never,
    prompt: "Say hello.",
    submissionId: submission,
    ...overrides,
  };
}

/** A Chat that keeps one thread and records every command it is given. */
function fakeChat(options: { readonly refuse?: ChatServiceError } = {}) {
  const commands: Array<Record<string, unknown>> = [];
  let created = false;
  let version = 1;
  let model = "default-model";
  let turns: Array<{ id: string; submissionId?: string; attempts: never[] }> = [];
  const chat: BenchmarkChatService = {
    read: () => {
      if (!created) throw new Error("no thread");
      return {
        thread: {
          version: version as never,
          providerInstanceId: provider as never,
          modelId: model as never,
          lifecycle: "active",
        },
        turns,
      };
    },
    execute: async (command) => {
      const record = command as Record<string, unknown>;
      commands.push(record);
      if (record.kind === "create-chat-thread") created = true;
      if (record.kind === "change-chat-provider") model = String(record.modelId);
      if (record.kind === "send-chat-turn") {
        if (options.refuse !== undefined) throw options.refuse;
        turns = [
          ...turns,
          {
            id: deterministicUuid("turn"),
            submissionId: String(record.submissionId),
            attempts: [],
          },
        ];
      }
      version += 1;
      return { kind: String(record.kind) };
    },
  };
  return { chat, commands };
}

describe("benchmark chat port", () => {
  it("creates the thread in the Benchmarks Project, puts it on the model and effort, and sends one turn with a fixed submission id", async () => {
    const { chat, commands } = fakeChat();
    const port = createBenchmarkChatPort({ chat, answer: () => undefined });

    const started = await port.startTurn(input({ effort: "high" }));

    expect(started).toEqual({ status: "started", turnId: deterministicUuid("turn") });
    expect(commands.map((command) => command.kind)).toEqual([
      "create-chat-thread",
      "change-chat-provider",
      "send-chat-turn",
    ]);
    expect(commands[0]).toMatchObject({ threadId: thread, projectId: BENCHMARKS_PROJECT_ID });
    expect(commands[1]).toMatchObject({
      modelId: "model-a",
      modelOptionValues: { effort: "high" },
    });
    expect(commands[2]).toMatchObject({ prompt: "Say hello.", submissionId: submission });
  });

  it("finds the turn it already sent instead of sending a second one", async () => {
    const { chat, commands } = fakeChat();
    const port = createBenchmarkChatPort({ chat, answer: () => undefined });
    await port.startTurn(input());
    const before = commands.length;

    const again = await port.startTurn(input());

    expect(again.status).toBe("started");
    expect(commands).toHaveLength(before);
  });

  it("reports waiting when Chat has no capacity and a sentence when Chat refuses", async () => {
    const waiting = fakeChat({
      refuse: new ChatServiceError({ category: "waiting", message: "Waiting for capacity." }),
    });
    expect(
      await createBenchmarkChatPort({ chat: waiting.chat, answer: () => undefined }).startTurn(
        input(),
      ),
    ).toEqual({ status: "waiting", message: "Waiting for capacity." });

    const refused = fakeChat({
      refuse: new ChatServiceError({ category: "unavailable", message: "Spend ceiling reached." }),
    });
    expect(
      await createBenchmarkChatPort({ chat: refused.chat, answer: () => undefined }).startTurn(
        input(),
      ),
    ).toEqual({ status: "refused", message: "Spend ceiling reached." });
  });
});

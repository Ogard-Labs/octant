import { afterEach, describe, expect, it } from "vitest";
import type { ChatCommand } from "@octant/contracts";
import { deterministicUuid } from "../deterministicUuid";
import {
  BENCHMARKS_PROJECT_ID,
  createBenchmarkChatPort,
  type BenchmarkChatService,
} from "./benchmarkChatPort";
import { createWorkerPatternMatcher } from "./benchmarkPatternMatcher";
import { BenchmarkRunner, benchmarkCellIdentity } from "./benchmarkRunner";
import {
  BENCHMARK_TEST_NOW,
  benchmarkIds,
  openBenchmarkTestStore,
  removeBenchmarkTestStores,
  sampleRun,
} from "./benchmarkTestSupport";

afterEach(removeBenchmarkTestStores);

interface FakeAttempt {
  id: string;
  outcome: "streaming" | "interrupted" | "cancelled" | "completed";
  failure?: { code: string; message: string };
}
interface FakeTurn {
  id: string;
  submissionId?: string;
  attempts: FakeAttempt[];
}

/**
 * A Chat like the production one: a send or retry resolves only when the
 * provider has answered, which these turns never do. It calls the acceptance
 * hook once the turn is journaled.
 */
function neverAnsweringChat() {
  const threads = new Map<
    string,
    { version: number; provider: string; model: string; turns: FakeTurn[] }
  >();
  const commands: ChatCommand[] = [];
  const chat: BenchmarkChatService = {
    read: (threadId) => {
      const thread = threads.get(String(threadId));
      if (thread === undefined) throw new Error("no thread");
      return {
        thread: {
          version: thread.version as never,
          providerInstanceId: thread.provider as never,
          modelId: thread.model as never,
          lifecycle: "active",
        },
        turns: thread.turns,
      };
    },
    execute: async (command, context) => {
      commands.push(command);
      if (command.kind === "create-chat-thread") {
        threads.set(String(command.threadId), { version: 1, provider: "", model: "", turns: [] });
        return { kind: "thread-created" };
      }
      const thread = threads.get(String((command as { threadId: string }).threadId));
      if (thread === undefined) throw new Error("no thread");
      thread.version += 1;
      if (command.kind === "change-chat-provider") {
        thread.provider = String(command.providerInstanceId);
        thread.model = String(command.modelId);
        return { kind: "thread-updated" };
      }
      if (command.kind === "send-chat-turn") {
        const turnId = deterministicUuid(`turn:${String(command.submissionId)}`);
        thread.turns.push({
          id: turnId,
          ...(command.submissionId === undefined
            ? {}
            : { submissionId: String(command.submissionId) }),
          attempts: [{ id: deterministicUuid(`attempt:${turnId}`), outcome: "streaming" }],
        });
        context?.onTurnAccepted?.();
        return new Promise(() => undefined);
      }
      if (command.kind === "retry-chat-turn") {
        const turn = thread.turns.find((candidate) => candidate.id === String(command.turnId));
        turn?.attempts.push({
          id: deterministicUuid(`retry:${turn.attempts.length}`),
          outcome: "streaming",
        });
        return new Promise(() => undefined);
      }
      if (command.kind === "interrupt-chat-turn") {
        for (const turn of thread.turns) {
          const last = turn.attempts.at(-1);
          if (last !== undefined) last.outcome = "cancelled";
        }
      }
      return { kind: "ok" };
    },
  };
  return { chat, commands, threads };
}

function setup(providers: ReadonlyArray<string>) {
  const opened = openBenchmarkTestStore();
  const fake = neverAnsweringChat();
  const port = createBenchmarkChatPort({ chat: fake.chat, answer: () => undefined });
  const runner = new BenchmarkRunner({
    chat: port,
    projection: opened.projection,
    store: opened.store,
    turnMetrics: { forThread: () => [] },
    projectId: BENCHMARKS_PROJECT_ID,
    matchPattern: createWorkerPatternMatcher(300),
    clock: () => BENCHMARK_TEST_NOW,
  });
  const run = sampleRun({ providers });
  opened.store.runStarted({ run });
  return { ...opened, ...fake, runner, run };
}

describe("benchmark runner over a Chat whose turns never answer", () => {
  it("starts cells on different providers in one tick without waiting for any provider's answer", async () => {
    const { runner, projection } = setup([benchmarkIds.providerA, benchmarkIds.providerB]);

    await runner.tick();

    const cells = projection.run(benchmarkIds.run)!.cells;
    expect(cells).toHaveLength(4);
    expect(cells.map((cell) => cell.state)).toEqual(["running", "running", "running", "running"]);
    expect(cells.every((cell) => cell.turnId !== undefined)).toBe(true);
  });

  it("cancels a run whose provider response has not come back", async () => {
    const { runner, projection, commands } = setup([
      benchmarkIds.providerA,
      benchmarkIds.providerB,
    ]);
    await runner.tick();

    const cancelled = await runner.cancel(benchmarkIds.run);

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cells.every((cell) => cell.state === "cancelled")).toBe(true);
    expect(commands.filter((command) => command.kind === "interrupt-chat-turn")).toHaveLength(4);
    expect(projection.runningRuns()).toEqual([]);
  });

  it("retries the turn it has when Chat had no capacity, and never sends a second turn", async () => {
    const { runner, projection, commands, threads, run } = setup([benchmarkIds.providerA]);
    await runner.tick();
    const cell = run.cells[0]!;
    const thread = threads.get(benchmarkCellIdentity(String(cell.cellId)).threadId)!;
    const attempt = thread.turns[0]!.attempts[0]!;
    attempt.outcome = "interrupted";
    attempt.failure = { code: "capacity-unavailable", message: "Waited for a free request slot." };

    await runner.tick();
    expect(projection.run(benchmarkIds.run)!.cells[0]?.state).toBe("queued");
    await runner.tick();

    expect(projection.run(benchmarkIds.run)!.cells[0]?.state).toBe("running");
    const forCell = commands.filter(
      (command) =>
        "threadId" in command &&
        String(command.threadId) === benchmarkCellIdentity(String(cell.cellId)).threadId,
    );
    expect(forCell.filter((command) => command.kind === "send-chat-turn")).toHaveLength(1);
    expect(forCell.filter((command) => command.kind === "retry-chat-turn")).toHaveLength(1);
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]?.attempts).toHaveLength(2);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type CodeConversationTurn,
  type CodeThread,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderResumeCursor,
  type ProviderRuntimeEvent,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { deriveTurnMetrics, ledgerUsageCost } from "@octant/domain";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { usageFromRuntimeEvent } from "../providers/providerContextFacts";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { buildUsageDashboard } from "../usageDashboardModel";
import { seedCodeForkHarnessSession } from "./nativeHarnessFork";
import { createCodeJournalLookup } from "./nativeHarnessJournalLookup";
import { createNativeHarnessConnection, fitRequest } from "./nativeHarnessLoop";
import {
  JournalNativeHarnessTranscriptStore,
  MemoryNativeHarnessTranscriptStore,
  type NativeHarnessTranscriptStore,
} from "./nativeHarnessTranscriptStore";
import { sendWithEndpointRetry } from "../providers/endpointRetry";
import type {
  NativeHarnessLeadFallback,
  NativeHarnessRequest,
  NativeHarnessResponse,
  NativeHarnessStreamEvent,
  NativeHarnessTransport,
  NativeHarnessTransportSession,
} from "./nativeHarnessTransport";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000901");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000902");
const modelId = "harness-model" as ProviderModelId;
const projectRoot = "/tmp/octant-harness-loop";
const now = "2026-10-02T09:00:00.000Z";
const tool = (name: string): ProviderToolDefinition => ({
  name,
  inputSchema: { type: "object", properties: {} },
});
const tools = [tool("read"), tool("grep"), tool("bash")];
const withLookup = [...tools, tool("journal-lookup")];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** An endpoint that answers from a script and remembers every request it was sent. */
function scriptedTransport(
  script: NativeHarnessResponse[],
  fits: (request: NativeHarnessRequest) => boolean = () => true,
  retried = false,
): {
  readonly transport: NativeHarnessTransport;
  readonly requests: NativeHarnessRequest[];
} {
  const requests: NativeHarnessRequest[] = [];
  return {
    requests,
    transport: {
      open: async () => ({
        fits,
        send: async (request, stream) => {
          requests.push(request);
          if (retried)
            stream.onEvent({
              kind: "retrying",
              attempt: 2,
              maxAttempts: 5,
              delayMs: 500,
              reason: "unavailable",
            });
          const next = script.shift();
          if (next === undefined) throw new Error("The script ran out of responses.");
          return next;
        },
        release: () => undefined,
      }),
    },
  };
}

function connect(
  transport: NativeHarnessTransport,
  transcripts: NativeHarnessTranscriptStore,
  leadFallback?: NativeHarnessLeadFallback,
  mode: "chat" | "work" | "code" = "code",
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return createNativeHarnessConnection({
    instanceId,
    driverKind: "openai-compatible",
    projectRoot,
    mode,
    transport,
    transcripts,
    ...(leadFallback === undefined ? {} : { leadFallback }),
    admitTurn: () => undefined,
    clock: () => now,
    correlationId: () => "80000000-0000-4000-8000-000000000903",
  });
}

/** Sends a prompt and collects events until the turn ends or asks for tools. */
function sendAndCollect(
  connection: ProviderConnection,
  prompt: string,
  until: (event: ProviderRuntimeEvent) => boolean,
  context: NonNullable<Parameters<ProviderConnection["send"]>[0]["context"]> = [],
  offered: ReadonlyArray<ProviderToolDefinition> = tools,
) {
  return Effect.gen(function* () {
    const events = yield* Effect.fork(
      Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(until))),
    );
    yield* connection.send({ sessionId, prompt, context, attachments: [], tools: offered });
    return Array.from(yield* Fiber.join(events));
  });
}

const isTerminal = (event: ProviderRuntimeEvent) =>
  event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted";

/** How the model is told that a compaction summary stands for the session's first turns. */
const summaryLead = (turns: number) =>
  `${
    turns === 1
      ? "The first turn of this session was summarized and is"
      : `The first ${turns} turns of this session were summarized and are`
  } no longer shown in full; the files on disk still reflect that work. Summary:`;

describe("native harness loop", () => {
  it.each([
    ["start", "cancel"],
    ["resume", "cancel"],
    ["start", "close"],
    ["resume", "close"],
  ] as const)(
    "releases a late %s endpoint after %s without admitting or journaling a session",
    async (operation, boundary) => {
      let finishOpen: ((endpoint: NativeHarnessTransportSession) => void) | undefined;
      let active = 0;
      const release = vi.fn();
      const send = vi.fn(async () => ({ text: "unused", toolCalls: [] }));
      const transcripts = new MemoryNativeHarnessTranscriptStore();
      if (operation === "resume") {
        transcripts.open(sessionId, { instanceId, modelId, projectRoot, mode: "code" });
      }
      const before = transcripts.load(sessionId);
      const scope = await Effect.runPromise(Scope.make());
      const connection = await Effect.runPromise(
        createNativeHarnessConnection({
          instanceId,
          driverKind: "openai-compatible",
          projectRoot,
          mode: "code",
          transport: {
            open: () =>
              new Promise((resolve) => {
                finishOpen = resolve;
              }),
          },
          transcripts,
          admitTurn: () => undefined,
          clock: () => now,
          correlationId: () => "80000000-0000-4000-8000-000000000903",
          onSessionCountChange: (delta) => {
            active += delta;
          },
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      const input = { sessionId, modelId, executionPolicy: "plan" as const, tools };
      const start = Effect.runFork(
        operation === "start"
          ? connection.start(input)
          : connection.resume({
              ...input,
              resumeCursor: { driverKind: "openai-compatible", value: sessionId },
            }),
      );
      try {
        await vi.waitFor(() => expect(finishOpen).toBeDefined());
        if (boundary === "cancel") await Effect.runPromise(Fiber.interrupt(start));
        else await Effect.runPromise(Scope.close(scope, Exit.void));
        // Cancellation alone must discard the endpoint; closing the connection
        // must also refuse a pending start whose caller has not been interrupted.
        const resolve = finishOpen;
        if (resolve === undefined) throw new Error("Endpoint opening did not start.");
        resolve({ fits: () => true, send, release });
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
        expect(active).toBe(0);
        expect(transcripts.load(sessionId)).toEqual(before);
        expect(send).not.toHaveBeenCalled();
        await Effect.runPromise(Fiber.await(start));
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
      expect(active).toBe(0);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("does not acknowledge a steering note that cancellation prevents from reaching the model", async () => {
    const scripted = scriptedTransport([
      {
        text: "Reading",
        toolCalls: [{ toolCallId: "read-1", toolName: "read", argumentsJson: "{}" }],
      },
    ]);
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(scripted.transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan", tools });
          yield* sendAndCollect(connection, "Review", (event) => event.kind === "tool-request");
          const note = yield* Effect.fork(
            connection.steer?.({ sessionId, message: "Check the parser" }) ??
              Effect.succeed("unsupported"),
          );
          yield* Effect.yieldNow();
          yield* connection.stop(sessionId);
          expect(yield* Fiber.join(note)).toBe("unsupported");
          expect(
            transcripts
              .load(sessionId)
              ?.messages.some((message) => message.text === "Check the parser"),
          ).toBe(false);
          expect(scripted.requests).toHaveLength(1);
        }),
      ),
    );
  });

  it("continues with a note received during the final response before completing the turn", async () => {
    let finish: ((response: NativeHarnessResponse) => void) | undefined;
    const requests: NativeHarnessRequest[] = [];
    const transport: NativeHarnessTransport = {
      open: async () => ({
        fits: () => true,
        send: async (request) => {
          requests.push(request);
          if (requests.length === 1)
            return await new Promise<NativeHarnessResponse>((resolve) => {
              finish = resolve;
            });
          return { text: "Rechecked", toolCalls: [] };
        },
        release: () => undefined,
      }),
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan", tools });
          const terminal = yield* Effect.fork(
            Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
          );
          yield* connection.send({ sessionId, prompt: "Review", attachments: [], tools });
          const note = yield* Effect.fork(
            connection.steer?.({ sessionId, message: "Recheck the parser" }) ??
              Effect.succeed("unsupported"),
          );
          yield* Effect.yieldNow();
          expect(finish).toBeDefined();
          finish?.({ text: "Initial review", toolCalls: [] });
          expect(yield* Fiber.join(note)).toBe("steered");
          expect(Array.from(yield* Fiber.join(terminal)).at(-1)?.kind).toBe("completed");
          expect(requests).toHaveLength(2);
          expect(requests[1]?.history.slice(-2)).toEqual([
            { role: "assistant", text: "Initial review" },
            { role: "user", text: "Recheck the parser" },
          ]);
        }),
      ),
    );
  });

  it("delivers steering after pending tool results and records it before acknowledging the note", async () => {
    const scripted = scriptedTransport([
      {
        text: "Reading",
        toolCalls: [{ toolCallId: "read-1", toolName: "read", argumentsJson: "{}" }],
      },
      { text: "Used SQLite", toolCalls: [] },
    ]);
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(scripted.transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan", tools });
          yield* sendAndCollect(
            connection,
            "Choose a database",
            (event) => event.kind === "tool-request",
          );
          const terminal = yield* Effect.fork(
            Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
          );
          const note = yield* Effect.fork(
            connection.steer?.({ sessionId, message: "Use SQLite" }) ??
              Effect.succeed("unsupported"),
          );
          yield* Effect.yieldNow();
          yield* connection.answerTool({
            sessionId,
            requestId: "read-1",
            resultJson: "{}",
            isError: false,
          });
          expect(yield* Fiber.join(note)).toBe("steered");
          expect(Array.from(yield* Fiber.join(terminal)).at(-1)?.kind).toBe("completed");
          const history = scripted.requests[1]?.history;
          expect(history?.at(-1)).toMatchObject({ role: "user", text: "Use SQLite" });
          expect(history?.at(-2)?.toolResults?.[0]?.toolCallId).toBe("read-1");
          expect(
            transcripts
              .load(sessionId)
              ?.messages.some(
                (message) => message.role === "user" && message.text === "Use SQLite",
              ),
          ).toBe(true);
        }),
      ),
    );
  });

  it("acknowledges and journals only queued steering notes retained in the fitted provider request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-harness-steering-limit-"));
    directories.push(directory);
    const messages = ["Earlier note: " + "a".repeat(400), "Later note: " + "b".repeat(400)];
    const scripted = scriptedTransport(
      [
        {
          text: "Reading",
          toolCalls: [{ toolCallId: "read-1", toolName: "read", argumentsJson: "{}" }],
        },
        { text: "Applied the delivered note", toolCalls: [] },
      ],
      (request) => JSON.stringify(request.history).length <= 800,
    );
    let identity = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const transcripts = new JournalNativeHarnessTranscriptStore({
            journal: persistence.journal,
            uuid: () => `80000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`,
            clock: () => now,
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          });
          const connection = yield* connect(scripted.transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan", tools });
          yield* sendAndCollect(connection, "Review", (event) => event.kind === "tool-request");
          const terminal = yield* Effect.fork(
            Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
          );
          const notes = [];
          for (const message of messages) {
            notes.push(
              yield* Effect.fork(
                connection.steer?.({ sessionId, message }) ?? Effect.succeed("unsupported"),
              ),
            );
            yield* Effect.yieldNow();
          }
          yield* connection.answerTool({
            sessionId,
            requestId: "read-1",
            resultJson: "{}",
            isError: false,
          });
          const outcomes = [];
          for (const note of notes) outcomes.push(yield* Fiber.join(note));
          yield* Fiber.join(terminal);
          const received = scripted.requests[1]?.history.filter((message) =>
            messages.includes(message.text),
          );
          const recorded = transcripts
            .load(sessionId)
            ?.messages.filter((message) => messages.includes(message.text));
          expect(received).toEqual([{ role: "user", text: messages[1] }]);
          expect(outcomes).toEqual(["unsupported", "steered"]);
          expect(recorded).toEqual(received);
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );
  });

  it("resumes after a restart mid-step and tells the model which interrupted calls only read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-harness-loop-"));
    directories.push(directory);
    let identity = 0;
    const uuid = () => `80000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`;
    const withJournal = <A, E>(
      body: (transcripts: NativeHarnessTranscriptStore) => Effect.Effect<A, E, Scope.Scope>,
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            return yield* body(
              new JournalNativeHarnessTranscriptStore({
                journal: persistence.journal,
                uuid,
                clock: () => now,
                actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
              }),
            );
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );
    const first = scriptedTransport([
      {
        text: "",
        toolCalls: [
          { toolCallId: "call-read", toolName: "read", argumentsJson: '{"path":"a.ts"}' },
          { toolCallId: "call-bash", toolName: "bash", argumentsJson: '{"command":"make"}' },
          { toolCallId: "call-grep", toolName: "grep", argumentsJson: '{"pattern":"x"}' },
        ],
      },
    ]);
    const cursor = await withJournal((transcripts) =>
      Effect.gen(function* () {
        const connection = yield* connect(first.transport, transcripts);
        const handle = yield* connection.start({
          sessionId,
          modelId,
          executionPolicy: "approval-gated",
        });
        yield* sendAndCollect(
          connection,
          "fix the build",
          (event) => event.kind === "tool-request" && event.requestId === "call-grep",
        );
        yield* connection.answerTool({
          sessionId,
          requestId: "call-read",
          resultJson: '{"text":"export {}"}',
          isError: false,
        });
        // The process stops here: bash and grep never settle.
        return handle.resumeCursor as ProviderResumeCursor;
      }),
    );

    const second = scriptedTransport([{ text: "Checked the build state first.", toolCalls: [] }]);
    const events = await withJournal((transcripts) =>
      Effect.gen(function* () {
        const connection = yield* connect(second.transport, transcripts);
        yield* connection.resume({
          sessionId,
          resumeCursor: cursor,
          executionPolicy: "approval-gated",
        });
        return yield* sendAndCollect(connection, "carry on", isTerminal);
      }),
    );

    expect(events.at(-1)?.kind).toBe("completed");
    const history = second.requests[0]?.history ?? [];
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
    const results = history[2]?.toolResults ?? [];
    expect(results.map((result) => result.toolCallId)).toEqual([
      "call-read",
      "call-bash",
      "call-grep",
    ]);
    expect(results[0]).toMatchObject({ resultJson: '{"text":"export {}"}', isError: false });
    expect(JSON.parse(results[1]?.resultJson ?? "{}")).toMatchObject({
      interrupted: true,
      replay: "unsafe",
    });
    expect(JSON.parse(results[2]?.resultJson ?? "{}")).toMatchObject({
      interrupted: true,
      replay: "safe",
    });
  });

  it("returns a step's results in the order the model asked for them, not the order they settled", async () => {
    const { transport, requests } = scriptedTransport([
      {
        text: "",
        toolCalls: [
          { toolCallId: "first", toolName: "read", argumentsJson: "{}" },
          { toolCallId: "second", toolName: "grep", argumentsJson: "{}" },
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* sendAndCollect(
            connection,
            "look",
            (event) => event.kind === "tool-request" && event.requestId === "second",
          );
          const finished = yield* Effect.fork(
            Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
          );
          for (const requestId of ["second", "first"]) {
            yield* connection.answerTool({
              sessionId,
              requestId,
              resultJson: "{}",
              isError: false,
            });
          }
          yield* Fiber.join(finished);
        }),
      ),
    );
    const continuation = requests[1]?.history.at(-1)?.toolResults ?? [];
    expect(continuation.map((result) => result.toolCallId)).toEqual(["first", "second"]);
  });

  it("continues a later turn from the conversation an earlier connection started", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const { transport, requests } = scriptedTransport([
      { text: "first answer", toolCalls: [] },
      { text: "second answer", toolCalls: [] },
    ]);
    const cursor = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = yield* sendAndCollect(connection, "first", isTerminal);
          const completed = events.at(-1);
          return completed?.kind === "completed" ? completed.resumeCursor : undefined;
        }),
      ),
    );
    expect(cursor).toEqual({ driverKind: "openai-compatible", value: String(sessionId) });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.resume({
            sessionId,
            resumeCursor: cursor as ProviderResumeCursor,
            executionPolicy: "approval-gated",
          });
          yield* sendAndCollect(connection, "second", isTerminal);
        }),
      ),
    );
    expect(requests[1]?.history.map((message) => message.text)).toEqual([
      "first",
      "first answer",
      "second",
    ]);
  });

  it("sends instructions as the system prompt and names the Octant tools on offer", async () => {
    const { transport, requests } = scriptedTransport([{ text: "ok", toolCalls: [] }]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const events = yield* Effect.fork(
            Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
          );
          yield* connection.send({
            sessionId,
            prompt: "hello",
            context: [{ kind: "instructions", text: "Be brief." }],
            attachments: [],
            tools: [tool("read"), tool("octant_browser")],
          });
          yield* Fiber.join(events);
        }),
      ),
    );
    expect(requests[0]?.system).toContain("Be brief.");
    expect(requests[0]?.system).toContain("octant_browser:");
    expect(requests[0]?.history).toEqual([{ role: "user", text: "hello" }]);
  });
});

/** An endpoint that is down: its retries run out on every request. */
function downEndpoint(category: "unavailable" | "unauthenticated" = "unavailable"): {
  readonly session: NativeHarnessTransportSession;
  readonly requests: NativeHarnessRequest[];
} {
  const requests: NativeHarnessRequest[] = [];
  return {
    requests,
    session: {
      fits: () => true,
      release: () => undefined,
      send: (request, stream) => {
        requests.push(request);
        return sendWithEndpointRetry({
          signal: stream.signal,
          onEvent: stream.onEvent,
          options: { sleep: async () => undefined, random: () => 0.5 },
          attempt: async () => {
            throw { category, message: "The provider request failed with HTTP 503." };
          },
        });
      },
    },
  };
}

function answeringEndpoint(text: string): {
  readonly session: NativeHarnessTransportSession;
  readonly requests: NativeHarnessRequest[];
  readonly released: () => boolean;
} {
  const requests: NativeHarnessRequest[] = [];
  let released = false;
  return {
    requests,
    released: () => released,
    session: {
      fits: () => true,
      release: () => {
        released = true;
      },
      send: async (request) => {
        requests.push(request);
        return { text, toolCalls: [] };
      },
    },
  };
}

const backupTarget = {
  providerInstanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000904"),
  modelId: "backup-model" as ProviderModelId,
};

describe("a lead whose model keeps failing", () => {
  const run = (
    primary: NativeHarnessTransportSession,
    leadFallback: NativeHarnessLeadFallback | undefined,
    turns = 1,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(
            { open: async () => primary },
            new MemoryNativeHarnessTranscriptStore(),
            leadFallback,
          );
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const turnEvents: ProviderRuntimeEvent[][] = [];
          for (let turn = 0; turn < turns; turn += 1) {
            turnEvents.push(yield* sendAndCollect(connection, `turn ${turn}`, isTerminal));
          }
          return turnEvents;
        }),
      ),
    );

  it("continues the turn on the next model once the endpoint's retries have run out", async () => {
    const down = downEndpoint();
    const backup = answeringEndpoint("from the backup");
    const asked: Array<Parameters<NativeHarnessLeadFallback["next"]>[0]> = [];

    const [first, second] = await run(
      down.session,
      {
        next: async (input) => {
          asked.push(input);
          return { status: "switched", target: backupTarget, endpoint: backup.session };
        },
      },
      2,
    );

    expect(first?.map((event) => event.kind)).toEqual([
      "retrying",
      "retrying",
      "retrying",
      "retrying",
      "completed",
    ]);
    expect(backup.requests[0]?.modelId).toBe("backup-model");
    expect(backup.requests[0]?.history).toEqual([{ role: "user", text: "turn 0" }]);
    expect(asked[0]).toMatchObject({
      failed: { providerInstanceId: instanceId, modelId },
      attempted: [{ providerInstanceId: instanceId, modelId }],
      failure: { category: "unavailable" },
    });
    // The next turn starts on the lead's own model again, and the backup is released.
    expect(second?.at(-1)?.kind).toBe("completed");
    expect(down.requests.map((request) => request.modelId)).toEqual([modelId, modelId]);
    expect(backup.released()).toBe(true);
  });

  it("fails with the endpoint's own failure and says why when no other model is configured", async () => {
    const down = downEndpoint();
    const [events] = await run(down.session, {
      next: async () => ({ status: "none", reason: "slot-empty" }),
    });

    expect(events?.at(-1)).toMatchObject({
      kind: "failed",
      failure: {
        category: "unavailable",
        message: "The provider request failed with HTTP 503. No fallback model is configured.",
      },
    });
  });

  it("fails the way it always did when nothing is configured to fall back with", async () => {
    const [events] = await run(downEndpoint().session, undefined);

    expect(events?.at(-1)).toMatchObject({
      kind: "failed",
      failure: { category: "unavailable", message: "The provider request failed with HTTP 503." },
    });
  });

  it("does not look for another model after a failure that was never retried", async () => {
    let asked = 0;
    const [events] = await run(downEndpoint("unauthenticated").session, {
      next: async () => {
        asked += 1;
        return { status: "none", reason: "slot-empty" };
      },
    });

    expect(asked).toBe(0);
    expect(events?.at(-1)).toMatchObject({
      kind: "failed",
      failure: { category: "unauthenticated" },
    });
  });

  it("asks again when the fallback model is down too, naming every model it already tried", async () => {
    const down = downEndpoint();
    const alsoDown = downEndpoint();
    const asked: Array<Parameters<NativeHarnessLeadFallback["next"]>[0]> = [];
    const [events] = await run(down.session, {
      next: async (input) => {
        asked.push(input);
        return asked.length === 1
          ? { status: "switched", target: backupTarget, endpoint: alsoDown.session }
          : { status: "none", reason: "no-other-model" };
      },
    });

    expect(asked[1]?.attempted).toEqual([
      { providerInstanceId: instanceId, modelId },
      backupTarget,
    ]);
    expect(events?.at(-1)).toMatchObject({
      kind: "failed",
      failure: { message: expect.stringContaining("No other model is configured to continue on.") },
    });
  });
});

describe("fitting a request to the endpoint", () => {
  const base: NativeHarnessRequest = {
    sessionId,
    modelId,
    system: undefined,
    tools: [],
    history: [
      { role: "user", text: "old question" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ toolCallId: "old", toolName: "read", argumentsJson: "{}" }],
      },
      {
        role: "assistant",
        text: "",
        toolResults: [
          { toolCallId: "old", resultJson: JSON.stringify("x".repeat(500)), isError: false },
        ],
      },
      { role: "assistant", text: "old answer" },
      { role: "user", text: "new question" },
    ],
  };
  const fitsUnder = (bytes: number) => ({
    fits: (request: NativeHarnessRequest) => JSON.stringify(request.history).length <= bytes,
  });

  it("drops older tool results before it leaves out whole exchanges", () => {
    const fitted = fitRequest(fitsUnder(500), base);
    expect(fitted?.history.map((message) => message.text)).toEqual(
      base.history.map((message) => message.text),
    );
    expect(fitted?.history[2]?.toolResults?.[0]?.resultJson).toContain('"omitted":true');
  });

  it("leaves out earlier exchanges behind a note when dropping results is not enough", () => {
    const fitted = fitRequest(fitsUnder(260), base);
    expect(fitted?.history.at(-1)).toEqual({ role: "user", text: "new question" });
    expect(fitted?.history[0]?.text).toContain("left out to fit the context window");
    expect(fitted?.history.some((message) => message.text === "old question")).toBe(false);
  });

  it("refuses rather than cut the latest message", () => {
    expect(fitRequest(fitsUnder(10), base)).toBeUndefined();
  });

  it("cuts further when forced on a request that already left earlier messages out", () => {
    const acceptsAll = { fits: () => true };
    const reduced = fitRequest(fitsUnder(260), base);
    expect(reduced).toBeDefined();
    if (reduced === undefined) return;
    const withMore: NativeHarnessRequest = {
      ...reduced,
      history: [
        ...reduced.history,
        { role: "assistant", text: "another answer" },
        { role: "user", text: "newest question" },
      ],
    };

    const forced = fitRequest(acceptsAll, withMore, { reduceOnce: true });

    expect(forced?.history).not.toEqual(withMore.history);
    expect(forced?.history.at(-1)).toEqual({ role: "user", text: "newest question" });
    expect(forced?.history.some((message) => message.text === "new question")).toBe(false);
    expect(
      fitRequest(acceptsAll, forced ?? withMore, { reduceOnce: true }),
      "nothing is left to leave out",
    ).toBeUndefined();
  });

  it("names the journaled messages a cut left out, and journal-lookup reads one back", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const { transport, requests } = scriptedTransport(
      [
        { text: "first answer", toolCalls: [] },
        { text: "second answer", toolCalls: [] },
      ],
      // No summary request fits either, so the turn cannot compact and the ladder cuts.
      (request) => request.tools.length > 0 && JSON.stringify(request.history).length <= 700,
    );
    const firstPrompt = `first question ${"a".repeat(620)}`;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* sendAndCollect(connection, firstPrompt, isTerminal, [], withLookup);
          yield* sendAndCollect(connection, "second question", isTerminal, [], withLookup);
        }),
      ),
    );

    const note = requests[1]?.history[0]?.text ?? "";
    expect(requests[1]?.history.map((message) => message.text).slice(1)).toEqual([
      "second question",
    ]);
    expect(note).toContain("Messages 0 to 1 are kept in the journal");
    const lookup = createCodeJournalLookup({
      transcripts,
      latestSession: () => ({
        providerInstanceId: instanceId,
        resumeCursor: { driverKind: "openai-compatible", value: String(sessionId) },
      }),
      providerInstanceId: instanceId,
      secrets: [],
    });
    expect(lookup({ from: 0, count: 2 })).toMatchObject({
      status: "found",
      messages: [
        { number: 0, role: "user", text: firstPrompt },
        { number: 1, role: "assistant", text: "first answer" },
      ],
    });
  });

  it("names no message numbers when the lead is not offered journal-lookup", () => {
    const fitted = fitRequest(fitsUnder(260), base, { journalNumberOf: () => 4 });
    expect(fitted?.history[0]?.text).toContain("left out to fit the context window");
    expect(fitted?.history[0]?.text).not.toContain("journal-lookup");
  });

  describe("usage across the requests of one turn", () => {
    /** Runs a turn of two requests, the first calling a tool, and returns every event it produced. */
    const twoRequestTurn = (
      first: NativeHarnessResponse["usage"],
      second: NativeHarnessResponse["usage"],
      selectedModel = modelId,
      retried = false,
    ) => {
      const { transport } = scriptedTransport(
        [
          {
            text: "",
            toolCalls: [{ toolCallId: "call", toolName: "read", argumentsJson: "{}" }],
            ...(first === undefined ? {} : { usage: first }),
          },
          { text: "done", toolCalls: [], ...(second === undefined ? {} : { usage: second }) },
        ],
        () => true,
        retried,
      );
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
            yield* connection.start({
              sessionId,
              modelId: selectedModel,
              executionPolicy: "approval-gated",
            });
            yield* sendAndCollect(connection, "look", (event) => event.kind === "tool-request");
            const finished = yield* Effect.fork(
              Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
            );
            yield* connection.answerTool({
              sessionId,
              requestId: "call",
              resultJson: "{}",
              isError: false,
            });
            return Array.from(yield* Fiber.join(finished));
          }),
        ),
      );
    };

    it("prices two short requests without charging the long-context rate on their sum", async () => {
      const model = "gpt-5.6-luna" as ProviderModelId;
      const events = await twoRequestTurn(
        {
          inputTokens: 148099,
          outputTokens: 165,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        { inputTokens: 159911, outputTokens: 6, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
        model,
      );
      const usage = events.find((event) => event.kind === "usage");
      expect(usage).toMatchObject({ inputTokens: 308010, outputTokens: 171 });
      if (usage?.kind !== "usage") throw new Error("Expected usage");
      expect(ledgerUsageCost(model, usage)).toEqual({ kind: "api-estimate", usdMicros: 61807 });
      expect(usage).not.toHaveProperty("costUsd");
    });

    it("keeps a genuinely long request at its own rate", async () => {
      const model = "gpt-5.6-luna" as ProviderModelId;
      const events = await twoRequestTurn(
        { inputTokens: 300_000, outputTokens: 100 },
        { inputTokens: 100, outputTokens: 10 },
        model,
      );
      const usage = events.find((event) => event.kind === "usage");
      if (usage?.kind !== "usage") throw new Error("Expected usage");
      expect(ledgerUsageCost(model, usage)).toEqual({ kind: "api-estimate", usdMicros: 120212 });
    });

    it("keeps an incomplete or unpriced request sum unavailable", async () => {
      for (const [first, model] of [
        [undefined, "gpt-5.6-luna"],
        [{ inputTokens: 100, outputTokens: 10 }, "unpriced-model"],
      ] as const) {
        const events = await twoRequestTurn(
          first,
          { inputTokens: 100, outputTokens: 10 },
          model as ProviderModelId,
        );
        const usage = events.find((event) => event.kind === "usage");
        expect(usage).toMatchObject({ estimatedCostUsd: null });
        if (usage?.kind !== "usage") throw new Error("Expected usage");
        expect(ledgerUsageCost(model, usage)).toBeUndefined();
      }
    });

    it("does not estimate a retried request from its combined attempt usage", async () => {
      const model = "gpt-5.6-luna" as ProviderModelId;
      const events = await twoRequestTurn(
        { inputTokens: 300_000, outputTokens: 100 },
        { inputTokens: 100, outputTokens: 10 },
        model,
        true,
      );
      const usage = events.find((event) => event.kind === "usage");
      expect(usage).toMatchObject({
        inputTokens: 300100,
        outputTokens: 110,
        estimatedCostUsd: null,
      });
      if (usage?.kind !== "usage") throw new Error("Expected usage");
      expect(ledgerUsageCost(model, usage)).toBeUndefined();
    });

    it.each([
      { retried: true, cancelled: false, journalFails: false },
      { retried: true, cancelled: true, journalFails: false },
      { retried: false, cancelled: false, journalFails: false },
      { retried: false, cancelled: false, journalFails: true },
    ])(
      "preserves known pricing once after failure with retried=$retried, cancelled=$cancelled, journalFails=$journalFails",
      async ({ retried, cancelled, journalFails }) => {
        const model = "gpt-5.6-luna" as ProviderModelId;
        const transport: NativeHarnessTransport = {
          open: async () => ({
            fits: () => true,
            send: async (_request, stream) => {
              stream.onEvent({
                kind: "usage",
                inputTokens: 148099,
                outputTokens: 165,
                cacheReadInputTokens: 0,
                reasoningTokens: 5,
              });
              if (retried)
                stream.onEvent({
                  kind: "retrying",
                  attempt: 2,
                  maxAttempts: 5,
                  delayMs: 500,
                  reason: "empty-completion",
                });
              if (journalFails)
                return {
                  text: "done",
                  toolCalls: [],
                  usage: {
                    inputTokens: 148099,
                    outputTokens: 165,
                    cacheReadInputTokens: 0,
                    reasoningTokens: 5,
                  },
                };
              throw {
                category: cancelled ? "interrupted" : "unavailable",
                message: "Request stopped.",
              };
            },
            release: () => undefined,
          }),
        };
        const events = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const transcripts = new MemoryNativeHarnessTranscriptStore();
              if (journalFails) {
                const append = transcripts.append.bind(transcripts);
                let appended = 0;
                transcripts.append = (...args) => {
                  appended += 1;
                  if (appended === 2) throw new Error("Synthetic transcript failure after usage");
                  return append(...args);
                };
              }
              const connection = yield* connect(transport, transcripts);
              yield* connection.start({
                sessionId,
                modelId: model,
                executionPolicy: "approval-gated",
              });
              return yield* sendAndCollect(connection, "look", isTerminal);
            }),
          ),
        );
        expect(events.at(-1)?.kind).toBe(cancelled ? "interrupted" : "failed");
        const { usage } = deriveTurnMetrics({ startedAt: now, endedAt: now, events });
        expect(usage).toEqual({
          inputTokens: 148099,
          outputTokens: 165,
          cacheReadInputTokens: 0,
          reasoningTokens: 5,
          estimatedCostUsd: retried ? null : expect.closeTo(0.0298178, 12),
        });
        expect(ledgerUsageCost(model, usage ?? { inputTokens: 0, outputTokens: 0 })).toEqual(
          retried ? undefined : { kind: "api-estimate", usdMicros: 29818 },
        );
      },
    );

    it("reports the turn's cache and reasoning tokens once, summed over its requests", async () => {
      const events = await twoRequestTurn(
        { inputTokens: 100, outputTokens: 10, cacheWriteInputTokens: 60, cacheReadInputTokens: 0 },
        { inputTokens: 160, outputTokens: 5, cacheReadInputTokens: 60, reasoningTokens: 3 },
      );

      const usage = events.filter((event) => event.kind === "usage");
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        inputTokens: 260,
        outputTokens: 15,
        cacheReadInputTokens: 60,
        cacheWriteInputTokens: 60,
        reasoningTokens: 3,
      });

      // The same event is what the usage dashboard reads for cache coverage.
      const observation = usageFromRuntimeEvent(usage[0] as ProviderRuntimeEvent);
      const dashboard = buildUsageDashboard(
        [
          {
            reconciliationId: "harness-turn",
            hostId: "local",
            providerInstanceId: String(instanceId),
            modelId: String(modelId),
            requestShape: "code-turn",
            subjectType: "code-thread",
            subjectId: "thread",
            quality: "exact",
            inputTokens: observation?.inputTokens ?? 0,
            outputTokens: observation?.outputTokens ?? 0,
            ...(observation?.cacheReadInputTokens === undefined
              ? {}
              : { cacheReadInputTokens: observation.cacheReadInputTokens }),
            ...(observation?.cacheWriteInputTokens === undefined
              ? {}
              : { cacheWriteInputTokens: observation.cacheWriteInputTokens }),
            attribution: [],
            observedAt: now,
          },
        ],
        { queryAt: now, timeZone: "UTC", detailLimit: 10, breakdownLimit: 10 },
      );
      expect(dashboard.cacheStats.providerTokenCaches).toEqual([
        {
          providerInstanceId: String(instanceId),
          requestCount: 1,
          cacheReadInputTokens: 60,
          cacheWriteInputTokens: 60,
          hitRatio: 0.5,
        },
      ]);
    });

    it("leaves a figure out of the turn's usage when no request reported it", async () => {
      const events = await twoRequestTurn(
        { inputTokens: 100, outputTokens: 10 },
        { inputTokens: 160, outputTokens: 5 },
      );

      const usage = events.find((event) => event.kind === "usage");
      expect(usage).toMatchObject({ inputTokens: 260, outputTokens: 15 });
      expect(usage).not.toHaveProperty("cacheReadInputTokens");
      expect(usage).not.toHaveProperty("cacheWriteInputTokens");
      expect(usage).not.toHaveProperty("reasoningTokens");
      expect(usage).not.toHaveProperty("costUsd");
    });

    it("reports the turn's cost only when every request reported one", async () => {
      const whole = await twoRequestTurn(
        { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
        { inputTokens: 160, outputTokens: 5, costUsd: 0.02 },
      );
      const priced = whole.find((event) => event.kind === "usage");
      expect(priced?.kind === "usage" ? priced.costUsd : undefined).toBeCloseTo(0.03, 10);

      const partial = await twoRequestTurn(
        { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
        { inputTokens: 160, outputTokens: 5 },
      );
      expect(partial.find((event) => event.kind === "usage")).not.toHaveProperty("costUsd");
    });
  });

  describe("timing across the requests of one turn", () => {
    const epoch = Date.parse("2026-10-06T12:00:00.000Z");

    it("times each request on its own and leaves the tool's time out of the decode window", async () => {
      let elapsedMs = 0;
      const at = (ms: number) => new Date(epoch + ms).toISOString();
      const requests: NativeHarnessRequest[] = [];
      const transport: NativeHarnessTransport = {
        open: async () => ({
          fits: () => true,
          send: async (request, stream) => {
            requests.push(request);
            if (requests.length === 1) {
              // Sent at 0s: first token at 1s, finished at 5s.
              elapsedMs = 1_000;
              stream.onEvent({ kind: "text-delta", text: "Looking" });
              elapsedMs = 5_000;
              const usage = { inputTokens: 100, outputTokens: 80, cacheReadInputTokens: 60 };
              stream.onEvent({ kind: "usage", ...usage });
              return {
                text: "Looking",
                toolCalls: [{ toolCallId: "call", toolName: "read", argumentsJson: "{}" }],
                usage,
              };
            }
            // Sent at 15s, after ten seconds in the tool: first token at 17s, finished at 19s.
            elapsedMs = 17_000;
            stream.onEvent({ kind: "text-delta", text: "Done" });
            elapsedMs = 19_000;
            const usage = { inputTokens: 160, outputTokens: 60, cacheReadInputTokens: 140 };
            stream.onEvent({ kind: "usage", ...usage });
            return { text: "Done", toolCalls: [], usage };
          },
          release: () => undefined,
        }),
      };

      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* createNativeHarnessConnection({
              instanceId,
              driverKind: "openai-compatible",
              projectRoot,
              mode: "code",
              transport,
              transcripts: new MemoryNativeHarnessTranscriptStore(),
              admitTurn: () => undefined,
              clock: () => at(elapsedMs),
              correlationId: () => "80000000-0000-4000-8000-000000000903",
            });
            yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
            const first = yield* sendAndCollect(
              connection,
              "look",
              (event) => event.kind === "tool-request",
            );
            const finished = yield* Effect.fork(
              Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
            );
            elapsedMs = 15_000;
            yield* connection.answerTool({
              sessionId,
              requestId: "call",
              resultJson: "{}",
              isError: false,
            });
            return [...first, ...Array.from(yield* Fiber.join(finished))];
          }),
        ),
      );

      const requestScoped = events.filter(
        (event) => event.kind === "usage" && event.requestStartedAt !== undefined,
      );
      expect(
        requestScoped.map((event) => event.kind === "usage" && event.requestStartedAt),
      ).toEqual([at(0), at(15_000)]);
      const { metrics, usage } = deriveTurnMetrics({
        startedAt: at(0),
        endedAt: at(19_000),
        events,
      });
      expect(metrics).toEqual({
        precision: "exact",
        wallMs: 19_000,
        timeToFirstTokenMs: 1_000,
        decodeOutputTokens: 140,
        decodeMs: 6_000,
        toolMs: 10_000,
        modelCalls: 2,
      });
      expect(usage).toEqual({
        inputTokens: 260,
        outputTokens: 140,
        cacheReadInputTokens: 200,
        estimatedCostUsd: null,
      });
    });
  });
});

/** An endpoint whose `fits` always passes, so only the endpoint itself can refuse a size. */
/**
 * An endpoint whose own size estimate is `fits`, recording every request it
 * is sent. The estimate accepting a request does not stop `send` refusing it.
 */
function endpointWithSizeEstimate(
  send: (request: NativeHarnessRequest) => Promise<NativeHarnessResponse>,
  fits: (request: NativeHarnessRequest) => boolean = () => true,
): { readonly transport: NativeHarnessTransport; readonly requests: NativeHarnessRequest[] } {
  const requests: NativeHarnessRequest[] = [];
  return {
    requests,
    transport: {
      open: async () => ({
        fits,
        send: async (request) => {
          requests.push(request);
          return await send(request);
        },
        release: () => undefined,
      }),
    },
  };
}

/** Waits until the loop has emitted the tool request, so an answer lands on a live step. */
async function whenRequested(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  requestId: string,
): Promise<void> {
  while (!events.some((event) => event.kind === "tool-request" && event.requestId === requestId)) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The first tool call not yet answered, or undefined once the turn ended. */
async function nextUnanswered(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  answered: ReadonlySet<string>,
): Promise<string | undefined> {
  for (;;) {
    for (const event of events) {
      if (event.kind === "tool-request" && !answered.has(event.requestId)) return event.requestId;
    }
    if (events.some(isTerminal)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("recovering from a request the endpoint refuses as too large", () => {
  const overflow: ProviderFailure = {
    category: "provider-failed",
    message:
      "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (context_length_exceeded).",
  };
  const callTool = (toolCallId: string, toolName: string): NativeHarnessResponse => ({
    text: "",
    toolCalls: [{ toolCallId, toolName, argumentsJson: "{}" }],
  });

  /** Runs one turn, answering each tool request in order, and returns every event. */
  const runTurn = async (
    transport: NativeHarnessTransport,
    answers: ReadonlyArray<readonly [requestId: string, resultJson: string]>,
  ): Promise<ReadonlyArray<ProviderRuntimeEvent>> => {
    const events: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            Stream.runForEach(
              (yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal)),
              (event) => Effect.sync(() => events.push(event)),
            ),
          );
          yield* connection.send({ sessionId, prompt: "look", attachments: [], tools });
          for (const [requestId, resultJson] of answers) {
            yield* Effect.promise(() => whenRequested(events, requestId));
            yield* connection.answerTool({ sessionId, requestId, resultJson, isError: false });
          }
          yield* Fiber.join(collected);
        }),
      ),
    );
    return events;
  };

  it("forces one more reduction and completes after a single overflow retry", async () => {
    const calls: string[] = [];
    const scripted = endpointWithSizeEstimate(async () => {
      calls.push("call");
      if (calls.length === 1) return callTool("a", "read");
      if (calls.length === 2) return callTool("b", "grep");
      if (calls.length === 3) throw overflow;
      return { text: "recovered", toolCalls: [] };
    });

    const events = await runTurn(scripted.transport, [
      ["a", "{}"],
      ["b", "{}"],
    ]);

    expect(events.at(-1)?.kind).toBe("completed");
    expect(scripted.requests).toHaveLength(4);
    const retried = scripted.requests[3]?.history ?? [];
    expect(
      retried.some((message) =>
        message.toolResults?.some((result) => result.resultJson.includes('"omitted":true')),
      ),
    ).toBe(true);
  });

  it("shrinks a request it had already reduced before the endpoint refused it", async () => {
    const first = "a".repeat(2_000);
    const second = "b".repeat(1_000);
    const calls: string[] = [];
    const scripted = endpointWithSizeEstimate(
      async (request) => {
        calls.push("call");
        if (calls.length === 1) return callTool("a", "read");
        if (calls.length === 2) return callTool("b", "grep");
        if (calls.length === 3) return callTool("c", "read");
        // The real window is smaller than the estimate: it refuses any request
        // that still carries the second result.
        if (JSON.stringify(request.history).includes(second)) throw overflow;
        return { text: "recovered", toolCalls: [] };
      },
      // The estimate only rejects the fourth request while it carries the first result.
      (request) => request.history.length < 7 || !JSON.stringify(request.history).includes(first),
    );

    const events = await runTurn(scripted.transport, [
      ["a", JSON.stringify(first)],
      ["b", JSON.stringify(second)],
      ["c", "{}"],
    ]);

    expect(events.at(-1)?.kind).toBe("completed");
    expect(scripted.requests).toHaveLength(5);
    const refused = scripted.requests[3];
    const retried = scripted.requests[4];
    expect(JSON.stringify(refused?.history)).not.toContain(first);
    expect(retried?.history).not.toEqual(refused?.history);
    expect(JSON.stringify(retried?.history)).not.toContain(second);
  });
});

describe("recovering from a malformed tool call", () => {
  const runWithBadArguments = async () => {
    const scripted = scriptedTransport([
      {
        text: "mis-firing",
        toolCalls: [{ toolCallId: "bad", toolName: "read", argumentsJson: "{not json" }],
      },
      {
        text: "",
        toolCalls: [{ toolCallId: "good", toolName: "read", argumentsJson: '{"path":"a.ts"}' }],
      },
      { text: "recovered", toolCalls: [] },
    ]);
    const events: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(
            scripted.transport,
            new MemoryNativeHarnessTranscriptStore(),
          );
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const collected = yield* Effect.fork(
            Stream.runForEach(
              (yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal)),
              (event) => Effect.sync(() => events.push(event)),
            ),
          );
          yield* connection.send({ sessionId, prompt: "look", attachments: [], tools });
          yield* Effect.promise(() => whenRequested(events, "good"));
          yield* connection.answerTool({
            sessionId,
            requestId: "good",
            resultJson: "{}",
            isError: false,
          });
          yield* Fiber.join(collected);
        }),
      ),
    );
    return { events, requests: scripted.requests };
  };

  it("answers a bad-arguments call with an error result and completes the model's next call", async () => {
    const { events, requests } = await runWithBadArguments();

    expect(events.at(-1)?.kind).toBe("completed");
    expect(
      events.flatMap((event) => (event.kind === "tool-request" ? [event.requestId] : [])),
    ).toEqual(["good"]);
    const errorResult = requests[1]?.history
      .flatMap((message) => message.toolResults ?? [])
      .find((result) => result.toolCallId === "bad");
    expect(errorResult?.isError).toBe(true);
    expect(JSON.parse(errorResult?.resultJson ?? "{}")).toMatchObject({
      error: "arguments were not valid JSON",
    });
  });

  it("fails the turn once a model will not stop returning malformed calls", async () => {
    const scripted = scriptedTransport(
      Array.from({ length: 6 }, () => ({
        text: "",
        toolCalls: [{ toolCallId: "bad", toolName: "read", argumentsJson: "{not json" }],
      })),
    );
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(
            scripted.transport,
            new MemoryNativeHarnessTranscriptStore(),
          );
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          return yield* sendAndCollect(connection, "look", isTerminal);
        }),
      ),
    );

    expect(events.at(-1)).toMatchObject({
      kind: "failed",
      failure: { category: "protocol" },
    });
  });

  it("answers the well-formed calls of the step that exhausts the correction cap as not run", async () => {
    const malformedStep = (id: string): NativeHarnessResponse => ({
      text: "",
      toolCalls: [{ toolCallId: id, toolName: "read", argumentsJson: "{not json" }],
    });
    const scripted = scriptedTransport([
      malformedStep("bad-1"),
      malformedStep("bad-2"),
      malformedStep("bad-3"),
      {
        text: "",
        toolCalls: [
          { toolCallId: "bad-4", toolName: "read", argumentsJson: "{not json" },
          { toolCallId: "good", toolName: "read", argumentsJson: '{"path":"a.ts"}' },
        ],
      },
      { text: "next answer", toolCalls: [] },
    ]);

    const [first, second] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(
            scripted.transport,
            new MemoryNativeHarnessTranscriptStore(),
          );
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const capped = yield* sendAndCollect(connection, "look", isTerminal);
          const next = yield* sendAndCollect(connection, "try again", isTerminal);
          return [capped, next] as const;
        }),
      ),
    );

    expect(first.at(-1)).toMatchObject({ kind: "failed", failure: { category: "protocol" } });
    expect(first.some((event) => event.kind === "tool-request")).toBe(false);
    expect(second.at(-1)?.kind).toBe("completed");
    const history = scripted.requests[4]?.history ?? [];
    const callsAt = history.findIndex((message) =>
      message.toolCalls?.some((call) => call.toolCallId === "good"),
    );
    const results = history[callsAt + 1]?.toolResults ?? [];
    expect(results.map((result) => result.toolCallId)).toEqual(["bad-4", "good"]);
    expect(results.every((result) => result.isError)).toBe(true);
    expect(JSON.parse(results[1]?.resultJson ?? "{}")).toMatchObject({ notRun: true });
  });

  it("resolves a queued steering note when malformed calls exhaust the correction cap", async () => {
    let releaseFourth: ((response: NativeHarnessResponse) => void) | undefined;
    let sent = 0;
    const malformed: NativeHarnessResponse = {
      text: "",
      toolCalls: [{ toolCallId: "bad", toolName: "read", argumentsJson: "{not json" }],
    };
    const transport: NativeHarnessTransport = {
      open: async () => ({
        fits: () => true,
        send: async () => {
          sent += 1;
          if (sent < 4) return malformed;
          return await new Promise<NativeHarnessResponse>((resolve) => {
            releaseFourth = resolve;
          });
        },
        release: () => undefined,
      }),
    };
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const terminal = yield* Effect.fork(
            Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
          );
          yield* connection.send({ sessionId, prompt: "look", attachments: [], tools });
          for (let spin = 0; releaseFourth === undefined && spin < 50; spin += 1) {
            yield* Effect.yieldNow();
          }
          const finish = releaseFourth;
          expect(finish).toBeTypeOf("function");
          const note = yield* Effect.fork(
            connection.steer?.({ sessionId, message: "try a different tool" }) ??
              Effect.succeed("unsupported" as const),
          );
          yield* Effect.yieldNow();
          finish?.(malformed);
          const steered = yield* Effect.race(
            Fiber.join(note),
            Effect.sleep("2 seconds").pipe(Effect.as("pending" as const)),
          );
          const events = Array.from(yield* Fiber.join(terminal));
          expect(events.at(-1)).toMatchObject({
            kind: "failed",
            failure: { category: "protocol" },
          });
          return steered;
        }),
      ),
    );

    expect(outcome).toBe("unsupported");
  });
});

describe("cancelling a turn without rebuilding the session", () => {
  it("accepts the next send on the same session after a cancel", async () => {
    const requests: NativeHarnessRequest[] = [];
    const transport: NativeHarnessTransport = {
      open: async () => ({
        fits: () => true,
        send: (request, stream) =>
          new Promise<NativeHarnessResponse>((resolve, reject) => {
            requests.push(request);
            if (requests.length > 1) {
              resolve({ text: "second", toolCalls: [] });
              return;
            }
            stream.signal.addEventListener(
              "abort",
              () =>
                reject({ category: "interrupted", message: "The provider request was cancelled." }),
              { once: true },
            );
          }),
        release: () => undefined,
      }),
    };
    const events: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const first = yield* Effect.fork(
            Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
          );
          yield* connection.send({ sessionId, prompt: "first", attachments: [], tools });
          yield* connection.interrupt(sessionId);
          expect(Array.from(yield* Fiber.join(first)).at(-1)?.kind).toBe("interrupted");

          // No resume: the same live session takes the next prompt straight away.
          const second = yield* sendAndCollect(connection, "second", isTerminal);
          for (const event of second) events.push(event);
        }),
      ),
    );

    expect(events.at(-1)?.kind).toBe("completed");
    expect(requests[1]?.history.map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("releases the session when an interrupted tool step cannot be journaled, so resume can retry the open step", async () => {
    const inner = new MemoryNativeHarnessTranscriptStore();
    let rejectSettle = true;
    const transcripts: NativeHarnessTranscriptStore = {
      open: (id, binding, forkedFrom) => inner.open(id, binding, forkedFrom),
      load: (id) => inner.load(id),
      append: (id, message) => inner.append(id, message),
      settle: (id, result) => {
        if (rejectSettle) throw new Error("journal append failed");
        inner.settle(id, result);
      },
      compact: (id, compaction) => inner.compact(id, compaction),
    };
    const scripted = scriptedTransport([
      {
        text: "",
        toolCalls: [{ toolCallId: "call-read", toolName: "read", argumentsJson: "{}" }],
      },
      { text: "continued", toolCalls: [] },
    ]);
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(scripted.transport, transcripts);
          const handle = yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          yield* sendAndCollect(connection, "look", (event) => event.kind === "tool-request");
          const interrupted = yield* Effect.exit(connection.interrupt(sessionId));
          expect(interrupted._tag).toBe("Failure");
          rejectSettle = false;
          const cursor = handle.resumeCursor;
          if (cursor === undefined) throw new Error("The session did not return a resume cursor.");
          yield* connection.resume({
            sessionId,
            resumeCursor: cursor,
            executionPolicy: "approval-gated",
          });
          return yield* sendAndCollect(connection, "carry on", isTerminal);
        }),
      ),
    );

    expect(events.at(-1)?.kind).toBe("completed");
    const results = scripted.requests[1]?.history.flatMap((message) => message.toolResults ?? []);
    expect(results?.map((result) => result.toolCallId)).toEqual(["call-read"]);
    expect(JSON.parse(results?.[0]?.resultJson ?? "{}")).toMatchObject({ interrupted: true });
  });
});

describe("compacting an Octant Harness session", () => {
  const compactionId = "80000000-0000-4000-8000-000000000904";
  const answers = (count: number): NativeHarnessResponse[] =>
    Array.from({ length: count }, (_, index) => ({ text: `answer ${index + 1}`, toolCalls: [] }));

  function compactOf(connection: ProviderConnection) {
    const compact = connection.compact;
    if (compact === undefined) throw new Error("A Code harness connection compacts.");
    return compact;
  }

  it("summarizes the turns before the latest and sends the summary and that turn next", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const { transport, requests } = scriptedTransport([
      ...answers(3),
      { text: "  The parser was rewritten; tests still fail on Windows paths.  ", toolCalls: [] },
      { text: "answer 4", toolCalls: [] },
    ]);
    const { result, events } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          for (const prompt of ["first", "second", "third"]) {
            yield* sendAndCollect(connection, prompt, isTerminal);
          }
          const seen = yield* Effect.fork(
            Stream.runCollect(
              (yield* connection.subscribe).pipe(
                Stream.takeUntil((event) => event.kind === "context-compacted"),
              ),
            ),
          );
          const result = yield* compactOf(connection)({ sessionId, compactionId });
          const events = Array.from(yield* Fiber.join(seen));
          yield* sendAndCollect(connection, "fourth", isTerminal);
          return { result, events };
        }),
      ),
    );

    expect(result).toEqual({ kind: "compacted" });
    expect(events.map((event) => event.kind)).toEqual(["context-compacted"]);
    expect(events[0]).toMatchObject({ trigger: "requested" });
    const summaryRequest = requests[3];
    expect(summaryRequest?.tools).toEqual([]);
    expect(summaryRequest?.history).toHaveLength(1);
    expect(summaryRequest?.history[0]?.text).toContain("User: first");
    expect(summaryRequest?.history[0]?.text).toContain("Assistant: answer 2");
    expect(summaryRequest?.history[0]?.text).not.toContain("third");
    expect(requests[4]?.history.map((message) => message.text)).toEqual([
      `${summaryLead(2)}\n\nThe parser was rewritten; tests still fail on Windows paths.`,
      "third",
      "answer 3",
      "fourth",
    ]);
    // Every message stays in the transcript; the marker says what requests read.
    const transcript = transcripts.load(sessionId);
    expect(transcript?.messages.map((message) => message.text)).toEqual([
      "first",
      "answer 1",
      "second",
      "answer 2",
      "third",
      "answer 3",
      "fourth",
      "answer 4",
    ]);
    expect(transcript?.compactions).toEqual([
      {
        summary: "The parser was rewritten; tests still fail on Windows paths.",
        turns: 2,
        afterTurns: 3,
      },
    ]);
  });

  it("resumes a compacted session from its summary and the turns after it", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const { transport, requests } = scriptedTransport([
      ...answers(2),
      { text: "Earlier: chose the queue design.", toolCalls: [] },
      { text: "answer 3", toolCalls: [] },
    ]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* sendAndCollect(connection, "first", isTerminal);
          yield* sendAndCollect(connection, "second", isTerminal);
          yield* compactOf(connection)({ sessionId, compactionId });
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.resume({
            sessionId,
            resumeCursor: { driverKind: "openai-compatible", value: String(sessionId) },
            executionPolicy: "approval-gated",
          });
          yield* sendAndCollect(connection, "third", isTerminal);
        }),
      ),
    );
    expect(requests.at(-1)?.history.map((message) => message.text)).toEqual([
      `${summaryLead(1)}\n\nEarlier: chose the queue design.`,
      "second",
      "answer 2",
      "third",
    ]);
  });

  it("numbers a cut after a compacted resume by the journal, not by the shortened conversation", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    let tight = false;
    const { transport, requests } = scriptedTransport(
      [...answers(2), { text: "Earlier: chose the queue design.", toolCalls: [] }, ...answers(1)],
      // Once tight, not even a summary request fits, so the turn cannot
      // compact and the ladder cuts.
      (request) =>
        !tight ||
        (request.tools.length > 0 && !request.history.some((message) => message.text === "second")),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* sendAndCollect(connection, "first", isTerminal, [], withLookup);
          yield* sendAndCollect(connection, "second", isTerminal, [], withLookup);
          yield* compactOf(connection)({ sessionId, compactionId });
        }),
      ),
    );
    tight = true;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.resume({
            sessionId,
            resumeCursor: { driverKind: "openai-compatible", value: String(sessionId) },
            executionPolicy: "approval-gated",
          });
          yield* sendAndCollect(connection, "third", isTerminal, [], withLookup);
        }),
      ),
    );

    // The journal holds first, answer 1, second, answer 2, then third: every
    // number the note names is one a lookup can read.
    expect(
      requests
        .at(-1)
        ?.history.map((message) => message.text)
        .slice(1),
    ).toEqual(["third"]);
    expect(requests.at(-1)?.history[0]?.text).toContain("Messages 0 to 3 are kept in the journal");
    expect(transcripts.load(sessionId)?.messages[3]?.text).toBe("answer 2");
  });

  it("keeps the compaction in the journal, so a restarted host resumes from the summary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-harness-compaction-"));
    directories.push(directory);
    let identity = 0;
    const { transport, requests } = scriptedTransport([
      ...answers(2),
      { text: "Chose the queue design.", toolCalls: [] },
      { text: "answer 3", toolCalls: [] },
    ]);
    const withJournal = <A, E>(
      body: (transcripts: NativeHarnessTranscriptStore) => Effect.Effect<A, E, Scope.Scope>,
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            return yield* body(
              new JournalNativeHarnessTranscriptStore({
                journal: persistence.journal,
                uuid: () => `80000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`,
                clock: () => now,
                actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
              }),
            );
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );
    await withJournal((transcripts) =>
      Effect.gen(function* () {
        const connection = yield* connect(transport, transcripts);
        yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
        yield* sendAndCollect(connection, "first", isTerminal);
        yield* sendAndCollect(connection, "second", isTerminal);
        yield* compactOf(connection)({ sessionId, compactionId });
      }),
    );
    await withJournal((transcripts) =>
      Effect.gen(function* () {
        const connection = yield* connect(transport, transcripts);
        yield* connection.resume({
          sessionId,
          resumeCursor: { driverKind: "openai-compatible", value: String(sessionId) },
          executionPolicy: "approval-gated",
        });
        yield* sendAndCollect(connection, "third", isTerminal);
      }),
    );
    expect(requests.at(-1)?.history.map((message) => message.text)).toEqual([
      `${summaryLead(1)}\n\nChose the queue design.`,
      "second",
      "answer 2",
      "third",
    ]);
  });

  it("refuses with nothing to compact while the session has only its latest turn", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const { transport, requests } = scriptedTransport(answers(1));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          const empty = yield* compactOf(connection)({ sessionId, compactionId });
          yield* sendAndCollect(connection, "first", isTerminal);
          return [empty, yield* compactOf(connection)({ sessionId, compactionId })];
        }),
      ),
    );
    expect(result).toEqual([
      { kind: "refused", reason: "no-session" },
      { kind: "refused", reason: "nothing-to-compact" },
    ]);
    expect(requests).toHaveLength(1);
  });

  it("leaves the session as it was when the endpoint cannot summarize it", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    const { transport, requests } = scriptedTransport(answers(2));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts);
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* sendAndCollect(connection, "first", isTerminal);
          yield* sendAndCollect(connection, "second", isTerminal);
          // The script has run out, so the summary request fails.
          return yield* compactOf(connection)({ sessionId, compactionId });
        }),
      ),
    );
    expect(result).toEqual({
      kind: "failed",
      message: "The endpoint could not summarize the session.",
      sessionMayHaveChanged: false,
    });
    expect(requests).toHaveLength(3);
    expect(transcripts.load(sessionId)?.compactions).toEqual([]);
  });

  describe("when a long session no longer fits", () => {
    const overflow: ProviderFailure = {
      category: "provider-failed",
      message:
        "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (context_length_exceeded).",
    };
    const taskList = '{"items":[{"content":"Fix the parser","status":"in_progress"}]}';
    const offered = [...tools, tool("todo-write")];

    /**
     * Three turns; the first writes a task list. `refuses` decides which
     * requests the endpoint turns away as too large, `fits` what its own size
     * estimate admits, `summarize` how the summary request (the one without
     * tools) is answered, and `thirdTurn` the third turn's replies. Every tool
     * call is answered as it arrives.
     */
    const runLongSession = async (input: {
      readonly refuses: (request: NativeHarnessRequest) => boolean;
      readonly fits?: (request: NativeHarnessRequest) => boolean;
      readonly summarize?: (
        onEvent: (event: NativeHarnessStreamEvent) => void,
      ) => Promise<NativeHarnessResponse>;
      readonly thirdTurn?: ReadonlyArray<NativeHarnessResponse>;
      readonly offered?: ReadonlyArray<ProviderToolDefinition>;
    }) => {
      const transcripts = new MemoryNativeHarnessTranscriptStore();
      const requests: NativeHarnessRequest[] = [];
      let refusals = 0;
      const replies: NativeHarnessResponse[] = [
        {
          text: "",
          toolCalls: [{ toolCallId: "plan", toolName: "todo-write", argumentsJson: taskList }],
        },
        { text: "answer 1", toolCalls: [] },
        { text: "answer 2", toolCalls: [] },
        ...(input.thirdTurn ?? [
          { text: "answer 3", toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } },
        ]),
      ];
      const transport: NativeHarnessTransport = {
        open: async () => ({
          fits: input.fits ?? (() => true),
          send: async (request, stream) => {
            requests.push(request);
            if (request.tools.length === 0) {
              if (input.summarize !== undefined) return await input.summarize(stream.onEvent);
              return {
                text: "Planned the parser fix and chose the queue design.",
                toolCalls: [],
                usage: { inputTokens: 500, outputTokens: 50 },
              };
            }
            if (input.refuses(request)) {
              refusals += 1;
              throw overflow;
            }
            const next = replies.shift();
            if (next === undefined) throw new Error("The script ran out of responses.");
            return next;
          },
          release: () => undefined,
        }),
      };
      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(transport, transcripts);
            yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
            const seen: ProviderRuntimeEvent[] = [];
            const answered = new Set<string>();
            for (const prompt of ["first", "second", "third"]) {
              seen.length = 0;
              const turn = yield* Effect.fork(
                Stream.runForEach(
                  (yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal)),
                  (event) => Effect.sync(() => seen.push(event)),
                ),
              );
              yield* connection.send({
                sessionId,
                prompt,
                attachments: [],
                tools: input.offered ?? offered,
              });
              for (;;) {
                const requestId = yield* Effect.promise(() => nextUnanswered(seen, answered));
                if (requestId === undefined) break;
                answered.add(requestId);
                yield* connection.answerTool({
                  sessionId,
                  requestId,
                  resultJson: '{"status":"recorded","items":1}',
                  isError: false,
                });
              }
              yield* Fiber.join(turn);
            }
            return seen;
          }),
        ),
      );
      return { events, requests, refusals: () => refusals, transcripts };
    };

    it("summarizes earlier turns after an overflow refusal and continues without a second refusal", async () => {
      // The real window refuses any request that still carries the first turn
      // beside the third, although the endpoint's estimate admitted it.
      const run = await runLongSession({
        refuses: (request) => {
          const texts = request.history.map((message) => message.text);
          return texts.includes("first") && texts.includes("third");
        },
      });

      expect(run.events.at(-1)?.kind).toBe("completed");
      expect(run.refusals()).toBe(1);
      expect(run.events.filter((event) => event.kind === "context-compacted")).toMatchObject([
        { trigger: "automatic" },
      ]);
      const continued = run.requests.at(-1);
      expect(continued?.history.map((message) => message.text)).toEqual([
        `${summaryLead(2)}\n\nPlanned the parser fix and chose the queue design.\n\nYour task list as you last wrote it with todo-write in those turns:\n${taskList}`,
        "third",
      ]);
      // The third turn read the summary itself, so it was made after two turns.
      expect(run.transcripts.load(sessionId)?.compactions).toMatchObject([
        { turns: 2, afterTurns: 2 },
      ]);
      // The turn paid for its summary request, so its closing total says so.
      expect(run.events.filter((event) => event.kind === "usage").at(-1)).toMatchObject({
        inputTokens: 600,
        outputTokens: 60,
      });
    });

    it("keeps the turn alive while a summary streams without showing the summary's text", async () => {
      const run = await runLongSession({
        refuses: (request) => {
          const texts = request.history.map((message) => message.text);
          return texts.includes("first") && texts.includes("third");
        },
        summarize: async (onEvent) => {
          onEvent({ kind: "reasoning-delta", text: "Weighing what to keep." });
          onEvent({ kind: "text-delta", text: "Planned the parser fix." });
          return { text: "Planned the parser fix.", toolCalls: [] };
        },
      });

      expect(run.events.at(-1)?.kind).toBe("completed");
      expect(run.events.filter((event) => event.kind === "liveness").length).toBeGreaterThan(0);
      const shown = run.events.flatMap((event) =>
        event.kind === "text-delta" || event.kind === "reasoning-delta" ? [event.text] : [],
      );
      expect(shown).not.toContain("Weighing what to keep.");
      expect(shown).not.toContain("Planned the parser fix.");
    });

    it("hands a fork through the compacted turn the summary that turn read", async () => {
      const run = await runLongSession({
        refuses: (request) => {
          const texts = request.history.map((message) => message.text);
          return texts.includes("first") && texts.includes("third");
        },
      });
      const turns = ["op-1", "op-2", "op-3"].map((operationId) => ({
        operationId,
        sessionId: "asked",
        status: "completed",
      })) as never as ReadonlyArray<CodeConversationTurn>;
      const fork = decodeProviderSessionId("80000000-0000-4000-8000-000000000903");

      await seedCodeForkHarnessSession(
        {
          transcripts: run.transcripts,
          harnessDriverKind: () => "anthropic-compatible",
          sourceTurns: () => turns,
          sourceConversations: () =>
            new Map(turns.map((turn) => [String(turn.operationId), String(sessionId)])),
        },
        {
          fork: { providerInstanceId: instanceId, modelId } as never as CodeThread,
          origin: { threadId: "source-thread", throughOperationId: "op-3" } as never,
          sessionId: fork,
          checkoutRoot: "/tmp/octant-harness-fork",
          secrets: [],
        },
      );

      expect(run.transcripts.load(fork)?.compactions).toEqual(
        run.transcripts.load(sessionId)?.compactions,
      );
    });

    it("summarizes earlier turns instead of leaving them out when the estimate says they no longer fit", async () => {
      const run = await runLongSession({
        refuses: () => false,
        fits: (request) => {
          const texts = request.history.map((message) => message.text);
          return !(texts.includes("first") && texts.includes("third"));
        },
      });

      expect(run.events.at(-1)?.kind).toBe("completed");
      expect(run.events.some((event) => event.kind === "context-compacted")).toBe(true);
      const sent = run.requests.filter((request) => request.tools.length > 0);
      expect(
        sent.some((request) => request.history[0]?.text.includes("left out to fit") === true),
      ).toBe(false);
      expect(sent.at(-1)?.history[0]?.text).toContain(taskList);
    });

    it("numbers a cut by the journal after the running turn compacted, so journal-lookup reads the cut turn back", async () => {
      const run = await runLongSession({
        refuses: () => false,
        fits: (request) => {
          const texts = request.history.map((message) => message.text);
          // One summary request holds the first turn only, so the second stays.
          if (request.tools.length === 0)
            return !JSON.stringify(request.history).includes("second");
          if (texts.includes("first") && texts.includes("third")) return false;
          // The third turn's tool step no longer fits beside the second turn.
          return !(
            texts.includes("second") &&
            texts.includes("third") &&
            request.history.some((message) => message.toolResults !== undefined)
          );
        },
        thirdTurn: [
          {
            text: "",
            toolCalls: [{ toolCallId: "look-1", toolName: "read", argumentsJson: "{}" }],
          },
          { text: "answer 3", toolCalls: [] },
        ],
        offered: [...withLookup, tool("todo-write")],
      });

      expect(run.events.at(-1)?.kind).toBe("completed");
      expect(run.events.filter((event) => event.kind === "context-compacted")).toMatchObject([
        { trigger: "automatic" },
      ]);
      expect(run.transcripts.load(sessionId)?.compactions).toMatchObject([
        { turns: 1, afterTurns: 2 },
      ]);
      const thirdTurnSteps = run.requests.filter(
        (request) =>
          request.tools.length > 0 && request.history.some((message) => message.text === "third"),
      );
      // The turn opened on the summary, not behind a cut.
      expect(thirdTurnSteps[0]?.history[0]?.text).toContain(summaryLead(1));
      // The journal holds the first turn (0 to 3), second (4) and answer 2 (5),
      // then third (6): the cut after the summary still names journal numbers.
      const cut = thirdTurnSteps[1]?.history ?? [];
      expect(cut[0]?.text).toContain("Messages 0 to 5 are kept in the journal");
      expect(cut[1]?.text).toBe("third");
      const lookup = createCodeJournalLookup({
        transcripts: run.transcripts,
        latestSession: () => ({
          providerInstanceId: instanceId,
          resumeCursor: { driverKind: "openai-compatible", value: String(sessionId) },
        }),
        providerInstanceId: instanceId,
        secrets: [],
      });
      expect(lookup({ from: 4, count: 2 })).toMatchObject({
        status: "found",
        messages: [
          { number: 4, role: "user", text: "second" },
          { number: 5, role: "assistant", text: "answer 2" },
        ],
      });
    });

    it("falls back to leaving earlier exchanges out when the summary fails, and does not pay for it again on later steps", async () => {
      let summaries = 0;
      const run = await runLongSession({
        refuses: () => false,
        fits: (request) => {
          const texts = request.history.map((message) => message.text);
          return !(texts.includes("first") && texts.includes("third"));
        },
        summarize: async () => {
          summaries += 1;
          throw { category: "provider-failed", message: "The summary request failed." };
        },
        thirdTurn: [
          {
            text: "",
            toolCalls: [{ toolCallId: "look-1", toolName: "read", argumentsJson: "{}" }],
          },
          {
            text: "",
            toolCalls: [{ toolCallId: "look-2", toolName: "read", argumentsJson: "{}" }],
          },
          { text: "answer 3", toolCalls: [] },
        ],
      });

      expect(run.events.at(-1)?.kind).toBe("completed");
      expect(summaries).toBe(1);
      expect(run.events.some((event) => event.kind === "context-compacted")).toBe(false);
      expect(run.transcripts.load(sessionId)?.compactions).toEqual([]);
      const thirdTurnSteps = run.requests.filter(
        (request) =>
          request.tools.length > 0 && request.history.some((message) => message.text === "third"),
      );
      expect(thirdTurnSteps).toHaveLength(3);
      for (const step of thirdTurnSteps) {
        expect(step.history[0]?.text).toContain("left out to fit");
      }
    });
  });

  it("offers no compaction on a Chat or Work connection, whose history the host plans", async () => {
    const { transport } = scriptedTransport([]);
    const offered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const modes = [];
          for (const mode of ["chat", "work"] as const) {
            const connection = yield* createNativeHarnessConnection({
              instanceId,
              driverKind: "openai-compatible",
              projectRoot,
              mode,
              transport,
              transcripts: new MemoryNativeHarnessTranscriptStore(),
              admitTurn: () => undefined,
              clock: () => now,
              correlationId: () => "80000000-0000-4000-8000-000000000903",
            });
            modes.push(connection.compact === undefined);
          }
          return modes;
        }),
      ),
    );
    expect(offered).toEqual([true, true]);
  });
});

describe("durable Chat and Work sessions", () => {
  const cursor: ProviderResumeCursor = {
    driverKind: "openai-compatible",
    value: String(sessionId),
  };

  // Event ids stay unique across the two processes that share one journal.
  let identity = 0;

  /** Runs a body against the journal in `directory`, as one host process would. */
  const withJournal = <A, E>(
    directory: string,
    body: (transcripts: NativeHarnessTranscriptStore) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          return yield* body(
            new JournalNativeHarnessTranscriptStore({
              journal: persistence.journal,
              uuid: () => `80000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`,
              clock: () => now,
              actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            }),
          );
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );

  /** A Chat or Work send, which offers no harness tools of its own here. */
  const sendTurn = (connection: ProviderConnection, prompt: string) =>
    Effect.gen(function* () {
      const events = yield* Effect.fork(
        Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
      );
      yield* connection.send({ sessionId, prompt, attachments: [], tools: [] });
      return Array.from(yield* Fiber.join(events));
    });

  it.each(["chat", "work"] as const)(
    "resumes a %s session from the journal after a host restart, under the same prompt cache key",
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "octant-harness-durable-"));
      directories.push(directory);
      const { transport, requests } = scriptedTransport([
        { text: "first answer", toolCalls: [] },
        { text: "second answer", toolCalls: [] },
      ]);
      const started = await withJournal(directory, (transcripts) =>
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts, undefined, mode);
          const handle = yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          yield* sendTurn(connection, "first");
          yield* connection.stop(sessionId);
          return handle.resumeCursor;
        }),
      );
      expect(started).toEqual(cursor);

      const events = await withJournal(directory, (transcripts) =>
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts, undefined, mode);
          yield* connection.resume({
            sessionId,
            resumeCursor: cursor,
            executionPolicy: "approval-gated",
          });
          return yield* sendTurn(connection, "second");
        }),
      );

      expect(events.at(-1)?.kind).toBe("completed");
      expect(String(requests[1]?.sessionId)).toBe(String(requests[0]?.sessionId));
      expect(requests[1]?.history.map((message) => message.text)).toEqual([
        "first",
        "first answer",
        "second",
      ]);
    },
  );

  it.each(["chat", "work"] as const)(
    "continues a %s session whose turn was cancelled, on the next connection",
    async (mode) => {
      const requests: NativeHarnessRequest[] = [];
      const transport: NativeHarnessTransport = {
        open: async () => ({
          fits: () => true,
          send: (request, stream) =>
            new Promise<NativeHarnessResponse>((resolve, reject) => {
              requests.push(request);
              if (requests.length > 1) {
                resolve({ text: "second answer", toolCalls: [] });
                return;
              }
              stream.signal.addEventListener(
                "abort",
                () =>
                  reject({
                    category: "interrupted",
                    message: "The provider request was cancelled.",
                  }),
                { once: true },
              );
            }),
          release: () => undefined,
        }),
      };
      const transcripts = new MemoryNativeHarnessTranscriptStore();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(transport, transcripts, undefined, mode);
            yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
            const first = yield* Effect.fork(
              Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(isTerminal))),
            );
            yield* connection.send({ sessionId, prompt: "first", attachments: [], tools: [] });
            yield* connection.interrupt(sessionId);
            expect(Array.from(yield* Fiber.join(first)).at(-1)?.kind).toBe("interrupted");
            // The turn ends the way a Chat or Work runner ends it: the live
            // session is stopped and its conversation stays in the store.
            yield* connection.stop(sessionId);
          }),
        ),
      );
      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(transport, transcripts, undefined, mode);
            yield* connection.resume({
              sessionId,
              resumeCursor: cursor,
              executionPolicy: "approval-gated",
            });
            return yield* sendTurn(connection, "second");
          }),
        ),
      );

      expect(events.at(-1)?.kind).toBe("completed");
      expect(String(requests[1]?.sessionId)).toBe(String(sessionId));
      expect(requests[1]?.history.map((message) => message.text)).toEqual(["first", "second"]);
    },
  );

  it("refuses to resume a Chat session on a Work connection", async () => {
    const transcripts = new MemoryNativeHarnessTranscriptStore();
    transcripts.open(sessionId, { instanceId, modelId, projectRoot, mode: "chat" });
    const { transport, requests } = scriptedTransport([]);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(transport, transcripts, undefined, "work");
          return yield* connection.resume({
            sessionId,
            resumeCursor: cursor,
            executionPolicy: "approval-gated",
          });
        }),
      ),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { error: { category: "stale-resume" } },
    });
    expect(requests).toEqual([]);
  });
});

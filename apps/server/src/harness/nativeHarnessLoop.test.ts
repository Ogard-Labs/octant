import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
  type ProviderResumeCursor,
  type ProviderRuntimeEvent,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream, type Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createNativeHarnessConnection, fitRequest } from "./nativeHarnessLoop";
import {
  JournalNativeHarnessTranscriptStore,
  MemoryNativeHarnessTranscriptStore,
  type NativeHarnessTranscriptStore,
} from "./nativeHarnessTranscriptStore";
import type {
  NativeHarnessRequest,
  NativeHarnessResponse,
  NativeHarnessTransport,
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
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** An endpoint that answers from a script and remembers every request it was sent. */
function scriptedTransport(
  script: NativeHarnessResponse[],
  fits: (request: NativeHarnessRequest) => boolean = () => true,
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
        send: async (request) => {
          requests.push(request);
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
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return createNativeHarnessConnection({
    instanceId,
    driverKind: "openai-compatible",
    projectRoot,
    mode: "code",
    transport,
    transcripts,
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
) {
  return Effect.gen(function* () {
    const events = yield* Effect.fork(
      Stream.runCollect((yield* connection.subscribe).pipe(Stream.takeUntil(until))),
    );
    yield* connection.send({ sessionId, prompt, context, attachments: [], tools });
    return Array.from(yield* Fiber.join(events));
  });
}

const isTerminal = (event: ProviderRuntimeEvent) =>
  event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted";

describe("native harness loop", () => {
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

describe("fitting a request to the endpoint", () => {
  const base: NativeHarnessRequest = {
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
});

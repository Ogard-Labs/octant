import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderResumeCursor,
  type ProviderRuntimeEvent,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
import { deriveTurnMetrics } from "@octant/domain";
import { Effect, Fiber, Stream, type Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { usageFromRuntimeEvent } from "../providers/providerContextFacts";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { buildUsageDashboard } from "../usageDashboardModel";
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
  leadFallback?: NativeHarnessLeadFallback,
): Effect.Effect<ProviderConnection, never, Scope.Scope> {
  return createNativeHarnessConnection({
    instanceId,
    driverKind: "openai-compatible",
    projectRoot,
    mode: "code",
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

  describe("usage across the requests of one turn", () => {
    /** Runs a turn of two requests, the first calling a tool, and returns every event it produced. */
    const twoRequestTurn = (
      first: NativeHarnessResponse["usage"],
      second: NativeHarnessResponse["usage"],
    ) => {
      const { transport } = scriptedTransport([
        {
          text: "",
          toolCalls: [{ toolCallId: "call", toolName: "read", argumentsJson: "{}" }],
          ...(first === undefined ? {} : { usage: first }),
        },
        { text: "done", toolCalls: [], ...(second === undefined ? {} : { usage: second }) },
      ]);
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(transport, new MemoryNativeHarnessTranscriptStore());
            yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
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
      });
    });
  });
});

/** An endpoint whose `fits` always passes, so only the endpoint itself can refuse a size. */
function endpointThatAcceptsEverySize(
  send: (request: NativeHarnessRequest) => Promise<NativeHarnessResponse>,
): { readonly transport: NativeHarnessTransport; readonly requests: NativeHarnessRequest[] } {
  const requests: NativeHarnessRequest[] = [];
  return {
    requests,
    transport: {
      open: async () => ({
        fits: () => true,
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

describe("recovering from a request the endpoint refuses as too large", () => {
  it("forces one more reduction and completes after a single overflow retry", async () => {
    const overflow: ProviderFailure = {
      category: "provider-failed",
      message:
        "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (context_length_exceeded).",
    };
    const calls: string[] = [];
    const scripted = endpointThatAcceptsEverySize(async () => {
      calls.push("call");
      if (calls.length === 1) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "a", toolName: "read", argumentsJson: "{}" }],
        };
      }
      if (calls.length === 2) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "b", toolName: "grep", argumentsJson: "{}" }],
        };
      }
      if (calls.length === 3) throw overflow;
      return { text: "recovered", toolCalls: [] };
    });

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
          for (const requestId of ["a", "b"]) {
            yield* Effect.promise(() => whenRequested(events, requestId));
            yield* connection.answerTool({
              sessionId,
              requestId,
              resultJson: "{}",
              isError: false,
            });
          }
          yield* Fiber.join(collected);
        }),
      ),
    );

    expect(events.at(-1)?.kind).toBe("completed");
    expect(scripted.requests).toHaveLength(4);
    const retried = scripted.requests[3]?.history ?? [];
    expect(
      retried.some((message) =>
        message.toolResults?.some((result) => result.resultJson.includes('"omitted":true')),
      ),
    ).toBe(true);
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

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
function scriptedTransport(script: NativeHarnessResponse[]): {
  readonly transport: NativeHarnessTransport;
  readonly requests: NativeHarnessRequest[];
} {
  const requests: NativeHarnessRequest[] = [];
  return {
    requests,
    transport: {
      open: async () => ({
        fits: () => true,
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

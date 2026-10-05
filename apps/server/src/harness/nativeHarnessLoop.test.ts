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

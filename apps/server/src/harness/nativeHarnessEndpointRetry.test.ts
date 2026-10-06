import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeAnthropicCompatibleDriver } from "../providers/anthropicCompatibleDriver";
import type { EndpointRetryOptions } from "../providers/endpointRetry";
import { makeOpenAiCompatibleDriver } from "../providers/openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000701");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000702");
const modelId = "retry-model" as ProviderModelId;
const encoder = new TextEncoder();
const resolver = { has: async () => true, resolve: async () => "private-key" };

type NamedEvent = { readonly type: string } & Readonly<Record<string, unknown>>;
type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One direct endpoint kind, driven through the same turn so both are held to one behavior. */
interface EndpointKind {
  readonly name: string;
  readonly driver: (fetch: Fetch, retry: EndpointRetryOptions) => ProviderDriver;
  readonly answer: (text: string) => Response;
  /** A stream that opens, then closes before it says anything or reaches its terminal event. */
  readonly truncatedBeforeOutput: () => Response;
  /** A stream that says `text`, then the connection resets. */
  readonly resetAfterOutput: (text: string) => Response;
  readonly emptyAnswer: () => Response;
}

const openAiDriver =
  (protocol: "chat-completions" | "responses") =>
  (fetch: Fetch, retry: EndpointRetryOptions): ProviderDriver =>
    makeOpenAiCompatibleDriver({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://provider.example/v1",
        authentication: "bearer",
        protocol,
        manualModelIds: [modelId],
      },
      credentialResolver: resolver,
      fetch,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      harness: { retry },
      clock: () => "2026-10-06T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000703",
    });

const openAi: EndpointKind = {
  name: "OpenAI-compatible",
  driver: openAiDriver("chat-completions"),
  answer: (text) =>
    sse([
      chatChunk({ role: "assistant", content: text }),
      chatChunk({}, "stop"),
      { id: "c", object: "chat.completion.chunk", choices: [], usage: usage(3, 2) },
      "[DONE]",
    ]),
  truncatedBeforeOutput: () => sse([chatChunk({ role: "assistant" })]),
  resetAfterOutput: (text) =>
    breakingStream(sseBody([chatChunk({ role: "assistant", content: text })])),
  emptyAnswer: () =>
    sse([
      chatChunk({ role: "assistant", content: "" }),
      chatChunk({}, "stop"),
      { id: "c", object: "chat.completion.chunk", choices: [], usage: usage(4, 0) },
      "[DONE]",
    ]),
};

const anthropic: EndpointKind = {
  name: "Anthropic-compatible",
  driver: (fetch, retry) =>
    makeAnthropicCompatibleDriver({
      instanceId,
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://provider.example/v1",
        authentication: "api-key",
        protocol: "messages",
        protocolVersion: "2023-06-01",
        manualModelIds: [modelId],
      },
      credentialResolver: resolver,
      fetch,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      harness: { retry },
      clock: () => "2026-10-06T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000703",
    }),
  answer: (text) => namedSse(messagesEvents(text)),
  truncatedBeforeOutput: () => namedSse(messagesEvents("").slice(0, 1)),
  resetAfterOutput: (text) => breakingStream(namedBody(messagesEvents(text).slice(0, 3))),
  emptyAnswer: () => namedSse(messagesEvents("")),
};

function sseBody(chunks: readonly unknown[]): string {
  return chunks
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
    .join("");
}
function sse(chunks: readonly unknown[]): Response {
  return new Response(sseBody(chunks), { headers: { "content-type": "text/event-stream" } });
}
function namedBody(events: ReadonlyArray<NamedEvent>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
function namedSse(events: ReadonlyArray<NamedEvent>): Response {
  return new Response(namedBody(events), { headers: { "content-type": "text/event-stream" } });
}
function breakingStream(body: string): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error("connection reset"));
          return;
        }
        sent = true;
        controller.enqueue(encoder.encode(body));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function usage(input: number, output: number) {
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}
function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    usage: null,
  };
}
function messagesEvents(text: string): ReadonlyArray<NamedEvent> {
  return [
    {
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        content: [],
        model: "retry-model",
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...(text === ""
      ? []
      : [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }]),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
}

const status = (code: number, headers?: Record<string, string>) =>
  new Response(null, { status: code, ...(headers === undefined ? {} : { headers }) });

/** The retry clock: every wait is recorded and returns at once. */
function instantRetry(): { readonly options: EndpointRetryOptions; readonly waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    options: {
      random: () => 0.5,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  };
}

/** Runs one turn to its terminal event; `act` may run alongside it (to cancel, say). */
function runTurn(
  kind: EndpointKind,
  fetch: Fetch,
  retry: EndpointRetryOptions,
  act?: (input: {
    readonly events: ProviderRuntimeEvent[];
    readonly interrupt: () => Promise<void>;
  }) => Promise<void>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* kind
          .driver(fetch, retry)
          .acquire({ instanceId, projectRoot: "/tmp/octant-endpoint-retry" });
        yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
        const events: ProviderRuntimeEvent[] = [];
        const collected = yield* Effect.fork(
          Stream.runForEach(
            (yield* connection.subscribe).pipe(
              Stream.filter((event) => event.sessionId === sessionId),
              Stream.takeUntil(
                (event) =>
                  event.kind === "completed" ||
                  event.kind === "failed" ||
                  event.kind === "interrupted",
              ),
            ),
            (event) => Effect.sync(() => events.push(event)),
          ),
        );
        yield* connection.send({ sessionId, prompt: "go", attachments: [], tools: [] });
        if (act !== undefined) {
          yield* Effect.promise(() =>
            act({
              events,
              interrupt: () => Effect.runPromise(connection.interrupt(sessionId)),
            }),
          );
        }
        yield* Fiber.join(collected);
        yield* connection.stop(sessionId);
        return events;
      }),
    ),
  );
}

const retrying = (events: readonly ProviderRuntimeEvent[]) =>
  events.flatMap((event) => (event.kind === "retrying" ? [event] : []));

describe.each([openAi, anthropic])("$name endpoint retries", (kind) => {
  it("succeeds after two overloaded responses and shows both retries before the answer", async () => {
    const { options, waits } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return calls <= 2 ? status(503) : kind.answer("it worked");
      },
      options,
    );

    expect(calls).toBe(3);
    expect(events.map((event) => event.kind)).toEqual([
      "retrying",
      "retrying",
      "text-delta",
      "usage",
      "completed",
    ]);
    expect(retrying(events)).toMatchObject([
      { attempt: 2, maxAttempts: 5, delayMs: 500, reason: "unavailable" },
      { attempt: 3, maxAttempts: 5, delayMs: 1_000, reason: "unavailable" },
    ]);
    expect(waits).toEqual([500, 1_000]);
  });

  it("waits as long as the provider's Retry-After asks when it rate-limits", async () => {
    const { options, waits } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return calls === 1 ? status(429, { "retry-after": "7" }) : kind.answer("ok");
      },
      options,
    );

    expect(waits).toEqual([7_000]);
    expect(retrying(events)).toMatchObject([
      { attempt: 2, delayMs: 7_000, reason: "rate-limited" },
    ]);
    expect(events.at(-1)?.kind).toBe("completed");
  });

  it("does not retry once text has streamed, and says so instead of repeating it", async () => {
    const { options, waits } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return kind.resetAfterOutput("half an answ");
      },
      options,
    );

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(events.map((event) => event.kind)).toEqual(["text-delta", "failed"]);
  });

  it("retries a stream that closes before its terminal event", async () => {
    const { options } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return calls === 1 ? kind.truncatedBeforeOutput() : kind.answer("whole");
      },
      options,
    );

    expect(calls).toBe(2);
    expect(retrying(events)).toMatchObject([{ attempt: 2, reason: "stream-interrupted" }]);
    expect(events.at(-1)?.kind).toBe("completed");
  });

  it("treats an empty completion as a failure to retry, not a success", async () => {
    const { options } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return calls === 1 ? kind.emptyAnswer() : kind.answer("now with words");
      },
      options,
    );

    expect(calls).toBe(2);
    expect(retrying(events)).toMatchObject([{ attempt: 2, reason: "empty-completion" }]);
    expect(events.some((event) => event.kind === "text-delta")).toBe(true);
    expect(events.at(-1)?.kind).toBe("completed");
  });

  it("gives up after five attempts and fails with the endpoint's own failure", async () => {
    const { options, waits } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return status(503);
      },
      options,
    );

    expect(calls).toBe(5);
    expect(waits).toEqual([500, 1_000, 2_000, 4_000]);
    expect(retrying(events).map((event) => `${event.attempt}/${event.maxAttempts}`)).toEqual([
      "2/5",
      "3/5",
      "4/5",
      "5/5",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "failed",
      failure: { category: "unavailable" },
    });
  });

  it("does not retry a rejected credential", async () => {
    const { options } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return status(401);
      },
      options,
    );

    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({
      kind: "failed",
      failure: { category: "unauthenticated" },
    });
  });

  it("counts every attempt's tokens in the turn's usage", async () => {
    const { options } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return calls === 1 ? kind.emptyAnswer() : kind.answer("counted");
      },
      options,
    );

    const reported = events.flatMap((event) => (event.kind === "usage" ? [event] : []));
    // The empty attempt billed 4 (OpenAI) or 3 (Anthropic) input tokens before the good one.
    const emptyInput = kind === openAi ? 4 : 3;
    expect(reported.at(-1)?.inputTokens).toBe(emptyInput + 3);
  });

  it("stops at once when cancelled during a backoff wait, and reports it as cancelled", async () => {
    let calls = 0;
    const startedAt = Date.now();
    const events = await runTurn(
      kind,
      async () => {
        calls += 1;
        return status(503);
      },
      // The real wait: a minute, so only a cancel can end it early.
      { baseDelayMs: 60_000, maxDelayMs: 60_000, random: () => 0.5 },
      async ({ events: seen, interrupt }) => {
        while (!seen.some((event) => event.kind === "retrying")) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await interrupt();
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(calls).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(["retrying", "interrupted"]);
  });
});

describe("OpenAI-compatible Responses endpoint retries", () => {
  it("retries a Responses stream that closes before its terminal event", async () => {
    const { options } = instantRetry();
    let calls = 0;
    const events = await runTurn(
      { ...openAi, driver: openAiDriver("responses") },
      async () => {
        calls += 1;
        return calls === 1
          ? sse([
              {
                type: "response.created",
                sequence_number: 1,
                response: { id: "r", object: "response", status: "in_progress", usage: null },
              },
            ])
          : responsesAnswer("whole");
      },
      options,
    );

    expect(calls).toBe(2);
    expect(retrying(events)).toMatchObject([{ attempt: 2, reason: "stream-interrupted" }]);
    expect(events.at(-1)?.kind).toBe("completed");
  });
});

function responsesAnswer(text: string): Response {
  const response = (status: "in_progress" | "completed", usage: unknown = null) => ({
    id: "r",
    object: "response",
    status,
    usage,
  });
  const item = (status: "in_progress" | "completed", content: unknown[]) => ({
    id: "m",
    type: "message",
    role: "assistant",
    status,
    content,
  });
  return sse([
    { type: "response.created", sequence_number: 1, response: response("in_progress") },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: item("in_progress", []),
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: "m",
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: "m",
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: item("completed", [{ type: "output_text", text, annotations: [] }]),
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: response("completed", { input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
    },
  ]);
}

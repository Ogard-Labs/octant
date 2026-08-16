import type { OpenAiCompatibleProviderConfiguration, ProviderToolAnswer } from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFetch, makeOpenAiCompatibleEndpoint } from "./openAiCompatibleEndpoint";
import { sendChatCompletionsTurn } from "./openAiChatCompletions";
import type { ProtocolHistoryMessage } from "./openAiResponses";
import { sendResponsesTurn } from "./openAiResponses";

const encoder = new TextEncoder();

function sseResponse(...events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const responsesConfig: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "none",
  protocol: "responses",
  manualModelIds: ["manual-model" as never],
};

const chatConfig: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "none",
  protocol: "chat-completions",
  manualModelIds: ["manual-model" as never],
};

function toolAnswer(callId: string, resultJson: string): ProviderToolAnswer {
  return {
    sessionId: "019f64cf-7241-7000-8000-000000000001" as never,
    requestId: callId,
    resultJson,
    isError: false,
  };
}

describe("tool result continuation in request body", () => {
  it("Responses: includes function_call_output items after the user prompt when toolAnswers are supplied", async () => {
    const fetch = vi.fn(async () =>
      sseResponse(
        {
          type: "response.created",
          sequence_number: 1,
          response: { id: "r", object: "response", status: "in_progress", usage: null, output: [] },
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "r",
            object: "response",
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            output: [],
          },
        },
      ),
    );

    await Effect.runPromise(
      sendResponsesTurn({
        endpoint: makeOpenAiCompatibleEndpoint({
          instanceId: "019f64cf-7241-7000-8000-000000000001",
          configuration: responsesConfig,
          fetch: fetch as CompatibleFetch,
          limits: { responseBodyBytes: 16_384 },
        }),
        modelId: "manual-model",
        history: [],
        prompt: "continue",
        toolAnswers: [toolAnswer("call_abc", '{"ok":true}')],
      }),
    );

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([
      { role: "user", content: "continue" },
      { type: "function_call_output", call_id: "call_abc", output: '{"ok":true}' },
    ]);
  });

  it("Chat Completions: includes tool role messages after the user prompt when toolAnswers are supplied", async () => {
    const body = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] })}\n\ndata: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(body));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    await Effect.runPromise(
      sendChatCompletionsTurn({
        endpoint: makeOpenAiCompatibleEndpoint({
          instanceId: "019f64cf-7241-7000-8000-000000000001",
          configuration: chatConfig,
          fetch: fetch as CompatibleFetch,
          limits: { responseBodyBytes: 16_384 },
        }),
        modelId: "manual-model",
        history: [],
        prompt: "continue",
        toolAnswers: [toolAnswer("call_abc", '{"ok":true}')],
      }),
    );

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body));
    expect(requestBody.messages).toEqual([
      { role: "user", content: "continue" },
      { role: "tool", tool_call_id: "call_abc", content: '{"ok":true}' },
    ]);
  });

  it("Responses: preserves prior assistant function_call items from history before tool answers", async () => {
    const fetch = vi.fn(async () =>
      sseResponse(
        {
          type: "response.created",
          sequence_number: 1,
          response: { id: "r", object: "response", status: "in_progress", usage: null, output: [] },
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "r",
            object: "response",
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            output: [],
          },
        },
      ),
    );

    const history: readonly ProtocolHistoryMessage[] = [
      { role: "user", text: "echo hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          {
            toolCallId: "call_abc",
            toolName: "octant_capability_echo",
            argumentsJson: '{"echo":"hi"}',
          },
        ],
      },
    ];

    await Effect.runPromise(
      sendResponsesTurn({
        endpoint: makeOpenAiCompatibleEndpoint({
          instanceId: "019f64cf-7241-7000-8000-000000000001",
          configuration: responsesConfig,
          fetch: fetch as CompatibleFetch,
          limits: { responseBodyBytes: 16_384 },
        }),
        modelId: "manual-model",
        history,
        prompt: "",
        toolAnswers: [toolAnswer("call_abc", '{"echo":"hi"}')],
      }),
    );

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toEqual([
      { role: "user", content: "echo hi" },
      { role: "assistant", content: "" },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "octant_capability_echo",
        arguments: '{"echo":"hi"}',
      },
      { type: "function_call_output", call_id: "call_abc", output: '{"echo":"hi"}' },
    ]);
  });

  it("Chat Completions: preserves prior assistant tool_calls message from history before tool answers", async () => {
    const body = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] })}\n\ndata: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(body));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const history: readonly ProtocolHistoryMessage[] = [
      { role: "user", text: "echo hi" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          {
            toolCallId: "call_abc",
            toolName: "octant_capability_echo",
            argumentsJson: '{"echo":"hi"}',
          },
        ],
      },
    ];

    await Effect.runPromise(
      sendChatCompletionsTurn({
        endpoint: makeOpenAiCompatibleEndpoint({
          instanceId: "019f64cf-7241-7000-8000-000000000001",
          configuration: chatConfig,
          fetch: fetch as CompatibleFetch,
          limits: { responseBodyBytes: 16_384 },
        }),
        modelId: "manual-model",
        history,
        prompt: "",
        toolAnswers: [toolAnswer("call_abc", '{"echo":"hi"}')],
      }),
    );

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body));
    expect(requestBody.messages).toEqual([
      { role: "user", content: "echo hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "octant_capability_echo", arguments: '{"echo":"hi"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: '{"echo":"hi"}' },
    ]);
  });
});

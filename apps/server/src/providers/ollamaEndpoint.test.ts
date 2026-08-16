import { describe, expect, it, vi } from "vitest";
import {
  makeOllamaEndpoint,
  probeOllama,
  sendOllamaChat,
  type OllamaFetch,
} from "./ollamaEndpoint";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function ndjson(values: readonly unknown[]) {
  return new Response(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

describe("Ollama native endpoint", () => {
  it("accepts only the native API on literal loopback HTTP endpoints", () => {
    expect(makeOllamaEndpoint({ baseUrl: "http://[::1]:11434/" }).baseUrl).toBe(
      "http://[::1]:11434",
    );

    for (const baseUrl of [
      "https://127.0.0.1:11434/",
      "http://192.168.1.5:11434/",
      "http://user@localhost:11434/",
      "http://localhost:11434/v1/",
      "http://localhost:11434/?token=secret",
      "http://localhost:11434/#fragment",
    ]) {
      expect(() => makeOllamaEndpoint({ baseUrl })).toThrow();
    }
  });

  it("probes only version, tags, and per-model detail without mutating the shared service", async () => {
    const fetch = vi.fn<OllamaFetch>(async (input, init) => {
      const url = String(input);
      expect(init?.redirect).toBe("manual");
      if (url.endsWith("/version")) return json({ version: "0.31.2" });
      if (url.endsWith("/tags")) {
        return json({
          models: [
            { name: "qwen3:latest", model: "qwen3:latest" },
            { name: "llava:latest", model: "llava:latest" },
          ],
        });
      }
      if (url.endsWith("/show")) {
        const body = JSON.parse(String(init?.body));
        return json({
          capabilities:
            body.model === "qwen3:latest"
              ? ["completion", "thinking", "tools"]
              : ["completion", "vision"],
          model_info: { "qwen3.context_length": 131072 },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const result = await probeOllama(
      makeOllamaEndpoint({ baseUrl: "http://127.0.0.1:11434", fetch }),
    );

    expect(result).toMatchObject({
      readiness: "ready",
      version: "0.31.2",
      models: [
        {
          id: "qwen3:latest",
          displayName: "qwen3:latest",
          contextLimit: 131072,
          reasoning: "supported",
          // Observed capability list without "vision": an explicit fact, not
          // an unknown.
          imageInput: "unsupported",
        },
        { id: "llava:latest", reasoning: "unsupported", imageInput: "supported" },
      ],
      capabilities: {
        streaming: "unavailable",
        resume: "supported",
        interruption: "supported",
        approvals: "unsupported",
        userQuestions: "unsupported",
        reasoning: "unavailable",
        usage: "unavailable",
        toolActivity: "unavailable",
        nativeChildAgents: "unsupported",
      },
    });
    expect(fetch.mock.calls.map(([input, init]) => [String(input), init?.method ?? "GET"])).toEqual(
      [
        ["http://127.0.0.1:11434/api/version", "GET"],
        ["http://127.0.0.1:11434/api/tags", "GET"],
        ["http://127.0.0.1:11434/api/show", "POST"],
        ["http://127.0.0.1:11434/api/show", "POST"],
      ],
    );
  });

  it("normalizes ordered native NDJSON text, thinking, tool requests, usage, and completion", async () => {
    const fetch = vi.fn<OllamaFetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "qwen3:latest",
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "now", images: ["AQID"] },
        ],
        stream: true,
      });
      return ndjson([
        {
          model: "qwen3:latest",
          message: { role: "assistant", thinking: "reason", content: "" },
          done: false,
        },
        {
          model: "qwen3:latest",
          message: {
            role: "assistant",
            content: "hello",
            tool_calls: [{ function: { name: "lookup", arguments: { value: 1 } } }],
          },
          done: false,
        },
        {
          model: "qwen3:latest",
          message: { role: "assistant", content: " world" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 7,
          eval_count: 2,
          total_duration: 100,
        },
      ]);
    });
    const events: unknown[] = [];
    const result = await sendOllamaChat(
      makeOllamaEndpoint({ baseUrl: "http://localhost:11434", fetch }),
      {
        modelId: "qwen3:latest",
        history: [
          { role: "user", text: "earlier" },
          { role: "assistant", text: "answer" },
        ],
        prompt: "now",
        attachments: [{ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
        onEvent: (event) => events.push(event),
      },
    );
    expect(result).toEqual({
      text: "hello world",
      reasoning: "reason",
      toolRequests: [{ toolCallId: "ollama-tool-1", toolName: "lookup" }],
      usage: { inputTokens: 7, outputTokens: 2 },
      doneReason: "stop",
    });
    expect(events).toEqual([
      { kind: "reasoning-delta", text: "reason" },
      { kind: "text-delta", text: "hello" },
      { kind: "tool-request", toolCallId: "ollama-tool-1", toolName: "lookup" },
      { kind: "text-delta", text: " world" },
      { kind: "usage", inputTokens: 7, outputTokens: 2 },
    ]);
  });

  it("fails closed for redirects, malformed streams, oversized frames, and cancellation", async () => {
    const redirect = makeOllamaEndpoint({
      baseUrl: "http://127.0.0.1:11434",
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://lan/" } }),
    });
    await expect(probeOllama(redirect)).rejects.toMatchObject({
      category: "invalid-configuration",
    });

    const malformed = makeOllamaEndpoint({
      baseUrl: "http://127.0.0.1:11434",
      fetch: async () => new Response('{"done":false}\nnot-json\n'),
    });
    await expect(
      sendOllamaChat(malformed, { modelId: "model", history: [], prompt: "hello" }),
    ).rejects.toMatchObject({ category: "protocol" });

    const oversized = makeOllamaEndpoint({
      baseUrl: "http://127.0.0.1:11434",
      limits: { frameBytes: 32 },
      fetch: async () =>
        new Response(`${JSON.stringify({ message: { content: "x".repeat(100) } })}\n`),
    });
    await expect(
      sendOllamaChat(oversized, { modelId: "model", history: [], prompt: "hello" }),
    ).rejects.toMatchObject({ category: "protocol" });

    const controller = new AbortController();
    const cancelled = makeOllamaEndpoint({
      baseUrl: "http://127.0.0.1:11434",
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    });
    const request = sendOllamaChat(cancelled, {
      modelId: "model",
      history: [],
      prompt: "hello",
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ category: "interrupted" });

    const streamingController = new AbortController();
    let resolveFirstEvent!: () => void;
    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });
    const hangingStream = makeOllamaEndpoint({
      baseUrl: "http://127.0.0.1:11434",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({
                    model: "model",
                    message: { role: "assistant", content: "first" },
                    done: false,
                  })}\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    });
    const streamingRequest = sendOllamaChat(hangingStream, {
      modelId: "model",
      history: [],
      prompt: "hello",
      signal: streamingController.signal,
      onEvent: () => resolveFirstEvent(),
    });
    await firstEvent;
    streamingController.abort();
    const streamingOutcome = await Promise.race([
      streamingRequest.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);
    expect(streamingOutcome).toMatchObject({ category: "interrupted" });
  });
});

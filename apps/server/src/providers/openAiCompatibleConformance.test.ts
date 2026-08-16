import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type OpenAiCompatibleProtocol,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { describe, expect, it } from "vitest";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000511");
const interruptedSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000512");
const successfulSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000514");
const modelId = "fixture-model" as ProviderModelId;

describe("OpenAI-compatible provider conformance", () => {
  it.each([
    {
      name: "Responses streaming",
      protocol: "responses" as const,
      expectedStreaming: "supported" as const,
      fixture: responsesFixture,
    },
    {
      name: "Chat Completions streaming",
      protocol: "chat-completions" as const,
      expectedStreaming: "supported" as const,
      fixture: chatStreamingFixture,
    },
    {
      name: "Chat Completions non-streaming degraded",
      protocol: "chat-completions" as const,
      expectedStreaming: "unsupported" as const,
      fixture: chatNonStreamingFixture,
    },
  ])("passes successful, cancellation, and cleanup conformance for $name", async (profile) => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    let released = false;
    const fetch = profile.fixture();
    const driver = makeOpenAiCompatibleDriver({
      instanceId,
      configuration: configuration(profile.protocol),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      onConnectionReleased: () => {
        released = true;
      },
      clock: () => "2026-07-15T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000513",
    });

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-compatible-conformance" },
      successfulTurn: {
        sessionStart: {
          sessionId: successfulSessionId,
          modelId,
          executionPolicy: "approval-gated",
        },
        turn: {
          sessionId: successfulSessionId,
          prompt: "successful fixture prompt",
          attachments: [],
          tools: [],
        },
        expectedEventKinds: ["text-delta", "usage", "completed"],
        expectedStreaming: profile.expectedStreaming,
        observed: () => runtimeRegistry.observedState(instanceId),
      },
      sessionStart: {
        sessionId: interruptedSessionId,
        modelId,
        executionPolicy: "approval-gated",
      },
      turn: {
        sessionId: interruptedSessionId,
        prompt: "interrupt fixture prompt",
        attachments: [],
        tools: [],
      },
      resume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "openai-compatible", value: "unsupported" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "openai-compatible", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId: interruptedSessionId, requestId: "unknown", approved: false },
      unknownUserInput: {
        sessionId: interruptedSessionId,
        requestId: "unknown",
        answer: "none",
      },
      expectedEventKinds: ["interrupted"],
      expectedFailureCategories: {
        staleResume: "unsupported",
        unknownApproval: "unsupported",
        unknownUserInput: "unsupported",
      },
      isReleased: () => released,
    });
    const chatEvidence = await runProviderChatConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-compatible-conformance" },
      sessionStart: { sessionId: successfulSessionId, modelId, executionPolicy: "approval-gated" },
      turn: {
        sessionId: successfulSessionId,
        prompt: "hello",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "diagram.png",
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
        tools: [],
      },
      isReleased: () => released,
    });
    recordProviderConformanceEvidence("openai-compatible", evidence);
    recordProviderChatConformanceEvidence("openai-compatible", chatEvidence);

    expect(evidence).toMatchObject({
      capabilityHonest: true,
      usageCapabilityHonest: true,
      researchCapabilityHonest: true,
      citationsCapabilityHonest: true,
      streamedInOrder: true,
      interrupted: true,
      released: true,
    });
    expect(runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    expect(chatEvidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
  });
});

function configuration(protocol: OpenAiCompatibleProtocol) {
  return {
    kind: "openai-compatible-http" as const,
    baseUrl: "https://fixture.example/v1",
    authentication: "bearer" as const,
    protocol,
    manualModelIds: [modelId],
  };
}

function responsesFixture(): CompatibleFetch {
  let completed = 0;
  return async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body)) as { input?: { content?: string }[] };
    // The probe's tool capability request uses prompt "echo ready"; return a
    // text stream without consuming a turn slot.
    const isProbe = body.input?.some((item) => item.content === "echo ready") ?? false;
    if (isProbe) return responsesTextStream("probe ok");
    // Turn flow:
    // 1: successful conformance turn -> text stream
    // 2: interrupted conformance turn -> hanging response
    // 3: chat conformance turn -> text stream
    completed += 1;
    if (completed === 2) return hangingResponse(init?.signal ?? undefined);
    return responsesTextStream("responses answer");
  };
}

function chatStreamingFixture(): CompatibleFetch {
  let completed = 0;
  return async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body)) as { messages?: { content: string }[] };
    const isProbe = body.messages?.some((m) => m.content === "echo ready") ?? false;
    if (isProbe) return chatStream("probe ok");
    completed += 1;
    if (completed === 2) return hangingResponse(init?.signal ?? undefined);
    return chatStream("chat answer");
  };
}

function chatNonStreamingFixture(): CompatibleFetch {
  let nonStreamingCount = 0;
  return async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body)) as {
      stream: boolean;
      messages?: { content: string }[];
    };
    // The probe's tool capability request uses prompt "echo ready"; return a
    // plain non-streaming response without consuming a turn slot.
    const isProbe = body.messages?.some((m) => m.content === "echo ready") ?? false;
    if (body.stream) {
      // Streaming is unsupported; return 400 for all streaming requests.
      return Response.json(
        {
          error: {
            message: "stream unsupported",
            type: "invalid_request_error",
            param: "stream",
            code: "unsupported_parameter",
          },
        },
        { status: 400 },
      );
    }
    if (isProbe) {
      return Response.json({
        id: "chatcmpl_probe",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "probe ok" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    // Non-streaming turn flow:
    // 1: successful conformance turn -> non-streaming response
    // 2: interrupted conformance turn -> hanging response
    // 3: chat conformance turn -> non-streaming response
    nonStreamingCount += 1;
    if (nonStreamingCount === 2) return hangingResponse(init?.signal ?? undefined);
    return Response.json({
      id: "chatcmpl_fixture",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "non-streaming answer" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    });
  };
}

function models() {
  return Response.json({ data: [{ id: modelId }] });
}

function hangingResponse(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new Error("private abort")));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function chatStream(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: null,
    },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      usage: null,
    },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    },
    "[DONE]",
  ];
  return new Response(
    chunks
      .map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function responsesTextStream(text: string): Response {
  const response = (status: "in_progress" | "completed", usage: unknown = null) => ({
    id: "resp_fixture",
    object: "response",
    status,
    usage,
  });
  const events = [
    { type: "response.created", sequence_number: 1, response: response("in_progress") },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: response("completed", { input_tokens: 2, output_tokens: 2, total_tokens: 4 }),
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

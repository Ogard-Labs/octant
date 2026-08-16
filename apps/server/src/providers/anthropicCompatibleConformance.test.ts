import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type AnthropicCompatibleProtocol,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { describe, expect, it } from "vitest";
import type { AnthropicCompatibleFetch } from "./anthropicCompatibleEndpoint";
import { makeAnthropicCompatibleDriver } from "./anthropicCompatibleDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000611");
const interruptedSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000612");
const successfulSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000614");
const modelId = "fixture-model" as ProviderModelId;

describe("Anthropic-compatible provider conformance", () => {
  it.each([
    {
      name: "Messages streaming",
      protocol: "messages" as const,
      expectedStreaming: "supported" as const,
      fixture: messagesStreamingFixture,
    },
    {
      name: "Auto protocol streaming",
      protocol: "auto" as const,
      expectedStreaming: "supported" as const,
      fixture: messagesStreamingFixture,
    },
  ])("passes successful, cancellation, and cleanup conformance for $name", async (profile) => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    let released = false;
    const fetch = profile.fixture();
    const driver = makeAnthropicCompatibleDriver({
      instanceId,
      configuration: configuration(profile.protocol),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      onConnectionReleased: () => {
        released = true;
      },
      clock: () => "2026-07-15T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000613",
    });

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-anthropic-conformance" },
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
        resumeCursor: { driverKind: "anthropic-compatible", value: "unsupported" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "anthropic-compatible", value: "stale" },
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
      acquireInput: { instanceId, projectRoot: "/tmp/octant-anthropic-conformance" },
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
    recordProviderConformanceEvidence("anthropic-compatible", evidence);
    recordProviderChatConformanceEvidence("anthropic-compatible", chatEvidence);

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

function configuration(protocol: AnthropicCompatibleProtocol) {
  return {
    kind: "anthropic-compatible-http" as const,
    baseUrl: "https://fixture.example/v1",
    authentication: "api-key" as const,
    protocol,
    protocolVersion: "2023-06-01",
    manualModelIds: [modelId],
  };
}

function messagesStreamingFixture(): AnthropicCompatibleFetch {
  let completed = false;
  return async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    if (!completed) {
      completed = true;
      return messagesStream("messages answer");
    }
    return hangingResponse(init?.signal ?? undefined);
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

function messagesStream(text: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture-model",
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    {
      type: "content_block_stop",
      index: 0,
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
    {
      type: "message_stop",
    },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

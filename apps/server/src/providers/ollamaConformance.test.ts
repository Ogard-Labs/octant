import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { describe, expect, it } from "vitest";
import { makeOllamaDriver } from "./ollamaDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import type { OllamaFetch } from "./ollamaEndpoint";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000721");
const interruptedSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000722");
const successfulSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000724");
const chatSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000725");
const modelId = "fixture-model" as ProviderModelId;

describe("Ollama provider conformance", () => {
  it("passes capability, streaming, resume, interruption, and cleanup conformance", async () => {
    const registry = new ProviderRuntimeRegistry();
    let chatRequests = 0;
    const fetch: OllamaFetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/version")) return Response.json({ version: "0.31.2" });
      if (url.endsWith("/tags")) {
        return Response.json({ models: [{ name: modelId, model: modelId }] });
      }
      if (url.endsWith("/show")) {
        return Response.json({
          capabilities: ["completion"],
          model_info: { "fixture.context_length": 32768 },
        });
      }
      if (!url.endsWith("/chat")) throw new Error(`Unexpected Ollama request: ${url}`);
      chatRequests += 1;
      return chatRequests === 1 ? completedChat() : hangingChat();
    };
    const driver = makeOllamaDriver({
      instanceId,
      configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
      runtimeRegistry: registry,
      fetch,
      clock: () => "2026-07-18T08:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000723",
    });

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: {
        instanceId,
        projectRoot: "/tmp/octant-ollama-conformance",
        mode: "code",
      },
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
        expectedStreaming: "supported",
        observed: () => registry.observedState(instanceId),
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
        resumeCursor: { driverKind: "ollama", value: interruptedSessionId },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "ollama", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: {
        sessionId: interruptedSessionId,
        requestId: "unknown",
        approved: false,
      },
      unknownUserInput: {
        sessionId: interruptedSessionId,
        requestId: "unknown",
        answer: "none",
      },
      expectedEventKinds: ["interrupted"],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "unsupported",
        unknownUserInput: "unsupported",
      },
      isReleased: () => registry.activeSessionCount(instanceId) === 0,
    });
    const chatEvidence = await runProviderChatConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: {
        instanceId,
        projectRoot: "/tmp/octant-ollama-conformance",
        mode: "code",
      },
      sessionStart: { sessionId: chatSessionId, modelId, executionPolicy: "approval-gated" },
      turn: {
        sessionId: chatSessionId,
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
      isReleased: () => registry.activeSessionCount(instanceId) === 0,
    });
    recordProviderConformanceEvidence("ollama", evidence);
    recordProviderChatConformanceEvidence("ollama", chatEvidence);

    expect(evidence).toEqual({
      probed: true,
      capabilityHonest: true,
      usageCapabilityHonest: true,
      researchCapabilityHonest: true,
      citationsCapabilityHonest: true,
      streamedInOrder: true,
      interrupted: true,
      resumed: true,
      staleResumeRejected: true,
      unknownApprovalRejected: true,
      unknownUserInputRejected: true,
      failureClassified: true,
      released: true,
    });
    expect(chatEvidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
  });
});

function completedChat(): Response {
  return new Response(
    `${JSON.stringify({
      model: modelId,
      message: { role: "assistant", content: "fixture answer" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 2,
    })}\n`,
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

function hangingChat(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {},
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type OpenAiCompatibleProtocol,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";
import { makeAzureFoundryDriver } from "./azureFoundryDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000621");
const interruptedSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000622");
const successfulSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000624");
const modelId = "deployment-fixture" as ProviderModelId;

describe("Azure AI Foundry provider conformance", () => {
  it("passes successful, cancellation, and cleanup conformance while reusing the OpenAI adapter", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    let released = false;
    const fetch = responsesFixture();
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      onConnectionReleased: () => {
        released = true;
      },
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000623",
    });

    expect(driver.kind).toBe("azure-foundry");

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-foundry-conformance" },
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
        resumeCursor: { driverKind: "azure-foundry", value: "unsupported" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId: interruptedSessionId,
        resumeCursor: { driverKind: "azure-foundry", value: "stale" },
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
      acquireInput: { instanceId, projectRoot: "/tmp/octant-foundry-conformance" },
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
    recordProviderConformanceEvidence("azure-foundry", evidence);
    recordProviderChatConformanceEvidence("azure-foundry", chatEvidence);

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

  it("authenticates with the documented api-key header and never sends Authorization Bearer", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn<CompatibleFetch>(async () => Response.json({ data: [{ id: modelId }] }));
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000625",
    });

    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));

    expect(fetch).toHaveBeenCalled();
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ "api-key": "fixture-secret" });
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i);
  });

  it("keeps Connection Check non-generating and reports tool support as unsupported by default", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn(toolProbeFixture());
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000626",
    });

    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    // Per the approved Foundry profile design, Connection Check is non-generating: the
    // probe only hits /models and does not send a tool-capability echo turn.
    // Tool support is verified per deployment on a separate capability path.
    expect(probe.capabilities.appManagedTools).toBe("unsupported");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("downgrades to degraded when /models returns no discovered deployments", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn<CompatibleFetch>(async (url) => {
      if (String(url).endsWith("/models")) {
        // /models returns an empty list (no discovered deployments)
        return Response.json({ data: [] });
      }
      return Response.json({ data: [{ id: modelId }] });
    });
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000626",
    });

    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe.readiness).toBe("degraded");
    expect(probe.message).toContain("returned no deployments");
  });

  it("downgrades to degraded when /models omits configured deployments but has models", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn<CompatibleFetch>(async (url) => {
      if (String(url).endsWith("/models")) {
        // /models returns a model that is NOT in the configured deployments
        return Response.json({ data: [{ id: "other-deployment" }] });
      }
      return Response.json({ data: [{ id: modelId }] });
    });
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000626",
    });

    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe.readiness).toBe("degraded");
    expect(probe.message).toContain("did not return all configured deployment IDs");
  });

  it("filters the catalog to only configured deployment IDs", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn<CompatibleFetch>(async (url) => {
      if (String(url).endsWith("/models")) {
        // /models returns the configured deployment plus an extra id
        return Response.json({ data: [{ id: modelId }, { id: "extra-deployment" }] });
      }
      return Response.json({ data: [{ id: modelId }] });
    });
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000626",
    });

    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(probe.readiness).toBe("ready");
    expect(probe.models.map((model) => String(model.id))).toEqual([String(modelId)]);
  });

  it("verifies tool support on demand via verifyToolCapability", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = toolProbeFixture();
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000626",
    });

    const result = await Effect.runPromise(
      Effect.scoped(driver.verifyToolCapability!({ instanceId, modelId })),
    );
    expect(result.appManagedTools).toBe("supported");
    expect(result.modelId).toBe(modelId);
  });

  it("propagates transport failures from verifyToolCapability instead of returning unsupported", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn<CompatibleFetch>(async () =>
      Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    );
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("responses"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000626",
    });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(driver.verifyToolCapability!({ instanceId, modelId })),
    );
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
      expect(failure).toMatchObject({ category: "unauthenticated" });
    } else {
      throw new Error("Expected verifyToolCapability to fail for a 401 response");
    }
  });

  it("falls back to chat-completions for verifyToolCapability when /responses returns 404", async () => {
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const fetch = vi.fn<CompatibleFetch>(async (url) => {
      if (String(url).endsWith("/models")) return models();
      const path = String(url);
      if (path.includes("/responses")) {
        // Endpoint only implements /chat/completions; /responses returns 404.
        return Response.json({ error: { message: "Not found" } }, { status: 404 });
      }
      // /chat/completions supports tool calls.
      return chatCompletionsToolCallStream();
    });
    const driver = makeAzureFoundryDriver({
      instanceId,
      configuration: configuration("auto"),
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "fixture-secret" },
      fetch,
      clock: () => "2026-07-19T12:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000626",
    });

    const result = await Effect.runPromise(
      Effect.scoped(driver.verifyToolCapability!({ instanceId, modelId })),
    );
    expect(result.appManagedTools).toBe("supported");
  });
});

function configuration(protocol: OpenAiCompatibleProtocol) {
  return {
    kind: "azure-foundry-openai-http" as const,
    baseUrl: "https://foundry.fixture.openai.azure.com/openai/v1/",
    authentication: "api-key" as const,
    protocol,
    manualModelIds: [modelId],
  };
}

function responsesFixture(): CompatibleFetch {
  let completed = 0;
  return async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body)) as { input?: { content?: string }[] };
    const isProbe = body.input?.some((item) => item.content === "echo ready") ?? false;
    if (isProbe) return responsesTextStream("probe ok");
    completed += 1;
    if (completed === 2) return hangingResponse(init?.signal ?? undefined);
    return responsesTextStream("responses answer");
  };
}

function toolProbeFixture(): CompatibleFetch {
  return async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body)) as {
      input?: { content?: string }[];
      tools?: unknown[];
    };
    const isProbe = body.input?.some((item) => item.content === "echo ready") ?? false;
    if (isProbe && body.tools !== undefined && body.tools.length > 0) {
      return responsesToolCallStream();
    }
    return responsesTextStream("probe ok");
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

function responsesToolCallStream(): Response {
  const callItem = (status: "in_progress" | "completed") => ({
    id: "fc_fixture",
    type: "function_call",
    status,
    call_id: "call_fixture",
    name: "octant_capability_echo",
    arguments: status === "completed" ? "{}" : "",
  });
  const events = [
    {
      type: "response.created",
      sequence_number: 1,
      response: {
        id: "resp_fixture",
        object: "response",
        status: "in_progress",
        usage: null,
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: callItem("in_progress"),
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      item_id: "fc_fixture",
      output_index: 0,
      delta: "{}",
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 4,
      item_id: "fc_fixture",
      output_index: 0,
      arguments: "{}",
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: callItem("completed"),
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: {
        id: "resp_fixture",
        object: "response",
        status: "completed",
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        output: [callItem("completed")],
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function chatCompletionsToolCallStream(): Response {
  const chunks = [
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_fixture",
                type: "function",
                function: { name: "octant_capability_echo", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: null,
    },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null }],
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
  const body = chunks
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

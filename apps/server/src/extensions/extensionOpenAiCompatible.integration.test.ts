import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderModelId,
} from "@octant/contracts";
import {
  resolveDraftExtensionReference,
  type ExtensionAddressingCatalog,
} from "@octant/plugin-host";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  deriveCatalogEpoch,
  type CapabilityActiveScope,
  type CapabilityCatalogEntry,
  type CapabilitySelectionRequest,
} from "../context/capabilityCatalog";
import { makeOpenAiCompatibleDriver } from "../providers/openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";

const providerInstanceId = decodeProviderInstanceId("91000000-0000-4000-8000-000000000001");
const providerSessionId = decodeProviderSessionId("91000000-0000-4000-8000-000000000002");
const modelId = "generic-model" as ProviderModelId;
const extensionId = "92000000-0000-4000-8000-000000000001";
const packageId = "92500000-0000-4000-8000-000000000001";
const digest = `sha256:${"c".repeat(64)}`;
const catalogEpoch = `sha256:${"d".repeat(64)}`;
const instructionCapabilityId = "93000000-0000-4000-8000-000000000001";
const toolCapabilityId = "93000000-0000-4000-8000-000000000002";
const encoder = new TextEncoder();

const activeScope: CapabilityActiveScope = {
  mode: { referenceId: "mode:chat", revision: 1 },
  project: { referenceId: "project:generic", revision: 1 },
  host: { referenceId: "host:local", revision: 1 },
  model: { referenceId: `model:${modelId}`, revision: 1 },
};

function capability(
  id: string,
  componentKind: "plugin-instruction" | "mcp-tool",
): CapabilityCatalogEntry {
  return {
    id,
    source: {
      kind: "plugin-package",
      referenceId: `extension:${extensionId}:${packageId}`,
      packageId,
      componentId: "server",
    },
    componentKind,
    label: id === instructionCapabilityId ? "Generic provider guidance" : "Build project",
    schemaCost: { kind: "known", tokens: 12, accuracy: "exact-tokenizer" },
    availability: "available",
    trust: "trusted",
    enablement: "enabled",
    policy: "allowed",
    providerEligibility: {
      providerInstanceId,
      status: "eligible",
      reason: "selected-provider",
    },
    scopeEligibility: {
      mode: { ...activeScope.mode, status: "eligible" },
      project: { ...activeScope.project, status: "eligible" },
      host: { ...activeScope.host, status: "eligible" },
      model: { ...activeScope.model, status: "eligible" },
    },
    posture: "optional",
    selectionMode: "explicit",
    taskKeywords: [],
    epoch: 1,
    invalidationFacts: [],
  };
}

describe("structured extensions on the Generic OpenAI-compatible provider", () => {
  it("revalidates a provider handoff and sends only selected context and tools through the real driver", async () => {
    const entries = [
      capability(instructionCapabilityId, "plugin-instruction"),
      capability(toolCapabilityId, "mcp-tool"),
    ];
    const capabilityCatalog = {
      entries,
      epoch: deriveCatalogEpoch({
        entries,
        activeFacts: { providerInstanceId, activeScope },
        invalidationFacts: [],
      }),
    };
    const addressingCatalog: ExtensionAddressingCatalog = {
      epoch: catalogEpoch as never,
      plugins: [
        {
          extensionId: extensionId as never,
          packageId: packageId as never,
          slug: "generic-build" as never,
          packageVersion: "1.0.0" as never,
          packageDigest: digest as never,
          primaryComponentId: "server" as never,
          components: [
            {
              componentId: "server" as never,
              label: "Generic build server",
              effectiveState: { kind: "effective" },
              capabilityIds: [instructionCapabilityId, toolCapabilityId],
            },
          ],
        },
      ],
      skills: [],
    };
    const draft = resolveDraftExtensionReference("@generic-build/server", addressingCatalog, "d1");
    if (draft.kind !== "selected") throw new Error("Expected a structured plugin selection.");
    const capabilityRequest: CapabilitySelectionRequest = {
      providerInstanceId,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    };
    const composed = await composeSelectedExtensionCapabilities({
      phase: "provider-handoff",
      selections: [draft.selection],
      addressingCatalog,
      authoritativeCatalogEpoch: catalogEpoch as never,
      capabilityCatalog,
      capabilityRequest,
      loadMaterial: async (entry) => ({
        ...(entry.id === instructionCapabilityId
          ? {
              context: {
                kind: "instructions" as const,
                text: "Use the selected Generic OpenAI-compatible build guidance.",
              },
            }
          : {}),
        tools:
          entry.id === toolCapabilityId
            ? [
                {
                  name: "build_project",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
              ]
            : [],
      }),
    });
    expect(composed.status).toBe("selected");
    if (composed.status !== "selected") throw new Error("Expected selected capabilities.");

    const requestBodies: unknown[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: modelId }] });
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return chatStream("generic provider answer");
    });
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const configuration: OpenAiCompatibleProviderConfiguration = {
      kind: "openai-compatible-http",
      baseUrl: "https://generic-provider.example/v1",
      authentication: "bearer",
      protocol: "chat-completions",
      manualModelIds: [modelId],
    };
    const driver = makeOpenAiCompatibleDriver({
      instanceId: providerInstanceId,
      configuration,
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "private-key" },
      fetch,
      clock: () => "2026-07-29T00:00:00.000Z",
      correlationId: () => "91000000-0000-4000-8000-000000000003",
    });
    const observed = await Effect.runPromise(
      Effect.scoped(driver.probe({ instanceId: providerInstanceId })),
    );
    runtimeRegistry.setObservedState({
      ...observed,
      capabilities: { ...observed.capabilities, appManagedTools: "supported" },
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({
            instanceId: providerInstanceId,
            projectRoot: "/tmp/octant-generic-provider",
          });
          yield* connection.start({
            sessionId: providerSessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          const terminal = yield* Effect.fork(
            Stream.runCollect(
              connection.events.pipe(
                Stream.filter((event) => event.sessionId === providerSessionId),
                Stream.takeUntil(
                  (event) =>
                    event.kind === "completed" ||
                    event.kind === "interrupted" ||
                    event.kind === "failed",
                ),
              ),
            ),
          );
          yield* connection.send({
            sessionId: providerSessionId,
            prompt: "Build with the selected extension",
            context: composed.providerContext,
            attachments: [],
            tools: composed.tools,
          });
          expect(Array.from(yield* Fiber.join(terminal)).at(-1)?.kind).toBe("completed");
          yield* connection.stop(providerSessionId);
        }),
      ),
    );

    expect(requestBodies).toHaveLength(1);
    expect(JSON.stringify(requestBodies[0])).toContain(
      "Use the selected Generic OpenAI-compatible build guidance.",
    );
    expect(requestBodies[0]).toMatchObject({
      tools: [{ type: "function", function: { name: "build_project" } }],
    });
  });
});

function chatStream(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl_generic",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl_generic",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    "[DONE]",
  ];
  const body = chunks
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
    .join("");
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

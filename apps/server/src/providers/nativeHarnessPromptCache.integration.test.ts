import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeAnthropicCompatibleDriver } from "./anthropicCompatibleDriver";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { capabilityEchoToolDefinition } from "./openAiToolEncoding";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import { nativeHarnessInstructions } from "../harness/nativeHarnessInstructions";

/**
 * Real-endpoint proof that the harness keeps a prompt cache warm across the
 * steps of one tool turn (decision 0067). Opt-in: set the smoke flag and the
 * credentials for the endpoint, or the case is skipped — missing credentials
 * remain a named blocker, never a false pass. Every request after the first
 * must report cache-read tokens covering the prefix the first request sent.
 */
const openAiLive = process.env.OCTANT_OPENAI_COMPATIBLE_SMOKE === "1" ? it : it.skip;
const anthropicLive = process.env.OCTANT_ANTHROPIC_COMPATIBLE_SMOKE === "1" ? it : it.skip;

const TOOL_TURN_PROMPT =
  'Run a three-step tool turn. First call octant_capability_echo with echo "one". ' +
  'After its result arrives, call octant_capability_echo again with echo "two". ' +
  'After that result arrives, call it a third time with echo "three". ' +
  "Only after the third result arrives, reply with exactly: cache-warm.";

describe("native harness prompt cache across a tool turn", () => {
  openAiLive(
    "reads the earlier steps of a three-step tool turn from an OpenAI-compatible cache",
    async () => {
      const baseUrl = required("OCTANT_OPENAI_COMPATIBLE_BASE_URL");
      const apiKey = required("OCTANT_OPENAI_COMPATIBLE_API_KEY");
      const model = required("OCTANT_OPENAI_COMPATIBLE_MODEL") as ProviderModelId;
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000701");
      const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000702");
      const driver = makeOpenAiCompatibleDriver({
        instanceId,
        configuration: {
          kind: "openai-compatible-http",
          baseUrl,
          authentication: "bearer",
          protocol: "responses",
          manualModelIds: [model],
        },
        runtimeRegistry: new ProviderRuntimeRegistry(),
        credentialResolver: { has: async () => true, resolve: async () => apiKey },
      });
      // The OpenAI-compatible driver gates tools on a verified model; a real
      // verification turn flips that before the cache turn is admitted.
      if (driver.verifyToolCapability !== undefined) {
        await Effect.runPromise(
          Effect.scoped(driver.verifyToolCapability({ instanceId, modelId: model })),
        );
      }
      const events = await runThreeStepToolTurn({ driver, instanceId, sessionId, modelId: model });
      assertCacheWarm(events);
    },
  );

  anthropicLive(
    "reads the earlier steps of a three-step tool turn from an Anthropic-compatible cache",
    async () => {
      const baseUrl = required("OCTANT_ANTHROPIC_COMPATIBLE_BASE_URL");
      const apiKey = required("OCTANT_ANTHROPIC_COMPATIBLE_API_KEY");
      const model = required("OCTANT_ANTHROPIC_COMPATIBLE_MODEL") as ProviderModelId;
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000703");
      const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000704");
      const driver = makeAnthropicCompatibleDriver({
        instanceId,
        configuration: {
          kind: "anthropic-compatible-http",
          baseUrl,
          authentication: "api-key",
          protocol: "messages",
          protocolVersion: "2023-06-01",
          manualModelIds: [model],
        },
        runtimeRegistry: new ProviderRuntimeRegistry(),
        credentialResolver: { has: async () => true, resolve: async () => apiKey },
      });
      const events = await runThreeStepToolTurn({ driver, instanceId, sessionId, modelId: model });
      assertCacheWarm(events);
    },
  );
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`The warm-cache live run requires ${name}; no credential values are logged.`);
  }
  return value;
}

/**
 * Drives one turn whose prompt makes the model call the echo tool three times,
 * answering each call locally so the loop sends the following request with the
 * earlier steps as its prefix.
 */
async function runThreeStepToolTurn(input: {
  readonly driver: ProviderDriver;
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
}): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
  const projectRoot = mkdtempSync(join(tmpdir(), "octant-cache-warm-"));
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* input.driver.acquire({
            instanceId: input.instanceId,
            projectRoot,
          });
          yield* connection.start({
            sessionId: input.sessionId,
            modelId: input.modelId,
            executionPolicy: "approval-gated",
          });
          const observed: ProviderRuntimeEvent[] = [];
          const collector = yield* Effect.fork(
            (yield* connection.subscribe).pipe(
              Stream.filter((event) => event.sessionId === input.sessionId),
              Stream.takeUntil(
                (event) =>
                  event.kind === "completed" ||
                  event.kind === "failed" ||
                  event.kind === "interrupted",
              ),
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  observed.push(event);
                  if (event.kind === "tool-request") {
                    yield* connection.answerTool({
                      sessionId: input.sessionId,
                      requestId: event.requestId,
                      resultJson: JSON.stringify({ echo: "acknowledged" }),
                      isError: false,
                    });
                  }
                }),
              ),
            ),
          );
          yield* connection.send({
            sessionId: input.sessionId,
            prompt: TOOL_TURN_PROMPT,
            context: nativeHarnessInstructions("chat"),
            attachments: [],
            tools: [capabilityEchoToolDefinition()],
          });
          yield* Fiber.join(collector);
          yield* connection.stop(input.sessionId);
          return observed;
        }),
      ),
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function assertCacheWarm(events: ReadonlyArray<ProviderRuntimeEvent>): void {
  expect(events.at(-1)?.kind).toBe("completed");
  const usage = events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { readonly kind: "usage" }> =>
      event.kind === "usage",
  );
  expect(events.filter((event) => event.kind === "tool-request").length).toBeGreaterThanOrEqual(2);
  expect(usage.length).toBeGreaterThanOrEqual(3);
  const first = usage[0];
  // Every request after the first reports cache reads, and the reads cover at
  // least the whole prefix the first request sent, not merely a token or two.
  for (const step of usage.slice(1)) {
    expect(step.cacheReadInputTokens ?? 0).toBeGreaterThan(0);
  }
  expect(usage.at(-1)?.cacheReadInputTokens ?? 0).toBeGreaterThanOrEqual(first?.inputTokens ?? 0);
}

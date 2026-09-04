import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type OpenAiCompatibleProtocol,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@octant/contracts";
import { Effect, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeOpenAiCompatibleDriver } from "./openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const smoke = process.env.OCTANT_BEDROCK_MANTLE_SMOKE === "1" ? it : it.skip;

/**
 * Real Bedrock Mantle endpoint smoke.
 *
 * Bedrock Mantle is represented as a configured OpenAI-compatible provider
 * using the documented regional /v1 base URL and a Bedrock API key. This
 * smoke reuses the OpenAI-compatible driver — there is no separate Bedrock
 * wire driver in the technical preview.
 *
 * Opt-in: set OCTANT_BEDROCK_MANTLE_SMOKE=1 plus the required environment
 * variables to exercise a real Bedrock Mantle endpoint. When credentials are
 * absent, this smoke is skipped — missing credentials remain an explicit
 * non-passing gate, never a false pass.
 */
describe("real Bedrock Mantle endpoint (generic OpenAI-compatible)", () => {
  smoke(
    "discovers models and completes a Responses stream without production env fallback",
    async () => {
      const baseUrl = required("OCTANT_BEDROCK_MANTLE_BASE_URL");
      const apiKey = required("OCTANT_BEDROCK_MANTLE_API_KEY");
      const model = required("OCTANT_BEDROCK_MANTLE_MODEL") as ProviderModelId;
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000911");
      const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000912");
      const cancelSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000913");
      const runtimeRegistry = new ProviderRuntimeRegistry();
      let connectionReleased = false;
      let credentialResolutions = 0;
      const driver = makeOpenAiCompatibleDriver({
        instanceId,
        configuration: configuration(baseUrl, model),
        runtimeRegistry,
        credentialResolver: {
          has: async () => true,
          resolve: async () => {
            credentialResolutions += 1;
            return apiKey;
          },
        },
        onConnectionReleased: () => {
          connectionReleased = true;
        },
      });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const probe = yield* driver.probe({ instanceId });
            expect(probe.models.length).toBeGreaterThan(0);
            const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp" });
            yield* connection.start({
              sessionId,
              modelId: model,
              executionPolicy: "approval-gated",
            });
            const events = yield* Effect.fork(
              collectSessionEvents(yield* connection.subscribe, sessionId),
            );
            yield* connection.send({
              sessionId,
              prompt: "Reply with exactly: octant-bedrock-mantle-smoke",
              attachments: [],
              tools: [],
            });
            const normalized = Array.from(yield* Fiber.join(events));
            expect(normalized.filter(({ kind }) => kind === "text-delta").length).toBeGreaterThan(
              1,
            );
            expect(normalized.some(({ kind }) => kind === "usage")).toBe(true);
            expect(normalized.at(-1)?.kind).toBe("completed");
            for (const usage of normalized.filter((event) => event.kind === "usage")) {
              expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
              expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
            }
            expect(JSON.stringify(normalized)).not.toContain(apiKey);
            yield* connection.stop(sessionId);

            yield* connection.start({
              sessionId: cancelSessionId,
              modelId: model,
              executionPolicy: "approval-gated",
            });
            const interrupted = yield* Effect.fork(
              collectSessionEvents(yield* connection.subscribe, cancelSessionId),
            );
            const acceptedOutput = yield* Effect.fork(
              Stream.runHead(
                (yield* connection.subscribe).pipe(
                  Stream.filter(
                    (event) => event.sessionId === cancelSessionId && event.kind === "text-delta",
                  ),
                ),
              ),
            );
            yield* connection.send({
              sessionId: cancelSessionId,
              prompt: "Produce a detailed response with at least 2000 words.",
              attachments: [],
              tools: [],
            });
            expect(Option.isSome(yield* Fiber.join(acceptedOutput))).toBe(true);
            yield* connection.interrupt(cancelSessionId);
            const cancelled = Array.from(yield* Fiber.join(interrupted));
            expect(cancelled.at(-1)?.kind).toBe("interrupted");
            expect(JSON.stringify(cancelled)).not.toContain(apiKey);

            yield* connection.start({
              sessionId: cancelSessionId,
              modelId: model,
              executionPolicy: "approval-gated",
            });
            yield* connection.stop(cancelSessionId);
          }),
        ),
      );
      expect(runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
      expect(connectionReleased).toBe(true);
      expect(credentialResolutions).toBeGreaterThanOrEqual(4);
    },
  );
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Bedrock Mantle smoke requires ${name}; no credential values are logged.`);
  }
  return value;
}

function collectSessionEvents(
  events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
  sessionId: ProviderSessionId,
) {
  return Stream.runCollect(
    events.pipe(
      Stream.filter((event) => event.sessionId === sessionId),
      Stream.takeUntil(
        (event) =>
          event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed",
      ),
    ),
  );
}

function configuration(baseUrl: string, model: ProviderModelId) {
  return {
    kind: "openai-compatible-http" as const,
    baseUrl,
    authentication: "bearer" as const,
    protocol: "responses" as const satisfies OpenAiCompatibleProtocol,
    manualModelIds: [model],
  };
}

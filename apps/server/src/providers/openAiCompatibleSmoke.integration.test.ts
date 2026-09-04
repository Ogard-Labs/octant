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

const smoke = process.env.OCTANT_OPENAI_COMPATIBLE_SMOKE === "1" ? it : it.skip;

describe("real OpenAI-compatible endpoint", () => {
  smoke(
    "discovers models and completes both protocol streams without production env fallback",
    async () => {
      const baseUrl = required("OCTANT_OPENAI_COMPATIBLE_BASE_URL");
      const apiKey = required("OCTANT_OPENAI_COMPATIBLE_API_KEY");
      const model = required("OCTANT_OPENAI_COMPATIBLE_MODEL") as ProviderModelId;
      for (const [index, protocol] of (["responses", "chat-completions"] as const).entries()) {
        const instanceId = decodeProviderInstanceId(`80000000-0000-4000-8000-00000000052${index}`);
        const sessionId = decodeProviderSessionId(`80000000-0000-4000-8000-00000000053${index}`);
        const runtimeRegistry = new ProviderRuntimeRegistry();
        let connectionReleased = false;
        let credentialResolutions = 0;
        const driver = makeOpenAiCompatibleDriver({
          instanceId,
          configuration: configuration(baseUrl, model, protocol),
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
                prompt: "Reply with exactly: octant-smoke",
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

              const cancelSessionId = decodeProviderSessionId(
                `80000000-0000-4000-8000-00000000054${index}`,
              );
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
        expect(credentialResolutions).toBe(4);
      }
    },
  );
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`OpenAI-compatible smoke requires ${name}; no credential values are logged.`);
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

function configuration(
  baseUrl: string,
  model: ProviderModelId,
  protocol: OpenAiCompatibleProtocol,
) {
  return {
    kind: "openai-compatible-http" as const,
    baseUrl,
    authentication: "bearer" as const,
    protocol,
    manualModelIds: [model],
  };
}

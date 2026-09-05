import type { ProviderInstanceId, ProviderModelId, ProviderSessionId } from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream } from "effect";
import { subscribeThenSend } from "../providers/providerEventDelivery";

const MAX_TEXT_CHARACTERS = 16_384;

/**
 * One prompt, one reply, no tools. Used for the advisor's review and other
 * meta work the harness routes to a small slot: acquire, send, collect the
 * text until the provider's terminal event, stop.
 */
export async function completeOnce(input: {
  readonly driver: ProviderDriver;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly sessionId: ProviderSessionId;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly instructions?: string;
  readonly timeoutMs: number;
}): Promise<string | undefined> {
  const program = Effect.gen(function* () {
    const connection = yield* input.driver.acquire({
      instanceId: input.providerInstanceId,
      projectRoot: input.projectRoot,
      mode: "chat",
    });
    yield* Effect.addFinalizer(() =>
      connection.stop(input.sessionId).pipe(Effect.catchAll(() => Effect.void)),
    );
    yield* connection.start({
      sessionId: input.sessionId,
      modelId: input.modelId,
      executionPolicy: "approval-gated",
    });
    let text = "";
    let completed = false;
    const collected = yield* subscribeThenSend({
      connection,
      consume: (events) =>
        events.pipe(
          Stream.filter((event) => event.sessionId === input.sessionId),
          Stream.takeUntil(
            (event) =>
              event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted",
          ),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.kind === "text-delta" && text.length < MAX_TEXT_CHARACTERS) {
                text += event.text;
              }
              if (event.kind === "completed") completed = true;
            }),
          ),
        ),
      send: connection.send({
        sessionId: input.sessionId,
        prompt: input.prompt,
        context:
          input.instructions === undefined
            ? []
            : [{ kind: "instructions", text: input.instructions }],
        attachments: [],
        tools: [],
      }),
    });
    yield* Fiber.join(collected);
    return completed ? text : undefined;
  });
  try {
    return await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.timeoutTo({
          duration: input.timeoutMs,
          onTimeout: () => undefined,
          onSuccess: (value: string | undefined) => value,
        }),
      ),
    );
  } catch {
    return undefined;
  }
}

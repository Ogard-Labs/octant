import type {
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
  ProviderSessionId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream } from "effect";
import { subscribeThenSend } from "../providers/providerEventDelivery";

const MAX_TEXT_CHARACTERS = 16_384;

/**
 * How a one-shot request ended. A provider failure keeps its classification
 * so a caller that routes by slot can step around the model that failed;
 * `withheld` is a reply the caller must not use (it read outside content),
 * and `unreached` is a request that never got an answer (the connection could
 * not be made or broke).
 */
export type OneShotOutcome =
  | { readonly status: "completed"; readonly text: string }
  | { readonly status: "withheld" }
  | { readonly status: "interrupted" }
  | { readonly status: "timed-out" }
  | { readonly status: "unreached" }
  | { readonly status: "failed"; readonly failure: ProviderFailure };

/**
 * One prompt, one reply, no tools. Used for the advisor's review and other
 * meta work the harness routes to a small slot: acquire, send, collect the
 * text until the provider's terminal event, stop.
 */
export async function completeOnce(input: OneShotInput): Promise<string | undefined> {
  const outcome = await completeOnceOutcome(input);
  return outcome.status === "completed" ? outcome.text : undefined;
}

export interface OneShotInput {
  readonly driver: ProviderDriver;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly sessionId: ProviderSessionId;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly instructions?: string;
  readonly timeoutMs: number;
}

export async function completeOnceOutcome(input: OneShotInput): Promise<OneShotOutcome> {
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
    let interrupted = false;
    let failure: ProviderFailure | undefined;
    // An answer steered by a page the runtime read would reach a thread with
    // no mark to say so, and nothing here can mark one, so it is not used.
    let readOutsideContent = false;
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
              if (event.kind === "interrupted") interrupted = true;
              if (event.kind === "failed") failure = event.failure;
              if (event.kind === "outside-content-read") readOutsideContent = true;
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
    if (failure !== undefined) return { status: "failed", failure } as const;
    if (interrupted) return { status: "interrupted" } as const;
    if (!completed) return { status: "unreached" } as const;
    return readOutsideContent
      ? ({ status: "withheld" } as const)
      : ({ status: "completed", text } as const);
  });
  try {
    return await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.timeoutTo({
          duration: input.timeoutMs,
          onTimeout: (): OneShotOutcome => ({ status: "timed-out" }),
          onSuccess: (value: OneShotOutcome) => value,
        }),
      ),
    );
  } catch {
    return { status: "unreached" };
  }
}

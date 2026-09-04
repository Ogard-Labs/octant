import type {
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
  ProviderRuntimeEvent,
} from "@octant/contracts";
import { decodeProviderSessionId } from "@octant/contracts/providers";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream, type Scope } from "effect";
import { subscribeThenSend } from "./providers/providerEventDelivery";
import type { ThreadHandOffProviderPort } from "./threadHandOffService";

/** Text deltas a document may arrive in; a provider that streams more is cut off, not trusted. */
const MAX_EVENTS = 8_192;
const SHUTDOWN_TIMEOUT_MS = 3_000;

export class ThreadHandOffCompletionFailed extends Error {
  override readonly name = "ThreadHandOffCompletionFailed";
}

export interface ThreadHandOffCompletionOptions {
  /** The enabled driver for an instance, or nothing when the host cannot run it. */
  readonly resolveDriver: (providerInstanceId: ProviderInstanceId) => ProviderDriver | undefined;
  /** A private, empty root the request runs in; a hand-off reads the transcript, not a folder. */
  readonly scratchRoot: (threadId: string) => string;
  readonly uuid: () => string;
}

/**
 * One bounded, tool-free, read-only request to the thread's own provider.
 *
 * The session is a fresh one on the thread's provider and model — the same
 * mechanics context maintenance uses — so the document is written by the
 * model the person was already talking to, with no tools and no authority
 * over the thread's workspace. Whatever the scope acquired is released when
 * the caller's deadline interrupts it.
 */
export function makeThreadHandOffCompletion(
  options: ThreadHandOffCompletionOptions,
): ThreadHandOffProviderPort["complete"] {
  return async (input) => {
    const driver = options.resolveDriver(input.providerInstanceId);
    if (driver === undefined) {
      throw new ThreadHandOffCompletionFailed("The thread's provider cannot be started.");
    }
    const sessionId = decodeProviderSessionId(options.uuid());
    const state: CompletionState = { text: "", handled: 0, terminal: undefined };
    const run = Effect.scoped(
      runCompletion(driver, {
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
        mode: input.mode,
        projectRoot: options.scratchRoot(input.threadId),
        sessionId,
        prompt: input.prompt,
        state,
      }),
    );
    return await Effect.runPromise(run, { signal: input.signal }).catch((error: unknown) => {
      throw error instanceof ThreadHandOffCompletionFailed
        ? error
        : new ThreadHandOffCompletionFailed("The hand-off request failed.");
    });
  };
}

interface CompletionState {
  text: string;
  handled: number;
  terminal: ProviderRuntimeEvent | undefined;
}

function runCompletion(
  driver: ProviderDriver,
  input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly mode: "chat" | "work" | "code";
    readonly projectRoot: string;
    readonly sessionId: ReturnType<typeof decodeProviderSessionId>;
    readonly prompt: string;
    readonly state: CompletionState;
  },
): Effect.Effect<string, ProviderFailure | ThreadHandOffCompletionFailed, Scope.Scope> {
  const { state } = input;
  return Effect.gen(function* () {
    const connection = yield* driver.acquire({
      instanceId: input.providerInstanceId,
      projectRoot: input.projectRoot,
      mode: input.mode,
    });
    yield* Effect.addFinalizer(() => stopSession(connection, input.sessionId));
    yield* connection.start({
      sessionId: input.sessionId,
      modelId: input.modelId,
      executionPolicy: "plan",
    });
    const events = yield* subscribeThenSend({
      connection,
      consume: (runtimeEvents) =>
        runtimeEvents.pipe(
          Stream.filter((event) => event.sessionId === input.sessionId),
          Stream.take(MAX_EVENTS + 1),
          Stream.takeUntil(isTerminal),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              state.handled += 1;
              if (state.handled > MAX_EVENTS) return;
              if (event.kind === "text-delta") state.text += event.text;
              if (isTerminal(event)) state.terminal = event;
            }),
          ),
        ),
      send: connection.send({
        sessionId: input.sessionId,
        prompt: input.prompt,
        context: [],
        attachments: [],
        tools: [],
      }),
    });
    yield* Fiber.join(events);
    if (state.terminal?.kind !== "completed" || state.text.trim().length === 0) {
      return yield* Effect.fail(
        new ThreadHandOffCompletionFailed("The provider did not finish a hand-off document."),
      );
    }
    return state.text.trim();
  });
}

function stopSession(
  connection: ProviderConnection,
  sessionId: ReturnType<typeof decodeProviderSessionId>,
): Effect.Effect<void> {
  return connection.stop(sessionId).pipe(
    Effect.interruptible,
    Effect.timeout(SHUTDOWN_TIMEOUT_MS),
    Effect.catchAll(() => Effect.void),
  );
}

function isTerminal(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "waiting" ||
    event.kind === "completed" ||
    event.kind === "interrupted" ||
    event.kind === "failed"
  );
}

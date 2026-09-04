import type {
  ProviderFailure,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSessionId,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream, type Scope } from "effect";
import { subscribeThenSend } from "../providers/providerEventDelivery";
import type {
  ContextMaintenanceMaterial,
  GenerateContextSummaryRequest,
  GeneratedContextSummary,
} from "./contextMaintenancePort";

const MAX_EVENTS = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * How long teardown may wait for the maintenance provider to confirm it ended
 * the session.
 *
 * Teardown is one local control-channel call, not a request, and the user's
 * send is queued behind it, so it is bounded an order of magnitude below the
 * request deadline: maintenance is best-effort, and a provider that has not
 * answered a stop in this long is not about to.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * The maintenance model is asked for continuation material, not for a reply to
 * the user. Keeping the instruction fixed also keeps the request's prompt
 * prefix stable across turns, which is what makes it cacheable.
 */
const SUMMARY_INSTRUCTION = [
  "Summarize the conversation excerpts below so a later turn can continue the",
  "same conversation without them. Preserve decisions, commitments, open",
  "questions, names, and identifiers. Do not answer anything, do not add",
  "commentary, and do not invent detail that is not present.",
].join(" ");

export class ContextSummaryGenerationFailed extends Error {
  override readonly name = "ContextSummaryGenerationFailed";
}

export interface ContextSummaryGeneratorOptions {
  readonly driver: ProviderDriver;
  readonly providerInstanceId: ProviderInstanceId;
  readonly scratchRoot: string;
  readonly sessionId: ProviderSessionId;
  readonly mode: "chat" | "work" | "code";
  /**
   * Receives the provider's own usage report for the maintenance request, so
   * the caller can reconcile the capacity it reserved against what was really
   * spent instead of leaving the reservation ambiguous.
   */
  readonly observeUsage?: (usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  }) => void;
  readonly timeoutMs?: number;
  /** Bound on the teardown attempt; see {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
  readonly shutdownTimeoutMs?: number;
}

/**
 * Runs one bounded, tool-free provider request that turns the material the
 * planner had to drop into a summary a later turn can carry instead.
 *
 * It deliberately reuses the caller's existing scratch root and provider
 * driver rather than owning either: maintenance is a child of the turn that
 * triggered it, and it must not acquire authority the turn does not have.
 */
export function makeContextSummaryGenerator(
  options: ContextSummaryGeneratorOptions,
): (
  request: GenerateContextSummaryRequest,
  signal: AbortSignal,
) => Promise<GeneratedContextSummary> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (request, signal) => {
    if (signal.aborted) throw new ContextSummaryGenerationFailed("Context maintenance cancelled.");
    if (request.providerInstanceId !== options.providerInstanceId) {
      throw new ContextSummaryGenerationFailed(
        "Context maintenance may not route to another provider instance.",
      );
    }
    const state: SummaryTurnState = {
      summary: "",
      handled: 0,
      terminal: undefined,
      outputTokens: undefined,
    };
    const content = await Effect.runPromise(
      // The deadline covers the whole scoped operation — acquisition, startup,
      // the send, and collection — because the turn awaits this before it
      // dispatches the user's own message. A collection-only deadline never
      // fires for a provider that wedges before it emits anything, so the send
      // would wait on it forever. Whatever the scope acquired is released when
      // the deadline interrupts it, so an expired request stops its connection
      // instead of leaving one running against the turn.
      Effect.scoped(
        runSummaryTurn(options, request, state).pipe(
          Effect.timeoutFail({
            duration: timeoutMs,
            onTimeout: () =>
              new ContextSummaryGenerationFailed(
                "The maintenance model did not answer within its deadline.",
              ),
          }),
        ),
      ),
    ).catch((error: unknown) => {
      throw error instanceof ContextSummaryGenerationFailed
        ? error
        : new ContextSummaryGenerationFailed("Context maintenance request failed.");
    });
    return {
      content,
      summaryTokens:
        state.outputTokens === undefined
          ? {
              kind: "known",
              tokens: Math.ceil(content.length / 4),
              accuracy: "conservative-heuristic",
            }
          : { kind: "known", tokens: state.outputTokens, accuracy: "provider-reported" },
    };
  };
}

interface SummaryTurnState {
  summary: string;
  handled: number;
  terminal: ProviderRuntimeEvent | undefined;
  /** The provider's own output count, when it reported one. */
  outputTokens: number | undefined;
}

/**
 * Acquires the maintenance provider, asks it for the summary, and collects the
 * answer.
 *
 * Every resource lands on the caller's scope — the connection's shutdown is
 * registered the moment it exists — so a deadline that interrupts this still
 * ends whatever it managed to acquire.
 */
function runSummaryTurn(
  options: ContextSummaryGeneratorOptions,
  request: GenerateContextSummaryRequest,
  state: SummaryTurnState,
): Effect.Effect<string, ProviderFailure | ContextSummaryGenerationFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const connection = yield* options.driver.acquire({
      instanceId: options.providerInstanceId,
      projectRoot: options.scratchRoot,
      mode: options.mode,
    });
    yield* Effect.addFinalizer(() =>
      stopMaintenanceSession(
        connection,
        options.sessionId,
        options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      ),
    );
    yield* connection.start({
      sessionId: options.sessionId,
      modelId: request.modelId,
      executionPolicy: "approval-gated",
    });

    const events = yield* subscribeThenSend({
      connection,
      consume: (runtimeEvents) =>
        runtimeEvents.pipe(
          Stream.filter((event) => event.sessionId === options.sessionId),
          Stream.take(MAX_EVENTS + 1),
          Stream.takeUntil(isTerminal),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              state.handled += 1;
              if (state.handled > MAX_EVENTS) return;
              if (event.kind === "text-delta") state.summary += event.text;
              if (event.kind === "usage") {
                state.outputTokens = event.outputTokens;
                options.observeUsage?.({
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                });
              }
              if (isTerminal(event)) state.terminal = event;
            }),
          ),
        ),
      send: connection.send({
        sessionId: options.sessionId,
        prompt: summaryPrompt(request.materials),
        context: [],
        attachments: [],
        tools: [],
      }),
    });
    yield* Fiber.join(events);
    if (state.terminal?.kind !== "completed" || state.summary.trim().length === 0) {
      return yield* Effect.fail(
        new ContextSummaryGenerationFailed("The maintenance model produced no usable summary."),
      );
    }
    return state.summary.trim();
  });
}

/**
 * Ends the maintenance session, giving up when the provider never confirms it.
 *
 * The request deadline cannot release a wedged stop on its own: scope
 * finalizers run after the timed operation and uninterruptibly, so an unbounded
 * teardown keeps the maintenance request — and the user's send waiting behind
 * it — open indefinitely. The bound therefore sits inside the finalizer, around
 * the stop attempt alone rather than around the shutdown or the scoped effect,
 * so the finalizers registered behind it still run and the caller still reaches
 * the deterministic reduction and the capacity release it falls back to.
 *
 * Expiry cannot close the connection: nothing on the driver seam force-kills a
 * provider session, so the maintenance session and whatever process backs it
 * stay live until the provider ends them itself. Giving up on the confirmation
 * is still the right trade, because maintenance is best-effort and must never
 * be what holds the user's turn.
 */
function stopMaintenanceSession(
  connection: ProviderConnection,
  sessionId: ProviderSessionId,
  shutdownTimeoutMs: number,
): Effect.Effect<void> {
  return connection.stop(sessionId).pipe(
    // The bound only bites inside an interruptible region: a finalizer runs
    // uninterruptibly, and a race that inherits that waits on the very call it
    // exists to give up on. Re-opening the region here is safe because the
    // fiber is already winding down — this runs only once the turn is over,
    // by deadline or by answer, so there is nothing left for it to cut short.
    Effect.interruptible,
    Effect.timeout(shutdownTimeoutMs),
    Effect.catchAll(() => Effect.void),
  );
}

function summaryPrompt(materials: ReadonlyArray<ContextMaintenanceMaterial>): string {
  return [
    SUMMARY_INSTRUCTION,
    ...materials.map((material, index) => `--- excerpt ${index + 1} ---\n${material.content}`),
  ].join("\n\n");
}

function isTerminal(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "waiting" ||
    event.kind === "completed" ||
    event.kind === "interrupted" ||
    event.kind === "failed"
  );
}

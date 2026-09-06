import { isAbsolute } from "node:path";
import {
  decodeCodeRelativePath,
  type CodeThread,
  type PermissionPersistence,
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Fiber, Scope, Stream } from "effect";
import type { ProviderAcquireInput, ProviderConnection } from "@octant/provider-sdk/driver";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { subscribeThenSend } from "../providers/providerEventDelivery";
import { countsTowardTurnEventBudget, makeIdleTimeout } from "../providers/turnBudget";

export const MAX_CODE_TURN_EVENT_BYTES = 64 * 1024;
const MAX_CODE_TURN_INPUT_BYTES = MAX_CODE_TURN_EVENT_BYTES * 4;
const MAX_CODE_TURN_FIELD_BYTES = 8 * 1024;
const MAX_CODE_TURN_INPUT_ITEMS = 64;
// Discrete events only (tool calls, approvals, file changes); streaming
// deltas are exempt. Agentic turns routinely run hundreds of tool calls.
const DEFAULT_MAX_EVENTS = 4_096;
// Inactivity window, not a wall clock: a turn lives as long as the provider
// keeps producing events. Long-running tools (test suites, builds) can be
// silent for minutes.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export type CodeTurnOutcome = "completed" | "waiting" | "interrupted" | "failed";

export interface CodeTurnFailure {
  readonly category: Exclude<CodeTurnOutcome, "completed">;
  readonly message: string;
}

export interface CodeProviderAcquireInput extends ProviderAcquireInput {
  readonly mode: "code";
  readonly permissionPersistence: PermissionPersistence;
}

export interface CodeProviderPort {
  readonly acquire: (
    input: CodeProviderAcquireInput,
  ) => Effect.Effect<ProviderConnection, ProviderFailure, Scope.Scope>;
}

export interface CodeObservationReconciliation {
  readonly status: "confirmed" | "not-confirmed" | "waiting";
  readonly summary: string;
}

export interface CodeObservationInput {
  readonly checkoutRoot: string;
  readonly claim: ProviderRuntimeEvent;
  readonly authority: Pick<CodeThread, "executionPolicy" | "permissionPersistence">;
}

export interface CodeProviderEventSanitizerInput {
  readonly checkoutRoot: string;
  readonly event: ProviderRuntimeEvent;
}

export type CodeTurnEventCategory =
  | "reasoning"
  | "message"
  | "tool"
  | "approval"
  | "question"
  | "observation"
  | "task-progress"
  | "usage"
  | "provider-limit"
  | "child-activity"
  | "citation"
  | "research"
  | "completion"
  | "waiting"
  | "interruption"
  | "failure";

export interface CodeTurnEvent {
  readonly category: CodeTurnEventCategory;
  readonly providerKind: ProviderRuntimeEvent["kind"];
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: ProviderRuntimeEvent["sessionId"];
  readonly sequence: number;
  readonly occurredAt: ProviderRuntimeEvent["occurredAt"];
  readonly text?: string;
  readonly requestId?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly path?: string;
  readonly change?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly utilization?: number;
  readonly resetsAt?: string;
  readonly providerClaimIsMutationProof?: false;
  readonly reconciliation?: CodeObservationReconciliation;
  readonly executionPolicy?: CodeThread["executionPolicy"];
  readonly permissionPersistence?: PermissionPersistence;
}

export interface CodeTurnRunnerInput {
  readonly thread: CodeThread;
  readonly sessionId: ProviderRuntimeEvent["sessionId"];
  readonly checkoutRoot: string;
  readonly prompt: string;
  readonly provider: CodeProviderPort;
  readonly context?: Parameters<ProviderConnection["send"]>[0]["context"];
  readonly attachments?: Parameters<ProviderConnection["send"]>[0]["attachments"];
  readonly appManagedTools?: AppManagedToolSet;
  readonly sanitizeProviderEvent: (
    input: CodeProviderEventSanitizerInput,
  ) => Effect.Effect<ProviderRuntimeEvent, CodeTurnFailure>;
  readonly reconcileObservation: (
    input: CodeObservationInput,
  ) => Effect.Effect<CodeObservationReconciliation, CodeTurnFailure>;
  readonly persistEvent: (event: CodeTurnEvent) => Effect.Effect<void, CodeTurnFailure>;
  /**
   * A failed outcome travels with the reason that produced it. Observed: a
   * turn that failed before the provider said anything was journaled as
   * `failed` alone, and the transcript could only say "The provider turn
   * failed" for it.
   */
  readonly persistOutcome: (
    outcome: CodeTurnOutcome,
    failure?: CodeTurnFailure,
  ) => Effect.Effect<void, CodeTurnFailure>;
  readonly signal?: AbortSignal;
  /** Observes a completed reply with its full text and the tool calls it made. */
  readonly onTurnCompleted?: (input: {
    readonly text: string;
    readonly toolCalls: number;
  }) => Promise<void>;
}

export interface CodeTurnRunnerOptions {
  /** Maximum discrete (non-delta) provider events per turn. */
  readonly maxEvents?: number;
  /** Inactivity window after which a silent turn is interrupted. */
  readonly timeoutMs?: number;
}

export class CodeTurnRunner {
  readonly #maxEvents: number;
  readonly #timeoutMs: number;

  constructor(options: CodeTurnRunnerOptions = {}) {
    this.#maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  run(input: CodeTurnRunnerInput): Effect.Effect<void, CodeTurnFailure, Scope.Scope> {
    const maxEvents = this.#maxEvents;
    const timeoutMs = this.#timeoutMs;

    return Effect.gen(function* () {
      let outcome: CodeTurnOutcome | undefined;
      let handledEvents = 0;
      let unresolvedReconciliation = false;
      let providerCompleted = false;
      let responseText = "";
      const answeredToolRequestIds = new Set<string>();

      const persistOutcome = (next: CodeTurnOutcome, failure?: CodeTurnFailure) =>
        Effect.gen(function* () {
          if (outcome === next) return;
          outcome = next;
          yield* input.persistOutcome(next, failure);
        });

      const fail = (next: Exclude<CodeTurnOutcome, "completed">, message: string) =>
        Effect.gen(function* () {
          const failure = codeTurnFailure(next, message);
          yield* persistOutcome(next, failure);
          return yield* Effect.fail(failure);
        });

      if (input.signal?.aborted) {
        return yield* fail("interrupted", "Code turn was cancelled before provider launch.");
      }
      if (
        input.thread.lifecycle !== "active" ||
        !isAbsolute(input.checkoutRoot) ||
        input.checkoutRoot.includes("\0")
      ) {
        return yield* fail("failed", "Code turn authority is invalid.");
      }

      const connection = yield* input.provider
        .acquire({
          instanceId: input.thread.providerInstanceId,
          mode: "code",
          projectRoot: input.checkoutRoot,
          permissionPersistence: input.thread.permissionPersistence,
        })
        .pipe(Effect.catchAll((providerFailure) => failForProvider(providerFailure, fail)));

      const cleanup = { stopped: false };
      yield* Effect.addFinalizer(() =>
        cleanup.stopped
          ? Effect.void
          : connection.stop(input.sessionId).pipe(Effect.catchAll(() => Effect.void)),
      );

      if (input.signal?.aborted) {
        return yield* fail("interrupted", "Code turn was cancelled during provider acquisition.");
      }

      yield* connection
        .start({
          sessionId: input.sessionId,
          modelId: input.thread.modelId,
          executionPolicy: input.thread.executionPolicy,
        })
        .pipe(Effect.catchAll((providerFailure) => failForProvider(providerFailure, fail)));

      if (input.signal?.aborted) {
        yield* connection.interrupt(input.sessionId).pipe(Effect.catchAll(() => Effect.void));
        return yield* fail("interrupted", "Code turn was cancelled before provider send.");
      }

      const idle = yield* makeIdleTimeout(timeoutMs);
      const collected = yield* subscribeThenSend({
        connection,
        consume: (runtimeEvents) =>
          runtimeEvents.pipe(
            Stream.filter((event) => event.sessionId === input.sessionId),
            Stream.takeUntil(isTerminalProviderEvent),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                yield* idle.touch;
                if (countsTowardTurnEventBudget(event)) handledEvents += 1;
                if (handledEvents > maxEvents) {
                  yield* connection
                    .interrupt(input.sessionId)
                    .pipe(Effect.catchAll(() => Effect.void));
                  return yield* fail("failed", "Code turn exceeded the bounded event budget.");
                }
                if (input.signal?.aborted) {
                  yield* connection
                    .interrupt(input.sessionId)
                    .pipe(Effect.catchAll(() => Effect.void));
                  return yield* fail("interrupted", "Code turn was cancelled.");
                }

                const boundedEvent = boundProviderEventInput(event);
                const sanitizedEvent = boundProviderEventInput(
                  yield* input.sanitizeProviderEvent({
                    checkoutRoot: input.checkoutRoot,
                    event: boundedEvent,
                  }),
                );
                if (!isSanitizedEventValid(boundedEvent, sanitizedEvent, input.checkoutRoot)) {
                  return yield* fail("failed", "Provider event sanitization failed closed.");
                }
                const normalized = yield* normalizeProviderEvent(input, sanitizedEvent);
                if (serializedBytes(normalized) > MAX_CODE_TURN_EVENT_BYTES) {
                  return yield* fail("failed", "Normalized Code event exceeded its byte budget.");
                }
                if (
                  normalized.reconciliation !== undefined &&
                  normalized.reconciliation.status !== "confirmed"
                ) {
                  unresolvedReconciliation = true;
                }

                if (sanitizedEvent.kind === "completed") {
                  if (unresolvedReconciliation) {
                    return yield* fail(
                      "waiting",
                      "Provider completed with unresolved checkout reconciliation.",
                    );
                  }
                  yield* input.persistEvent(normalized);
                  providerCompleted = true;
                  if (input.onTurnCompleted !== undefined) {
                    yield* Effect.promise(() =>
                      input.onTurnCompleted!({
                        text: responseText,
                        toolCalls: answeredToolRequestIds.size,
                      }).catch(() => undefined),
                    );
                  }
                } else {
                  yield* input.persistEvent(normalized);
                  if (sanitizedEvent.kind === "text-delta" && responseText.length < 262_144) {
                    responseText += sanitizedEvent.text;
                  }
                  if (sanitizedEvent.kind === "tool-request") {
                    if (answeredToolRequestIds.has(sanitizedEvent.requestId)) return;
                    answeredToolRequestIds.add(sanitizedEvent.requestId);
                    const toolSet = input.appManagedTools;
                    const allowed = toolSet?.definitions.some(
                      (definition) => definition.name === sanitizedEvent.toolName,
                    );
                    if (toolSet === undefined || allowed !== true) {
                      yield* connection.answerTool({
                        sessionId: input.sessionId,
                        requestId: sanitizedEvent.requestId,
                        resultJson: JSON.stringify({ error: "tool-unavailable" }),
                        isError: true,
                      });
                      return;
                    }
                    const execution = yield* Effect.promise(async () => {
                      try {
                        return await toolSet.execute({
                          name: sanitizedEvent.toolName,
                          inputJson: sanitizedEvent.inputJson,
                          ...(input.signal === undefined ? {} : { signal: input.signal }),
                        });
                      } catch {
                        return {
                          result: { error: "tool-execution-failed" },
                          isError: true,
                        } as const;
                      }
                    });
                    const answer = boundedToolAnswer(execution.result, execution.isError === true);
                    yield* connection.answerTool({
                      sessionId: input.sessionId,
                      requestId: sanitizedEvent.requestId,
                      resultJson: answer.resultJson,
                      isError: answer.isError,
                    });
                    yield* input.persistEvent({
                      ...normalized,
                      status: answer.isError ? "failed" : "completed",
                      text: answer.isError
                        ? "App-managed action failed."
                        : "App-managed action completed.",
                    });
                    return;
                  }
                  if (sanitizedEvent.kind === "waiting") yield* persistOutcome("waiting");
                  else if (sanitizedEvent.kind === "interrupted") {
                    return yield* fail("interrupted", sanitizedEvent.message);
                  } else if (sanitizedEvent.kind === "failed") {
                    return yield* failForProvider(sanitizedEvent.failure, fail);
                  }
                }
              }),
            ),
          ),
        send: Effect.gen(function* () {
          if (input.signal?.aborted) {
            yield* connection.interrupt(input.sessionId).pipe(Effect.catchAll(() => Effect.void));
            return yield* fail("interrupted", "Code turn was cancelled before provider send.");
          }
          yield* connection
            .send({
              sessionId: input.sessionId,
              prompt: input.prompt,
              ...(input.context === undefined ? {} : { context: input.context }),
              attachments: input.attachments ?? [],
              tools: [...(input.appManagedTools?.definitions ?? [])],
            })
            .pipe(Effect.catchAll((providerFailure) => failForProvider(providerFailure, fail)));
        }),
      });

      const awaitCollection = Fiber.join(collected).pipe(
        Effect.catchAll((error) =>
          isCodeTurnFailure(error) ? Effect.fail(error) : failForProvider(error, fail),
        ),
      );
      const waitForAbort =
        input.signal === undefined
          ? Effect.never
          : waitForSignal(input.signal).pipe(
              Effect.flatMap(() =>
                connection.interrupt(input.sessionId).pipe(Effect.catchAll(() => Effect.void)),
              ),
              Effect.zipRight(fail("interrupted", "Code turn was cancelled.")),
            );
      const waitForTimeout = idle.expired.pipe(
        Effect.flatMap(() =>
          connection.interrupt(input.sessionId).pipe(Effect.catchAll(() => Effect.void)),
        ),
        Effect.zipRight(fail("interrupted", "Code turn timed out after provider inactivity.")),
      );

      yield* Effect.raceFirst(awaitCollection, Effect.raceFirst(waitForAbort, waitForTimeout));
      if (!providerCompleted && outcome === undefined) {
        return yield* fail(
          "waiting",
          "Provider process ended without a terminal event; checkout reconciliation is required.",
        );
      }
      yield* connection.stop(input.sessionId).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cleanup.stopped = true;
          }),
        ),
        Effect.catchAll(() => fail("waiting", "Provider session cleanup could not be confirmed.")),
      );
      if (providerCompleted) yield* persistOutcome("completed");
    });
  }
}

function normalizeProviderEvent(
  input: CodeTurnRunnerInput,
  event: ProviderRuntimeEvent,
): Effect.Effect<CodeTurnEvent, CodeTurnFailure> {
  const base = {
    providerKind: event.kind,
    instanceId: event.instanceId,
    sessionId: event.sessionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
  } as const;
  const text = (value: string) => boundedUtf8(value, MAX_CODE_TURN_FIELD_BYTES);
  const observation = (claimText?: string) =>
    input
      .reconcileObservation({
        checkoutRoot: input.checkoutRoot,
        claim: event,
        authority: {
          executionPolicy: input.thread.executionPolicy,
          permissionPersistence: input.thread.permissionPersistence,
        },
      })
      .pipe(
        Effect.map((reconciliation) => ({
          ...base,
          category: "observation" as const,
          ...(claimText === undefined ? {} : { text: text(claimText) }),
          providerClaimIsMutationProof: false as const,
          reconciliation: {
            ...reconciliation,
            summary: text(reconciliation.summary),
          },
        })),
      );

  switch (event.kind) {
    case "text-delta":
      return Effect.succeed({ ...base, category: "message", text: text(event.text) });
    case "reasoning-delta":
      return Effect.succeed({ ...base, category: "reasoning", text: text(event.text) });
    case "tool-start":
      return Effect.succeed({
        ...base,
        category: "tool",
        toolCallId: text(event.toolCallId),
        toolName: text(event.toolName),
        status: "started",
      });
    case "tool-progress":
      return Effect.succeed({
        ...base,
        category: "tool",
        toolCallId: text(event.toolCallId),
        text: text(event.message),
        status: "in-progress",
      });
    case "tool-success":
      return observation(event.summary).pipe(
        Effect.map((normalized) => ({
          ...normalized,
          toolCallId: text(event.toolCallId),
          status: "provider-claimed-success",
        })),
      );
    case "tool-failure":
      return observation(event.message).pipe(
        Effect.map((normalized) => ({
          ...normalized,
          toolCallId: text(event.toolCallId),
          status: "provider-claimed-failure",
        })),
      );
    case "file-change":
      return observation().pipe(
        Effect.map((normalized) => ({
          ...normalized,
          path: text(event.path),
          change: event.change,
        })),
      );
    case "diff":
      return observation(event.diff);
    case "task-progress":
      return Effect.succeed({
        ...base,
        category: "task-progress",
        requestId: text(event.taskId),
        status: event.status,
        text: text(event.summary),
      });
    case "child-agent-activity":
      return Effect.succeed({
        ...base,
        category: "child-activity",
        requestId: text(event.childAgentId),
        status: event.status,
        text: text(event.summary),
      });
    case "approval-request":
      return Effect.succeed({
        ...base,
        category: "approval",
        requestId: text(event.requestId),
        text: text(`${event.action}: ${event.description}`),
        executionPolicy: input.thread.executionPolicy,
        permissionPersistence: input.thread.permissionPersistence,
      });
    case "user-input-request":
      return Effect.succeed({
        ...base,
        category: "question",
        requestId: text(event.requestId),
        text: text(event.prompt),
      });
    case "tool-request":
      return Effect.succeed({
        ...base,
        category: "tool",
        requestId: text(event.requestId),
        toolName: text(event.toolName),
        text: text(event.inputJson),
        status: "app-managed-request",
      });
    case "usage":
      return Effect.succeed({
        ...base,
        category: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
      });
    case "rate-limit-window":
      return Effect.succeed({
        ...base,
        category: "provider-limit",
        text: text(event.window),
        status: event.status,
        ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
        ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
      });
    case "rate-limit-bucket":
      // A header bucket is exact, so its share spent is arithmetic rather
      // than a guess; the provider gave no warning threshold, so only an
      // empty bucket counts as exhausted and nothing is ever "warning".
      return Effect.succeed({
        ...base,
        category: "provider-limit",
        text: text(event.bucket),
        status: event.remaining === 0 ? "exhausted" : "allowed",
        utilization: (event.limit - event.remaining) / event.limit,
        ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
      });
    case "citation":
      return Effect.succeed({
        ...base,
        category: "citation",
        requestId: text(event.citationId),
        text: text(`${event.sourceTitle}: ${event.sourceUrl}`),
      });
    case "research-started":
      return Effect.succeed({
        ...base,
        category: "research",
        requestId: text(event.researchId),
        status: "started",
        text: text(event.query),
      });
    case "research-completed":
      return Effect.succeed({
        ...base,
        category: "research",
        requestId: text(event.researchId),
        status: "completed",
        text: String(event.sourceCount),
      });
    case "waiting":
      return Effect.succeed({ ...base, category: "waiting", text: text(event.message) });
    case "interrupted":
      return Effect.succeed({ ...base, category: "interruption", text: text(event.message) });
    case "failed":
      return Effect.succeed({ ...base, category: "failure", text: text(event.failure.message) });
    case "completed":
      return Effect.succeed({ ...base, category: "completion" });
  }
}

function isTerminalProviderEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.kind === "waiting" ||
    event.kind === "interrupted" ||
    event.kind === "failed" ||
    event.kind === "completed"
  );
}

function failForProvider(
  failure: unknown,
  fail: (
    outcome: Exclude<CodeTurnOutcome, "completed">,
    message: string,
  ) => Effect.Effect<never, CodeTurnFailure>,
): Effect.Effect<never, CodeTurnFailure> {
  if (!isProviderFailure(failure)) return fail("failed", "Provider execution failed.");
  if (failure.category === "rate-limited") return fail("waiting", failure.message);
  if (failure.category === "stale-resume") return fail("waiting", failure.message);
  if (failure.category === "interrupted") return fail("interrupted", failure.message);
  return fail("failed", failure.message);
}

function isProviderFailure(value: unknown): value is ProviderFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "category" in value &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function isCodeTurnFailure(value: unknown): value is CodeTurnFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "category" in value &&
    "message" in value &&
    (value.category === "waiting" ||
      value.category === "interrupted" ||
      value.category === "failed") &&
    typeof value.message === "string"
  );
}

function codeTurnFailure(
  category: Exclude<CodeTurnOutcome, "completed">,
  message: string,
): CodeTurnFailure {
  return { category, message };
}

function waitForSignal(signal: AbortSignal): Effect.Effect<void> {
  if (signal.aborted) return Effect.void;
  return Effect.async<void>((resume) => {
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function boundedUtf8(value: string, maximumBytes: number): string {
  if (value.length <= Math.floor(maximumBytes / 3)) return value;
  let low = 0;
  let high = Math.min(value.length, maximumBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && isHighSurrogate(value.charCodeAt(low - 1))) low -= 1;
  return value.slice(0, low);
}

function boundProviderEventInput(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return boundProviderValue(event) as ProviderRuntimeEvent;
}

function boundProviderValue(value: unknown): unknown {
  if (typeof value === "string") return boundedUtf8(value, MAX_CODE_TURN_INPUT_BYTES);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_CODE_TURN_INPUT_ITEMS).map(boundProviderValue);
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, boundProviderValue(child)]),
  );
}

function serializedBytes(event: CodeTurnEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function boundedToolAnswer(
  result: unknown,
  isError: boolean,
): {
  readonly resultJson: string;
  readonly isError: boolean;
} {
  try {
    const resultJson = JSON.stringify(result);
    if (
      resultJson === undefined ||
      Buffer.byteLength(resultJson, "utf8") > MAX_CODE_TURN_EVENT_BYTES
    ) {
      return {
        resultJson: JSON.stringify({ error: "tool-result-too-large" }),
        isError: true,
      };
    }
    return { resultJson, isError };
  } catch {
    return { resultJson: JSON.stringify({ error: "tool-result-invalid" }), isError: true };
  }
}

function isSanitizedEventValid(
  original: ProviderRuntimeEvent,
  sanitized: ProviderRuntimeEvent,
  checkoutRoot: string,
): boolean {
  if (
    sanitized.kind !== original.kind ||
    sanitized.instanceId !== original.instanceId ||
    sanitized.sessionId !== original.sessionId ||
    sanitized.sequence !== original.sequence ||
    sanitized.correlationId !== original.correlationId ||
    sanitized.occurredAt !== original.occurredAt ||
    JSON.stringify(sanitized).includes(checkoutRoot)
  ) {
    return false;
  }
  if (sanitized.kind !== "file-change") return true;
  try {
    decodeCodeRelativePath(sanitized.path);
    return true;
  } catch {
    return false;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

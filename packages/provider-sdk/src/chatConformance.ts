import type {
  ProviderCapabilities,
  ProviderCapabilitySupport,
  ProviderFailure,
  ProviderFailureCategory,
  ProviderInputModality,
  ProviderModel,
  ProviderProbeResult,
  ProviderRuntimeEvent,
  ProviderToolAnswer,
  ProviderTurnInput,
} from "@octant/contracts";
import { decodeProviderTurnInput } from "@octant/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import type {
  ProviderAcquireInput,
  ProviderDriver,
  ProviderProbeInput,
  ProviderSessionStart,
} from "./driver";

export interface ProviderChatConformanceFixture {
  readonly driver: ProviderDriver;
  readonly probeInput: ProviderProbeInput;
  readonly acquireInput: ProviderAcquireInput;
  readonly sessionStart: ProviderSessionStart;
  readonly turn: ProviderTurnInput;
  readonly toolAnswer?: ProviderToolAnswer;
  readonly isReleased: () => boolean;
}

export interface ProviderChatConformanceEvidence {
  readonly nativeAttachmentHonest: boolean;
  readonly appManagedToolRoundTrip: boolean;
  readonly citationsNormalized: boolean;
  readonly released: boolean;
}

const failureCategories = new Set<ProviderFailureCategory>([
  "unavailable",
  "unauthenticated",
  "unsupported",
  "unauthorized",
  "interrupted",
  "stale-resume",
  "invalid-configuration",
  "incompatible",
  "protocol",
  "provider-failed",
  "rate-limited",
]);

type ChatCapability = "nativeAttachments" | "nativeWebResearch" | "appManagedTools" | "citations";

const chatEventKindsByCapability: ReadonlyArray<
  readonly [ChatCapability, ReadonlyArray<ProviderRuntimeEvent["kind"]>]
> = [
  ["nativeWebResearch", ["research-started", "research-completed"]],
  ["appManagedTools", ["tool-request"]],
  ["citations", ["citation"]],
];

export const unsupportedChatCapabilities = {
  nativeAttachments: "unsupported",
  nativeWebResearch: "unsupported",
  appManagedTools: "unsupported",
  citations: "unsupported",
} as const satisfies Pick<
  ProviderCapabilities,
  "nativeAttachments" | "nativeWebResearch" | "appManagedTools" | "citations"
>;

export const textOnlyInputModalities: readonly ProviderInputModality[] = ["text"];

export function renderProviderTurnPrompt(
  input: Pick<ProviderTurnInput, "context" | "prompt">,
): string {
  if (input.context === undefined || input.context.length === 0) return input.prompt;
  return [
    "Octant normalized Chat context (JSON):",
    JSON.stringify(input.context),
    "",
    "Current request:",
    input.prompt,
  ].join("\n");
}

export const attachmentMediaTypeToModality = (
  mediaType: string,
): ProviderInputModality | undefined => {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("text/")) return "document";
  if (
    mediaType === "application/pdf" ||
    mediaType.startsWith("application/vnd.") ||
    mediaType.startsWith("application/msword") ||
    mediaType.startsWith("application/vnd.openxmlformats-officedocument")
  ) {
    return "document";
  }
  return undefined;
};

export function chatFailure(
  category: ProviderFailure["category"],
  message: string,
): ProviderFailure {
  return { category, message };
}

export function validateChatTurnInput(
  input: ProviderTurnInput,
  capabilities: Pick<ProviderCapabilities, "nativeAttachments" | "appManagedTools">,
  model?: ProviderModel,
): ProviderFailure | undefined {
  if (input.attachments.length > 0) {
    const support = capabilities.nativeAttachments;
    if (support !== "supported") {
      return chatFailure(support, "Native attachments are unsupported.");
    }
    if (model === undefined) {
      return chatFailure("protocol", "Provider model is not available.");
    }
    for (const attachment of input.attachments) {
      const modality = attachmentMediaTypeToModality(attachment.mediaType);
      if (modality === undefined || !model.inputModalities.includes(modality)) {
        return chatFailure(
          "unsupported",
          `The selected model cannot consume ${attachment.mediaType}.`,
        );
      }
    }
  }
  if (input.tools.length > 0) {
    const support = capabilities.appManagedTools;
    if (support !== "supported") {
      return chatFailure(support, "App-managed tools are unsupported.");
    }
  }
  return undefined;
}

export function rejectUnsupportedChatTurn(
  input: ProviderTurnInput,
  capabilities: Pick<ProviderCapabilities, "nativeAttachments" | "appManagedTools">,
  model?: ProviderModel,
): Effect.Effect<void, ProviderFailure> {
  const rejected = validateChatTurnInput(input, capabilities, model);
  return rejected === undefined ? Effect.void : Effect.fail(rejected);
}

export function unsupportedAnswerTool(
  support: ProviderCapabilitySupport,
  message = "App-managed tools are unsupported.",
): Effect.Effect<void, ProviderFailure> {
  return support === "supported"
    ? Effect.fail(chatFailure("protocol", "The tool request is unknown."))
    : Effect.fail(chatFailure(support, message));
}

function assertConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Provider chat conformance failed: ${message}`);
}

function failureFromExit<A>(
  exit: Exit.Exit<A, ProviderFailure>,
  operation: string,
): ProviderFailure {
  assertConformance(Exit.isFailure(exit), `${operation} unexpectedly succeeded`);
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  assertConformance(failure !== undefined, `${operation} did not return a typed provider failure`);
  assertConformance(
    failureCategories.has(failure.category),
    `${operation} returned an unknown failure category`,
  );
  assertConformance(failure.message.trim().length > 0, `${operation} returned an empty message`);
  return failure;
}

function assertExpectedFailure<A>(
  operation: string,
  exit: Exit.Exit<A, ProviderFailure>,
  expected: ProviderFailureCategory,
): void {
  const failure = failureFromExit(exit, operation);
  assertConformance(
    failure.category === expected,
    `${operation} failed as ${failure.category}; expected ${expected}`,
  );
}

function assertSupportedOperation<A>(
  operation: string,
  support: ProviderCapabilitySupport,
  exit: Exit.Exit<A, ProviderFailure>,
): A | undefined {
  if (support === "supported") {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = failureFromExit(exit, operation);
    assertConformance(
      failure.category !== "unsupported" && failure.category !== "unavailable",
      `${operation} is claimed as supported but failed as ${failure.category}`,
    );
    throw new Error(
      `Provider chat conformance failed: ${operation} is claimed as supported but failed as ${failure.category}`,
    );
  }

  if (support === "unsupported" || support === "unavailable") {
    assertExpectedFailure(operation, exit, support);
    return undefined;
  }

  throw new Error(
    `Provider chat conformance failed: ${operation} reported unknown support ${support}`,
  );
}

function resolveModel(
  probe: ProviderProbeResult,
  modelId: ProviderSessionStart["modelId"],
): ProviderModel | undefined {
  return probe.models.find((model) => model.id === modelId);
}

function assertAttachmentHonesty(
  probe: ProviderProbeResult,
  model: ProviderModel | undefined,
  turn: ProviderTurnInput,
  sendExit: Exit.Exit<void, ProviderFailure>,
): boolean {
  if (turn.attachments.length === 0) return true;

  const support = probe.capabilities.nativeAttachments;
  if (support !== "supported") {
    assertExpectedFailure("native attachments", sendExit, support);
    return true;
  }

  if (turn.tools.length > 0 && probe.capabilities.appManagedTools !== "supported") {
    return false;
  }

  assertSupportedOperation("native attachments", support, sendExit);
  assertConformance(model !== undefined, "native attachments require a resolved model");
  for (const attachment of turn.attachments) {
    const modality = attachmentMediaTypeToModality(attachment.mediaType);
    assertConformance(
      modality !== undefined && model.inputModalities.includes(modality),
      `native attachments are supported but model ${model.id} cannot consume ${attachment.mediaType}`,
    );
  }
  return true;
}

function assertToolSendHonesty(
  probe: ProviderProbeResult,
  turn: ProviderTurnInput,
  sendExit: Exit.Exit<void, ProviderFailure>,
): boolean {
  if (turn.tools.length === 0) return true;

  const support = probe.capabilities.appManagedTools;
  if (support !== "supported") {
    assertExpectedFailure("app-managed tools", sendExit, support);
    return true;
  }

  if (turn.attachments.length > 0 && probe.capabilities.nativeAttachments !== "supported") {
    return false;
  }

  assertSupportedOperation("app-managed tools", support, sendExit);
  return true;
}

function assertChatEventCapabilities(
  capabilities: ProviderProbeResult["capabilities"],
  events: ReadonlyArray<ProviderRuntimeEvent>,
): void {
  for (const [capability, eventKinds] of chatEventKindsByCapability) {
    const support = capabilities[capability];
    const emittedKinds = eventKinds.filter((kind) => events.some((event) => event.kind === kind));
    const missingKinds = eventKinds.filter((kind) => !emittedKinds.includes(kind));
    assertConformance(
      support === "supported" ? missingKinds.length === 0 : emittedKinds.length === 0,
      support === "supported"
        ? `${capability} is claimed as supported but did not emit ${missingKinds.join(", ")}`
        : `${capability} is claimed as ${support} but emitted ${emittedKinds.join(", ")}`,
    );
  }
}

function assertChatEventSequence(events: ReadonlyArray<ProviderRuntimeEvent>): void {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    assertConformance(
      previous !== undefined && current !== undefined && current.sequence > previous.sequence,
      "normalized event sequence must increase strictly",
    );
  }
}

export async function runProviderChatConformance(
  fixture: ProviderChatConformanceFixture,
): Promise<ProviderChatConformanceEvidence> {
  const turn = decodeProviderTurnInput(fixture.turn);
  const evidence = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const probe = yield* fixture.driver.probe(fixture.probeInput);
        assertConformance(probe.readiness === "ready", "probe did not report ready");
        assertConformance(
          probe.instanceId === fixture.probeInput.instanceId,
          "probe returned a different provider instance",
        );

        const model = resolveModel(probe, fixture.sessionStart.modelId);
        const connection = yield* fixture.driver.acquire(fixture.acquireInput);
        const started = yield* connection.start(fixture.sessionStart);
        assertConformance(
          started.sessionId === fixture.sessionStart.sessionId,
          "start returned a different session",
        );

        const events: ProviderRuntimeEvent[] = [];
        const toolRequestObserved =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { readonly kind: "tool-request" }>>();
        const collector = yield* Effect.fork(
          connection.events.pipe(
            Stream.filter((event) => event.sessionId === fixture.sessionStart.sessionId),
            Stream.takeUntil(
              (event) =>
                event.kind === "completed" ||
                event.kind === "interrupted" ||
                event.kind === "failed",
            ),
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                events.push(event);
                if (event.kind === "tool-request") {
                  yield* Deferred.succeed(toolRequestObserved, event);
                }
              }),
            ),
          ),
        );
        const sendExit = yield* Effect.exit(connection.send(turn));
        const nativeAttachmentHonest = assertAttachmentHonesty(probe, model, turn, sendExit);
        const appManagedToolSendHonest = assertToolSendHonesty(probe, turn, sendExit);

        if (Exit.isFailure(sendExit)) {
          yield* Fiber.interrupt(collector);
          yield* connection.stop(fixture.sessionStart.sessionId);
          return {
            nativeAttachmentHonest,
            appManagedToolRoundTrip:
              appManagedToolSendHonest &&
              (turn.tools.length === 0 || probe.capabilities.appManagedTools !== "supported"),
            citationsNormalized: probe.capabilities.citations !== "supported",
          };
        }

        if (probe.capabilities.appManagedTools === "supported" && turn.tools.length > 0) {
          assertConformance(
            Exit.isSuccess(sendExit),
            "app-managed tool round trip requires a successful send",
          );
          const toolRequest = yield* Deferred.await(toolRequestObserved);
          const answer = fixture.toolAnswer ?? {
            sessionId: fixture.sessionStart.sessionId,
            requestId: toolRequest.requestId,
            resultJson: JSON.stringify({ sources: [] }),
            isError: false,
          };
          assertSupportedOperation(
            "answerTool",
            probe.capabilities.appManagedTools,
            yield* Effect.exit(connection.answerTool(answer)),
          );
        }

        yield* Fiber.join(collector);
        assertChatEventSequence(events);
        assertChatEventCapabilities(probe.capabilities, events);

        if (probe.capabilities.citations === "supported" && Exit.isSuccess(sendExit)) {
          const citation = events.find((event) => event.kind === "citation");
          assertConformance(
            citation !== undefined,
            "citations are supported but no citation event was emitted",
          );
          assertConformance(
            citation.sourceTitle.trim().length > 0 && citation.sourceUrl.trim().length > 0,
            "citation events must remain normalized and bounded",
          );
        }

        yield* connection.stop(fixture.sessionStart.sessionId);

        return {
          nativeAttachmentHonest,
          appManagedToolRoundTrip: appManagedToolSendHonest,
          citationsNormalized: true,
        };
      }),
    ),
  );

  assertConformance(fixture.isReleased(), "connection scope was not finalized");
  return { ...evidence, released: true };
}

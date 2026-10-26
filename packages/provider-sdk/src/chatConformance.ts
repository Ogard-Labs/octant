import type {
  ProviderCapabilities,
  ProviderCapabilitySupport,
  ProviderContextBlock,
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

const CONTEXT_TAG = "octant-context";

/**
 * A block's text with anything that could open or close a context tag
 * neutralized. The JSON framing this replaced escaped every block; plain text
 * does not, so without this a block could close its own section and pass the
 * rest of its text off as another block, or as Octant's instructions.
 */
function neutralizeContextTags(text: string): string {
  return text.replace(/<(\/?)(octant-context)/giu, "&lt;$1$2");
}

/**
 * The text a provider receives for one turn: each context block as a tagged
 * plain-text section in the order given, then the request itself.
 *
 * The framing is fixed and holds nothing but the blocks' own text, so the same
 * blocks render to the same bytes every turn, and a runtime's own transcript
 * stays readable. It replaced one JSON array of every block, which put escaped
 * JSON at the head of every user message a native session recorded.
 */
export function renderProviderTurnPrompt(
  input: Pick<ProviderTurnInput, "context" | "prompt">,
): string {
  if (input.context === undefined || input.context.length === 0) return input.prompt;
  return [
    ...input.context.map(
      (block) =>
        `<${CONTEXT_TAG} kind="${block.kind}">\n${neutralizeContextTags(block.text)}\n</${CONTEXT_TAG}>\n`,
    ),
    "Current request:",
    input.prompt,
  ].join("\n");
}

/**
 * The block kinds that stand for the whole session rather than for one turn:
 * Octant's instructions, selected skills, project memory, and the work item. A
 * session that already received one keeps it in its own history.
 */
const STANDING_CONTEXT_KINDS: ReadonlySet<ProviderContextBlock["kind"]> = new Set([
  "instructions",
  "project-memory",
  "work-item",
]);

/** Whether a block stands for the whole session, and so is held once delivered. */
export function isStandingProviderContext(block: ProviderContextBlock): boolean {
  return STANDING_CONTEXT_KINDS.has(block.kind);
}

export const PROVIDER_CONTEXT_RESTATED =
  "Octant's standing context for this conversation changed. The Octant context in this message replaces all Octant context sent earlier in this conversation.";

export type ProviderTurnContextDelta =
  | {
      /** Held standing blocks are left out; everything else is sent. */
      readonly kind: "appended";
      readonly context: ReadonlyArray<ProviderContextBlock>;
      /** Standing blocks left out because the session already holds them. */
      readonly held: ReadonlyArray<ProviderContextBlock>;
    }
  | {
      /** A held standing block was withdrawn, so the whole context is sent again. */
      readonly kind: "restated";
      readonly context: ReadonlyArray<ProviderContextBlock>;
      readonly held: readonly [];
    };

/**
 * What one turn sends to a provider-owned session that may already hold some
 * of its standing context from earlier turns.
 *
 * A native session keeps every user message it was sent, so resending the same
 * instructions each turn added another copy to its window and its visible
 * history every turn, and made each turn's new input larger than the request.
 * Standing blocks the session holds are left out; per-turn blocks (messages,
 * summaries, mentions, handoffs) are always sent. When a standing block the
 * session holds is no longer in the turn's context (a deselected skill, say),
 * leaving the rest out would let the stale copy stand, so the whole context is
 * sent again behind a note that it replaces what came before.
 */
export function providerTurnContextDelta(input: {
  readonly context: ReadonlyArray<ProviderContextBlock>;
  /** Whether the session holds this exact block from an earlier turn. */
  readonly holds: (block: ProviderContextBlock) => boolean;
  /** How many distinct standing blocks the session holds. */
  readonly heldCount: number;
}): ProviderTurnContextDelta {
  const held: ProviderContextBlock[] = [];
  const context: ProviderContextBlock[] = [];
  const stillHeld = new Set<string>();
  for (const block of input.context) {
    if (isStandingProviderContext(block) && input.holds(block)) {
      held.push(block);
      stillHeld.add(`${block.kind}\u0000${block.text}`);
    } else context.push(block);
  }
  if (stillHeld.size < input.heldCount) {
    return {
      kind: "restated",
      context: [{ kind: "instructions", text: PROVIDER_CONTEXT_RESTATED }, ...input.context],
      held: [],
    };
  }
  return { kind: "appended", context, held };
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
        const runtimeEvents = yield* connection.subscribe;
        const collector = yield* Effect.fork(
          runtimeEvents.pipe(
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

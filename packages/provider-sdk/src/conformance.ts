import type {
  ProviderCapabilitySupport,
  ProviderFailure,
  ProviderFailureCategory,
  ProviderProbeResult,
  ProviderRuntimeEvent,
} from "@octant/contracts";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import type {
  ProviderAcquireInput,
  ProviderApprovalAnswer,
  ProviderDriver,
  ProviderProbeInput,
  ProviderSessionResume,
  ProviderSessionStart,
  ProviderTurnInput,
  ProviderUserInputAnswer,
} from "./driver";

export interface ProviderConformanceFixture {
  readonly driver: ProviderDriver;
  readonly probeInput: ProviderProbeInput;
  readonly acquireInput: ProviderAcquireInput;
  readonly sessionStart: ProviderSessionStart;
  readonly turn: ProviderTurnInput;
  readonly resume: ProviderSessionResume;
  readonly staleResume: ProviderSessionResume;
  readonly unknownApproval: ProviderApprovalAnswer;
  readonly unknownUserInput: ProviderUserInputAnswer;
  readonly expectedEventKinds: ReadonlyArray<ProviderRuntimeEvent["kind"]>;
  readonly expectedFailureCategories: {
    readonly staleResume: ProviderFailureCategory;
    readonly unknownApproval: ProviderFailureCategory;
    readonly unknownUserInput: ProviderFailureCategory;
  };
  readonly isReleased: () => boolean;
  readonly successfulTurn?: {
    readonly sessionStart: ProviderSessionStart;
    readonly turn: ProviderTurnInput;
    readonly expectedEventKinds: ReadonlyArray<ProviderRuntimeEvent["kind"]>;
    readonly expectedStreaming: ProviderCapabilitySupport;
    readonly observed: () => ProviderProbeResult | undefined;
  };
}

export interface ProviderConformanceEvidence {
  readonly probed: boolean;
  readonly capabilityHonest: boolean;
  readonly usageCapabilityHonest: boolean;
  readonly researchCapabilityHonest: boolean;
  readonly citationsCapabilityHonest: boolean;
  readonly streamedInOrder: boolean;
  readonly interrupted: boolean;
  readonly resumed: boolean;
  readonly staleResumeRejected: boolean;
  readonly unknownApprovalRejected: boolean;
  readonly unknownUserInputRejected: boolean;
  readonly failureClassified: boolean;
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
]);

type EventBackedCapability =
  | "reasoning"
  | "usage"
  | "toolActivity"
  | "fileChanges"
  | "diffs"
  | "taskProgress"
  | "nativeChildAgents"
  | "approvals"
  | "userQuestions"
  | "nativeWebResearch"
  | "citations";

const eventKindsByCapability: ReadonlyArray<
  readonly [EventBackedCapability, ReadonlyArray<ProviderRuntimeEvent["kind"]>]
> = [
  ["reasoning", ["reasoning-delta"]],
  ["usage", ["usage"]],
  ["toolActivity", ["tool-start", "tool-progress", "tool-success", "tool-failure"]],
  ["fileChanges", ["file-change"]],
  ["diffs", ["diff"]],
  ["taskProgress", ["task-progress"]],
  ["nativeChildAgents", ["child-agent-activity"]],
  ["approvals", ["approval-request"]],
  ["userQuestions", ["user-input-request"]],
  ["nativeWebResearch", ["research-started", "research-completed"]],
  ["citations", ["citation"]],
];

function assertConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Provider conformance failed: ${message}`);
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
      `Provider conformance failed: ${operation} is claimed as supported but failed as ${failure.category}`,
    );
  }

  const failure = failureFromExit(exit, operation);
  assertConformance(
    failure.category === support,
    `${operation} is claimed as ${support} but failed as ${failure.category}`,
  );
  return undefined;
}

function assertEventCapabilities(
  capabilities: Record<EventBackedCapability, ProviderCapabilitySupport>,
  events: ReadonlyArray<ProviderRuntimeEvent>,
): void {
  for (const [capability, eventKinds] of eventKindsByCapability) {
    const support = capabilities[capability];
    const emitted = events.some((event) => eventKinds.includes(event.kind));
    assertConformance(
      support === "supported" ? emitted : !emitted,
      support === "supported"
        ? `${capability} is claimed as supported but no matching normalized event was emitted`
        : `${capability} is claimed as ${support} but emitted a matching normalized event`,
    );
  }
}

function assertRuntimeEvents(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  expectedKinds: ReadonlyArray<ProviderRuntimeEvent["kind"]>,
  sessionId: ProviderRuntimeEvent["sessionId"],
  terminalKind?: "completed" | "interrupted",
): void {
  const eventKinds = events.map((event) => event.kind);
  assertConformance(
    eventKinds.length === expectedKinds.length &&
      eventKinds.every((kind, index) => kind === expectedKinds[index]),
    `runtime event order was ${eventKinds.join(", ")}`,
  );
  assertConformance(
    events.every((event) => event.sessionId === sessionId),
    "runtime event stream included a different provider session",
  );
  assertConformance(
    events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence),
    "runtime event sequences were not strictly increasing",
  );
  if (terminalKind !== undefined) {
    assertConformance(
      events.at(-1)?.kind === terminalKind,
      `${terminalKind} flow did not produce its expected terminal event`,
    );
  }
}

function collectSessionThroughTerminal(
  events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
  sessionId: ProviderRuntimeEvent["sessionId"],
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

function expectedUnknownRequestCategory(
  support: ProviderCapabilitySupport,
): ProviderFailureCategory {
  return support === "supported" ? "protocol" : support;
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

function assertCapabilityFailure<A>(
  capability: string,
  support: ProviderCapabilitySupport,
  exit: Exit.Exit<A, ProviderFailure>,
  supportedFailure: ProviderFailureCategory,
): void {
  const failure = failureFromExit(exit, capability);
  const expected = support === "supported" ? supportedFailure : support;
  assertConformance(
    failure.category === expected,
    `${capability} is claimed as ${support} but failed as ${failure.category}`,
  );
}

export async function runProviderConformance(
  fixture: ProviderConformanceFixture,
): Promise<ProviderConformanceEvidence> {
  const evidence = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const probe = yield* fixture.driver.probe(fixture.probeInput);
        assertConformance(probe.readiness === "ready", "probe did not report ready");
        assertConformance(
          probe.instanceId === fixture.probeInput.instanceId,
          "probe returned a different provider instance",
        );

        const connection = yield* fixture.driver.acquire(fixture.acquireInput);
        let successfulEvents: ReadonlyArray<ProviderRuntimeEvent> = [];
        if (fixture.successfulTurn !== undefined) {
          const successful = fixture.successfulTurn;
          const started = yield* connection.start(successful.sessionStart);
          assertConformance(
            started.sessionId === successful.sessionStart.sessionId,
            "successful start returned a different session",
          );
          const collected = yield* Effect.fork(
            collectSessionThroughTerminal(connection.events, successful.sessionStart.sessionId),
          );
          yield* connection.send(successful.turn);
          successfulEvents = Array.from(yield* Fiber.join(collected));
          assertRuntimeEvents(
            successfulEvents,
            successful.expectedEventKinds,
            successful.sessionStart.sessionId,
            "completed",
          );
          const observed = successful.observed();
          assertConformance(observed !== undefined, "successful turn did not publish observation");
          assertConformance(
            observed.capabilities.streaming === successful.expectedStreaming,
            `successful turn observed streaming as ${observed.capabilities.streaming}; expected ${successful.expectedStreaming}`,
          );
          assertEventCapabilities(observed.capabilities, successfulEvents);
          yield* connection.stop(successful.sessionStart.sessionId);
        }

        const started = yield* connection.start(fixture.sessionStart);
        assertConformance(
          started.sessionId === fixture.sessionStart.sessionId,
          "start returned a different session",
        );
        const collected = yield* Effect.fork(
          collectSessionThroughTerminal(connection.events, fixture.sessionStart.sessionId),
        );
        yield* connection.send(fixture.turn);

        const interruptExit = yield* Effect.exit(
          connection.interrupt(fixture.sessionStart.sessionId),
        );
        assertSupportedOperation("interruption", probe.capabilities.interruption, interruptExit);

        const events = Array.from(yield* Fiber.join(collected));
        assertRuntimeEvents(
          events,
          fixture.expectedEventKinds,
          fixture.sessionStart.sessionId,
          probe.capabilities.interruption === "supported" ? "interrupted" : undefined,
        );
        assertEventCapabilities(probe.capabilities, events);
        if (probe.capabilities.interruption === "supported") {
          assertConformance(
            events.at(-1)?.kind === "interrupted",
            "interruption did not produce a terminal interrupted event",
          );
        } else {
          assertConformance(
            events.every((event) => event.kind !== "interrupted"),
            `interruption is claimed as ${probe.capabilities.interruption} but emitted an interrupted event`,
          );
        }

        assertConformance(
          [...successfulEvents, ...events].some((event) => event.kind === "text-delta"),
          "streamed-in-order evidence requires normalized text output",
        );

        const resumeExit = yield* Effect.exit(connection.resume(fixture.resume));
        const resumed = assertSupportedOperation("resume", probe.capabilities.resume, resumeExit);
        if (probe.capabilities.resume === "supported") {
          assertConformance(
            resumed?.sessionId === fixture.resume.sessionId,
            "resume returned a different session",
          );
        }

        const staleResumeCategory =
          probe.capabilities.resume === "supported" ? "stale-resume" : probe.capabilities.resume;
        assertConformance(
          fixture.expectedFailureCategories.staleResume === staleResumeCategory,
          "stale-resume fixture category contradicts the capability report",
        );
        assertExpectedFailure(
          "stale resume",
          yield* Effect.exit(connection.resume(fixture.staleResume)),
          fixture.expectedFailureCategories.staleResume,
        );

        const unknownApprovalCategory = expectedUnknownRequestCategory(
          probe.capabilities.approvals,
        );
        assertConformance(
          fixture.expectedFailureCategories.unknownApproval === unknownApprovalCategory,
          "unknown-approval fixture category contradicts the capability report",
        );
        assertCapabilityFailure(
          "approvals",
          probe.capabilities.approvals,
          yield* Effect.exit(connection.answerApproval(fixture.unknownApproval)),
          "protocol",
        );

        const unknownUserInputCategory = expectedUnknownRequestCategory(
          probe.capabilities.userQuestions,
        );
        assertConformance(
          fixture.expectedFailureCategories.unknownUserInput === unknownUserInputCategory,
          "unknown-input fixture category contradicts the capability report",
        );
        assertCapabilityFailure(
          "userQuestions",
          probe.capabilities.userQuestions,
          yield* Effect.exit(connection.answerUserInput(fixture.unknownUserInput)),
          "protocol",
        );

        yield* connection.stop(fixture.sessionStart.sessionId);

        return {
          probed: true,
          capabilityHonest: true,
          usageCapabilityHonest: true,
          researchCapabilityHonest: true,
          citationsCapabilityHonest: true,
          streamedInOrder: true,
          interrupted: true,
          resumed: true,
          staleResumeRejected: true,
          unknownApprovalRejected: true,
          unknownUserInputRejected: true,
          failureClassified: true,
        };
      }),
    ),
  );

  assertConformance(fixture.isReleased(), "connection scope was not finalized");
  return { ...evidence, released: true };
}

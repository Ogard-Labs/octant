import type {
  CorrelationId,
  ProviderCapabilities,
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
  ProviderProbeResult,
  ProviderResumeCursor,
  ProviderRuntimeEvent,
  ProviderSessionId,
  UtcTimestamp,
} from "@octant/contracts";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  runProviderConformance,
  runSessionCompactionConformance,
  type ProviderConformanceFixture,
  type ProviderConnection,
  type ProviderSessionCompaction,
  type ProviderSessionCompactionConformanceFixture,
} from "./index";

const instanceId = "10000000-0000-4000-8000-000000000001" as ProviderInstanceId;
const sessionId = "20000000-0000-4000-8000-000000000002" as ProviderSessionId;
const modelId = "octant-test-model" as ProviderModelId;
const correlationId = "30000000-0000-4000-8000-000000000003" as CorrelationId;
const occurredAt = "2026-07-14T10:00:00.000Z" as UtcTimestamp;
const resumeCursor = {
  driverKind: "opencode",
  value: "resume-1",
} as const satisfies ProviderResumeCursor;

const supportedCapabilities: ProviderCapabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "supported",
  harnessAutoReview: "unsupported",
  nativeAttachments: "unavailable",
  nativeWebResearch: "supported",
  appManagedTools: "unavailable",
  citations: "supported",
};

const failure = (category: ProviderFailure["category"], message: string): ProviderFailure => ({
  category,
  message,
});

function makeFakeFixture(options?: {
  readonly interruptFailure?: ProviderFailure;
  readonly resumeFailure?: ProviderFailure;
  readonly approvalFailure?: ProviderFailure;
  readonly userInputFailure?: ProviderFailure;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly omitEventKinds?: ReadonlyArray<ProviderRuntimeEvent["kind"]>;
  /** The two text chunks the turn streams, in place of "hello" and " world". */
  readonly replyChunks?: readonly [string, string];
  readonly expectedReply?: string;
}): ProviderConformanceFixture {
  let acquired = false;
  let released = false;
  const defaultEvents: ReadonlyArray<ProviderRuntimeEvent> = [
    {
      kind: "text-delta",
      instanceId,
      sessionId,
      sequence: 1,
      correlationId,
      occurredAt,
      text: options?.replyChunks?.[0] ?? "hello",
    },
    {
      kind: "text-delta",
      instanceId,
      sessionId,
      sequence: 2,
      correlationId,
      occurredAt,
      text: options?.replyChunks?.[1] ?? " world",
    },
    {
      kind: "reasoning-delta",
      instanceId,
      sessionId,
      sequence: 3,
      correlationId,
      occurredAt,
      text: "reasoning",
    },
    {
      kind: "usage",
      instanceId,
      sessionId,
      sequence: 4,
      correlationId,
      occurredAt,
      inputTokens: 4,
      outputTokens: 2,
    },
    {
      kind: "tool-start",
      instanceId,
      sessionId,
      sequence: 5,
      correlationId,
      occurredAt,
      toolCallId: "tool-1",
      toolName: "read",
    },
    {
      kind: "tool-success",
      instanceId,
      sessionId,
      sequence: 6,
      correlationId,
      occurredAt,
      toolCallId: "tool-1",
      summary: "Read complete.",
    },
    {
      kind: "file-change",
      instanceId,
      sessionId,
      sequence: 7,
      correlationId,
      occurredAt,
      path: "src/index.ts",
      change: "modified",
    },
    {
      kind: "diff",
      instanceId,
      sessionId,
      sequence: 8,
      correlationId,
      occurredAt,
      diff: "+export const value = true;",
    },
    {
      kind: "task-progress",
      instanceId,
      sessionId,
      sequence: 9,
      correlationId,
      occurredAt,
      taskId: "task-1",
      status: "completed",
      summary: "Task complete.",
    },
    {
      kind: "child-agent-activity",
      instanceId,
      sessionId,
      sequence: 10,
      correlationId,
      occurredAt,
      childAgentId: "child-1",
      status: "completed",
      summary: "Child complete.",
    },
    {
      kind: "approval-request",
      instanceId,
      sessionId,
      sequence: 11,
      correlationId,
      occurredAt,
      requestId: "approval-1",
      action: "write",
      description: "Write a file.",
    },
    {
      kind: "user-input-request",
      instanceId,
      sessionId,
      sequence: 12,
      correlationId,
      occurredAt,
      requestId: "question-1",
      prompt: "Choose an option.",
      options: [{ label: "one" }, { label: "two" }],
    },
    {
      kind: "research-started",
      instanceId,
      sessionId,
      sequence: 13,
      correlationId,
      occurredAt,
      researchId: "research-1",
      query: "Octant provider conformance",
      backend: "provider-native",
    },
    {
      kind: "research-completed",
      instanceId,
      sessionId,
      sequence: 14,
      correlationId,
      occurredAt,
      researchId: "research-1",
      sourceCount: 1,
    },
    {
      kind: "citation",
      instanceId,
      sessionId,
      sequence: 15,
      correlationId,
      occurredAt,
      citationId: "citation-1",
      sourceTitle: "Octant documentation",
      sourceUrl: "https://example.invalid/octant",
      snippet: "Provider conformance evidence.",
    },
    {
      kind: "interrupted",
      instanceId,
      sessionId,
      sequence: 16,
      correlationId,
      occurredAt,
      message: "Interrupted by the user.",
    },
  ];
  const events = defaultEvents.filter((event) => !options?.omitEventKinds?.includes(event.kind));

  const capabilities = { ...supportedCapabilities, ...options?.capabilities };
  const unsupportedCategory = (support: "unsupported" | "unavailable") =>
    failure(support, `The capability is ${support}.`);

  const connection: ProviderConnection = {
    subscribe: Effect.succeed(Stream.fromIterable(events)),
    start: () => Effect.succeed({ sessionId, resumeCursor }),
    resume: (input) =>
      options?.resumeFailure !== undefined
        ? Effect.fail(options.resumeFailure)
        : capabilities.resume !== "supported"
          ? Effect.fail(unsupportedCategory(capabilities.resume))
          : input.resumeCursor.value === resumeCursor.value
            ? Effect.succeed({ sessionId, resumeCursor })
            : Effect.fail(failure("stale-resume", "The resume cursor is stale.")),
    send: () => Effect.void,
    interrupt: () =>
      options?.interruptFailure !== undefined
        ? Effect.fail(options.interruptFailure)
        : capabilities.interruption === "supported"
          ? Effect.void
          : Effect.fail(unsupportedCategory(capabilities.interruption)),
    stop: () => Effect.void,
    answerApproval: () =>
      Effect.fail(
        options?.approvalFailure ??
          (capabilities.approvals === "supported"
            ? failure("protocol", "The approval request is unknown.")
            : unsupportedCategory(capabilities.approvals)),
      ),
    answerUserInput: () =>
      Effect.fail(
        options?.userInputFailure ??
          (capabilities.userQuestions === "supported"
            ? failure("protocol", "The user input request is unknown.")
            : unsupportedCategory(capabilities.userQuestions)),
      ),
    answerTool: () => Effect.fail(failure("unavailable", "App-managed tools are unavailable.")),
  };

  const probeResult: ProviderProbeResult = {
    instanceId,
    readiness: "ready",
    processState: "running",
    detectedVersion: "1.0.0",
    models: [],
    capabilities,
    observedAt: occurredAt,
  };

  return {
    driver: {
      kind: "opencode",
      probe: () => Effect.succeed(probeResult),
      acquire: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired = true;
            return connection;
          }),
          () =>
            Effect.sync(() => {
              released = true;
            }),
        ),
    },
    probeInput: { instanceId },
    acquireInput: { instanceId, projectRoot: "/tmp/octant-project" },
    sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
    turn: { sessionId, prompt: "Say hello.", attachments: [], tools: [] },
    resume: { sessionId, resumeCursor, executionPolicy: "approval-gated" },
    staleResume: {
      sessionId,
      resumeCursor: { ...resumeCursor, value: "stale-resume" },
      executionPolicy: "approval-gated",
    },
    unknownApproval: { sessionId, requestId: "missing-approval", approved: false },
    unknownUserInput: { sessionId, requestId: "missing-question", answer: "none" },
    expectedEventKinds: events.map((event) => event.kind),
    ...(options?.expectedReply === undefined ? {} : { expectedReply: options.expectedReply }),
    expectedFailureCategories: {
      staleResume: capabilities.resume === "supported" ? "stale-resume" : capabilities.resume,
      unknownApproval: capabilities.approvals === "supported" ? "protocol" : capabilities.approvals,
      unknownUserInput:
        capabilities.userQuestions === "supported" ? "protocol" : capabilities.userQuestions,
    },
    isReleased: () => acquired && released,
  };
}

describe("runProviderConformance", () => {
  it("exercises lifecycle, interruption, resume, and scoped cleanup", async () => {
    const evidence = await runProviderConformance(makeFakeFixture());

    expect(evidence).toMatchObject({
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
      released: true,
    });
  });

  it("carries a closing decision block whole when the provider splits it across chunks", async () => {
    const replyChunks = [
      "The fix is ready.\n\n```octant-deci",
      'sion\n{"ask":"Open the pull request?","options":[{"label":"Open it","recommended":true}]}\n```',
    ] as const;
    await expect(
      runProviderConformance(makeFakeFixture({ replyChunks, expectedReply: replyChunks.join("") })),
    ).resolves.toMatchObject({ streamedInOrder: true });
    await expect(
      runProviderConformance(
        makeFakeFixture({ replyChunks, expectedReply: `${replyChunks.join("")}\n\nExtra.` }),
      ),
    ).rejects.toThrow(/reply whole and in order/);
  });

  it("rejects streamed-in-order evidence when no normalized text was observed", async () => {
    await expect(
      runProviderConformance(
        makeFakeFixture({
          capabilities: { streaming: "unavailable" },
          omitEventKinds: ["text-delta"],
        }),
      ),
    ).rejects.toThrow(/stream.*text/i);
  });

  it("rejects a supported capability that fails as unsupported", async () => {
    await expect(
      runProviderConformance(
        makeFakeFixture({
          interruptFailure: failure("unsupported", "Interruption is unsupported."),
        }),
      ),
    ).rejects.toThrow(/interruption.*supported/i);
  });

  const eventCapabilityCases = [
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
  ] as const satisfies ReadonlyArray<
    readonly [keyof ProviderCapabilities, ReadonlyArray<ProviderRuntimeEvent["kind"]>]
  >;

  it("accepts normalized complete text while native streaming is unsupported", async () => {
    await expect(
      runProviderConformance(makeFakeFixture({ capabilities: { streaming: "unsupported" } })),
    ).resolves.toMatchObject({ streamedInOrder: true });
  });

  it.each(eventCapabilityCases)(
    "rejects supported %s when its normalized event is omitted",
    async (capability, eventKinds) => {
      const complete = makeFakeFixture();
      const events = complete.expectedEventKinds;
      const fixture = makeFakeFixture({
        omitEventKinds: eventKinds,
      });
      expect(events).toContain(eventKinds[0]);
      await expect(runProviderConformance(fixture)).rejects.toThrow(
        new RegExp(`${capability}.*supported.*(?:event|delta)`, "i"),
      );
    },
  );

  it.each(
    eventCapabilityCases.flatMap(([capability]) =>
      (["unsupported", "unavailable"] as const).map((support) => [capability, support] as const),
    ),
  )("rejects %s events when the capability is %s", async (capability, support) => {
    await expect(
      runProviderConformance(makeFakeFixture({ capabilities: { [capability]: support } })),
    ).rejects.toThrow(new RegExp(`${capability}.*${support}.*(?:event|delta)`, "i"));
  });

  it.each([
    ["interruption", "unsupported", "unavailable"],
    ["interruption", "unavailable", "unsupported"],
    ["resume", "unsupported", "unavailable"],
    ["resume", "unavailable", "unsupported"],
    ["approvals", "unsupported", "unavailable"],
    ["approvals", "unavailable", "unsupported"],
    ["userQuestions", "unsupported", "unavailable"],
    ["userQuestions", "unavailable", "unsupported"],
  ] as const)(
    "requires exact %s classification when claimed %s but failed %s",
    async (capability, support, actualFailure) => {
      await expect(
        runProviderConformance(
          makeFakeFixture({
            capabilities: { [capability]: support },
            ...(capability === "interruption"
              ? { omitEventKinds: ["interrupted"] as const }
              : capability === "approvals"
                ? { omitEventKinds: ["approval-request"] as const }
                : capability === "userQuestions"
                  ? { omitEventKinds: ["user-input-request"] as const }
                  : {}),
            ...(capability === "interruption" && {
              interruptFailure: failure(actualFailure, "Mismatched interruption failure."),
            }),
            ...(capability === "resume" && {
              resumeFailure: failure(actualFailure, "Mismatched resume failure."),
            }),
            ...(capability === "approvals" && {
              approvalFailure: failure(actualFailure, "Mismatched approval failure."),
            }),
            ...(capability === "userQuestions" && {
              userInputFailure: failure(actualFailure, "Mismatched user-input failure."),
            }),
          }),
        ),
      ).rejects.toThrow(new RegExp(`${capability}.*${support}.*${actualFailure}`, "i"));
    },
  );
});

describe("session compaction conformance", () => {
  function compactionFixture(options: {
    readonly claim?: "supported" | "unsupported" | "unavailable";
    readonly compact?: "compacts" | "compacts-silently" | "refuses-version" | "absent";
    /** The runtime holds the compaction until released; `accepts` takes a turn meanwhile. */
    readonly hold?: "refuses-turns" | "accepts-turns";
  }): ProviderSessionCompactionConformanceFixture {
    let released = false;
    let compacting = false;
    const hold = Promise.withResolvers<void>();
    let sequence = 0;
    const base = () => ({ instanceId, sessionId, sequence: ++sequence, correlationId, occurredAt });
    const capabilities: ProviderCapabilities = {
      ...supportedCapabilities,
      ...(options.claim === undefined
        ? {}
        : { sessionCompaction: { chat: options.claim, work: options.claim, code: options.claim } }),
    };
    const driver = {
      kind: "opencode" as const,
      probe: () =>
        Effect.succeed({
          instanceId,
          readiness: "ready" as const,
          processState: "running" as const,
          detectedVersion: "1.0.0",
          models: [],
          capabilities,
          observedAt: occurredAt,
        }),
      acquire: () =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
            const emit = (event: ProviderRuntimeEvent) => Queue.offer(queue, event);
            const held = <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
              options.hold === undefined
                ? effect
                : Effect.acquireUseRelease(
                    Effect.sync(() => {
                      compacting = true;
                    }),
                    () =>
                      Effect.zipRight(
                        Effect.promise(() => hold.promise),
                        effect,
                      ),
                    () =>
                      Effect.sync(() => {
                        compacting = false;
                      }),
                  );
            const compact = (): Effect.Effect<ProviderSessionCompaction> => {
              switch (options.compact) {
                case "refuses-version":
                  return Effect.succeed({
                    kind: "refused",
                    reason: "runtime-version-unsupported",
                  });
                case "compacts-silently":
                  return Effect.succeed({ kind: "compacted" });
                default:
                  return held(
                    emit({
                      ...base(),
                      kind: "context-compacted",
                      trigger: "requested",
                      tokensBefore: 900,
                      tokensAfter: 120,
                    }).pipe(Effect.as({ kind: "compacted", tokensBefore: 900, tokensAfter: 120 })),
                  );
              }
            };
            const connection: ProviderConnection = {
              subscribe: Effect.succeed(Stream.fromQueue(queue)),
              start: () => Effect.succeed({ sessionId, resumeCursor }),
              resume: () => Effect.succeed({ sessionId, resumeCursor }),
              send: () =>
                compacting && options.hold === "refuses-turns"
                  ? Effect.fail(failure("unavailable", "The session is compacting."))
                  : Effect.zipRight(
                      emit({ ...base(), kind: "text-delta", text: "hello" }),
                      emit({ ...base(), kind: "completed" }),
                    ),
              ...(options.compact === "absent" ? {} : { compact }),
              interrupt: () => Effect.void,
              stop: () => Effect.void,
              answerApproval: () => Effect.fail(failure("protocol", "No approval is pending.")),
              answerUserInput: () => Effect.fail(failure("protocol", "No question is pending.")),
              answerTool: () => Effect.fail(failure("unavailable", "No tools.")),
            };
            return connection;
          }),
          () =>
            Effect.sync(() => {
              released = true;
            }),
        ),
    };
    return {
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-provider-conformance", mode: "work" },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turns: [
        { sessionId, prompt: "Remember the plan.", attachments: [], tools: [] },
        { sessionId, prompt: "Carry on.", attachments: [], tools: [] },
      ],
      resume: (handle) => ({
        sessionId: handle.sessionId,
        resumeCursor: handle.resumeCursor ?? resumeCursor,
        executionPolicy: "approval-gated",
      }),
      compactionId: "40000000-0000-4000-8000-000000000004",
      ...(options.hold === undefined ? {} : { releaseCompaction: () => hold.resolve() }),
      isReleased: () => released,
    };
  }

  it("accepts a driver that compacts, reports it before answering, and resumes afterwards", async () => {
    await expect(
      runSessionCompactionConformance(
        compactionFixture({ claim: "supported", compact: "compacts" }),
      ),
    ).resolves.toEqual({
      claim: "supported",
      compacted: true,
      turnRefusedWhileCompacting: false,
      released: true,
    });
  });

  it("refuses a turn offered while the compaction is still pending", async () => {
    await expect(
      runSessionCompactionConformance(
        compactionFixture({ claim: "supported", compact: "compacts", hold: "refuses-turns" }),
      ),
    ).resolves.toMatchObject({ compacted: true, turnRefusedWhileCompacting: true });
    await expect(
      runSessionCompactionConformance(
        compactionFixture({ claim: "supported", compact: "compacts", hold: "accepts-turns" }),
      ),
    ).rejects.toThrow(/a turn was accepted while a compaction was pending/);
  });

  it("accepts a driver that claims nothing and offers no compact", async () => {
    await expect(
      runSessionCompactionConformance(compactionFixture({ compact: "absent" })),
    ).resolves.toEqual({
      claim: "unsupported",
      compacted: false,
      turnRefusedWhileCompacting: false,
      released: true,
    });
  });

  it("accepts an install too old for the request when compact refuses it", async () => {
    await expect(
      runSessionCompactionConformance(
        compactionFixture({ claim: "unavailable", compact: "refuses-version" }),
      ),
    ).resolves.toEqual({
      claim: "unavailable",
      compacted: false,
      turnRefusedWhileCompacting: false,
      released: true,
    });
  });

  it("refuses a claim the connection cannot honor", async () => {
    await expect(
      runSessionCompactionConformance(compactionFixture({ claim: "supported", compact: "absent" })),
    ).rejects.toThrow(/claimed as supported but the connection cannot compact/);
    await expect(
      runProviderConformance({
        ...makeFakeFixture({
          capabilities: {
            sessionCompaction: { chat: "supported", work: "supported", code: "supported" },
          },
        }),
        acquireInput: { instanceId, projectRoot: "/tmp/octant-provider-conformance", mode: "chat" },
      }),
    ).rejects.toThrow(/claimed as supported but the connection cannot compact/);
  });

  it("refuses a compact offered by a driver that claims it cannot compact", async () => {
    await expect(
      runSessionCompactionConformance(compactionFixture({ compact: "compacts" })),
    ).rejects.toThrow(/claimed as unsupported but the connection offers to compact/);
  });

  it("refuses a compaction that never reports itself on the session's events", async () => {
    await expect(
      runSessionCompactionConformance(
        compactionFixture({ claim: "supported", compact: "compacts-silently" }),
      ),
    ).rejects.toThrow(/without a requested context-compacted event/);
  }, 10_000);
});

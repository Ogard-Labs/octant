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
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  runProviderConformance,
  type ProviderConformanceFixture,
  type ProviderConnection,
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
      text: "hello",
    },
    {
      kind: "text-delta",
      instanceId,
      sessionId,
      sequence: 2,
      correlationId,
      occurredAt,
      text: " world",
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
      options: ["one", "two"],
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
    events: Stream.fromIterable(events),
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

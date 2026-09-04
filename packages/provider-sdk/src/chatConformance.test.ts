import type {
  CorrelationId,
  ProviderCapabilities,
  ProviderFailure,
  ProviderInstanceId,
  ProviderModel,
  ProviderModelId,
  ProviderProbeResult,
  ProviderRuntimeEvent,
  ProviderSessionId,
  UtcTimestamp,
} from "@octant/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  renderProviderTurnPrompt,
  runProviderChatConformance,
  type ProviderChatConformanceFixture,
  type ProviderConnection,
} from "./index";

const instanceId = "10000000-0000-4000-8000-000000000001" as ProviderInstanceId;
const sessionId = "20000000-0000-4000-8000-000000000002" as ProviderSessionId;
const modelId = "octant-test-model" as ProviderModelId;
const correlationId = "30000000-0000-4000-8000-000000000003" as CorrelationId;
const occurredAt = "2026-07-14T10:00:00.000Z" as UtcTimestamp;

const researchInputSchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
} as const;

const chatTurn = {
  sessionId,
  prompt: "Compare the attached image with current sources.",
  attachments: [
    {
      attachmentId: "attachment-1",
      displayName: "diagram.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    },
  ],
  tools: [{ name: "octant_web_research", inputSchema: researchInputSchema }],
} as const;

describe("renderProviderTurnPrompt", () => {
  it("preserves plain prompts and frames normalized context explicitly", () => {
    expect(renderProviderTurnPrompt({ prompt: "Current", context: [] })).toBe("Current");
    const rendered = renderProviderTurnPrompt({
      prompt: "Current",
      context: [
        { kind: "instructions", text: "Stay concise." },
        { kind: "user-message", text: "Earlier question" },
      ],
    });
    expect(rendered).toContain('"kind":"instructions"');
    expect(rendered).toContain('"text":"Earlier question"');
    expect(rendered.endsWith("Current request:\nCurrent")).toBe(true);
  });
});

const supportedChatCapabilities: ProviderCapabilities = {
  streaming: "supported",
  resume: "unsupported",
  interruption: "unsupported",
  approvals: "unsupported",
  userQuestions: "unsupported",
  reasoning: "unsupported",
  usage: "unsupported",
  toolActivity: "unsupported",
  fileChanges: "unsupported",
  diffs: "unsupported",
  taskProgress: "unsupported",
  nativeChildAgents: "unsupported",
  nativeAttachments: "supported",
  nativeWebResearch: "supported",
  appManagedTools: "supported",
  citations: "supported",
};

const supportedModel: ProviderModel = {
  id: modelId,
  displayName: "Chat test model",
  source: "discovered",
  verification: "verified",
  reasoning: "unsupported",
  inputModalities: ["text", "image"],
  options: [],
};

const failure = (category: ProviderFailure["category"], message: string): ProviderFailure => ({
  category,
  message,
});

function makeChatFixture(options?: {
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly model?: ProviderModel;
  readonly sendFailure?: ProviderFailure;
  readonly omitCitation?: boolean;
  readonly omitResearchCompleted?: boolean;
  readonly waitForToolAnswerBeforeTerminal?: boolean;
  readonly duplicateTerminalSequence?: boolean;
}): ProviderChatConformanceFixture {
  let acquired = false;
  let released = false;
  const toolRequestId = "tool-request-1";
  let releaseTerminal = () => {};
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  const capabilities = { ...supportedChatCapabilities, ...options?.capabilities };
  const model = options?.model ?? supportedModel;

  const events: ReadonlyArray<ProviderRuntimeEvent> = [
    {
      kind: "research-started",
      instanceId,
      sessionId,
      sequence: 1,
      correlationId,
      occurredAt,
      researchId: "research-1",
      query: "current sources",
      backend: "provider-native",
    },
    {
      kind: "tool-request",
      instanceId,
      sessionId,
      sequence: 2,
      correlationId,
      occurredAt,
      requestId: toolRequestId,
      toolName: "octant_web_research",
      inputJson: JSON.stringify({ query: "current sources" }),
    },
    ...(options?.omitCitation
      ? []
      : [
          {
            kind: "citation" as const,
            instanceId,
            sessionId,
            sequence: 3,
            correlationId,
            occurredAt,
            citationId: "citation-1",
            sourceTitle: "Example source",
            sourceUrl: "https://example.com/source",
            snippet: "A normalized snippet.",
          },
        ]),
    ...(options?.omitResearchCompleted
      ? []
      : [
          {
            kind: "research-completed" as const,
            instanceId,
            sessionId,
            sequence: options?.omitCitation ? 3 : 4,
            correlationId,
            occurredAt,
            researchId: "research-1",
            sourceCount: 1,
          },
        ]),
    {
      kind: "text-delta",
      instanceId,
      sessionId,
      sequence: options?.omitCitation ? 4 : 5,
      correlationId,
      occurredAt,
      text: "Compared the attachment with current sources.",
    },
    {
      kind: "completed",
      instanceId,
      sessionId,
      sequence: options?.duplicateTerminalSequence
        ? options?.omitCitation
          ? 4
          : 5
        : options?.omitCitation
          ? 5
          : 6,
      correlationId,
      occurredAt,
    },
  ];

  const toolRequestIndex = events.findIndex((event) => event.kind === "tool-request");
  const beforeToolAnswer = events.slice(0, toolRequestIndex + 1);
  const afterToolAnswer = events.slice(toolRequestIndex + 1);
  const eventStream = options?.waitForToolAnswerBeforeTerminal
    ? Stream.concat(
        Stream.fromIterable(beforeToolAnswer),
        Stream.fromEffect(Effect.promise(() => terminalGate)).pipe(
          Stream.flatMap(() => Stream.fromIterable(afterToolAnswer)),
        ),
      )
    : Stream.fromIterable(events);

  const connection: ProviderConnection = {
    subscribe: Effect.succeed(eventStream),
    start: () => Effect.succeed({ sessionId }),
    resume: () => Effect.fail(failure("unsupported", "Resume is unsupported.")),
    send: (input) =>
      options?.sendFailure !== undefined
        ? Effect.fail(options.sendFailure)
        : capabilities.nativeAttachments !== "supported" && input.attachments.length > 0
          ? Effect.fail(
              failure(capabilities.nativeAttachments, "Native attachments are unavailable."),
            )
          : capabilities.appManagedTools !== "supported" && input.tools.length > 0
            ? Effect.fail(
                failure(capabilities.appManagedTools, "App-managed tools are unavailable."),
              )
            : Effect.void,
    interrupt: () => Effect.void,
    stop: () => Effect.void,
    answerApproval: () => Effect.fail(failure("unsupported", "Approvals are unsupported.")),
    answerUserInput: () => Effect.fail(failure("unsupported", "User questions are unsupported.")),
    answerTool: (input) =>
      capabilities.appManagedTools !== "supported"
        ? Effect.fail(failure(capabilities.appManagedTools, "App-managed tools are unavailable."))
        : input.requestId === toolRequestId
          ? Effect.sync(releaseTerminal)
          : Effect.fail(failure("protocol", "The tool request is unknown.")),
  };

  const probeResult: ProviderProbeResult = {
    instanceId,
    readiness: "ready",
    processState: "running",
    detectedVersion: "1.0.0",
    models: [model],
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
    acquireInput: { instanceId, projectRoot: "/tmp/octant-project", mode: "chat" },
    sessionStart: { sessionId, modelId, executionPolicy: "full-access" },
    turn: chatTurn,
    toolAnswer: {
      sessionId,
      requestId: toolRequestId,
      resultJson: JSON.stringify({
        sources: [{ title: "Example source", url: "https://example.com/source" }],
      }),
      isError: false,
    },
    isReleased: () => acquired && released,
  };
}

describe("runProviderChatConformance", () => {
  it("proves honest supported attachment, tool, and citation behavior", async () => {
    const evidence = await runProviderChatConformance(makeChatFixture());

    expect(evidence.nativeAttachmentHonest).toBe(true);
    expect(evidence.appManagedToolRoundTrip).toBe(true);
    expect(evidence.citationsNormalized).toBe(true);
    expect(evidence.released).toBe(true);
  });

  it("answers a tool request before waiting for the provider terminal event", async () => {
    const result = runProviderChatConformance(
      makeChatFixture({ waitForToolAnswerBeforeTerminal: true }),
    );
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("tool answer was not delivered before terminal wait")),
        250,
      );
    });

    await expect(Promise.race([result, timeout])).resolves.toMatchObject({
      appManagedToolRoundTrip: true,
      released: true,
    });
  });

  it("proves explicit unsupported native attachments before sending", async () => {
    const evidence = await runProviderChatConformance(
      makeChatFixture({
        capabilities: { nativeAttachments: "unsupported" },
        sendFailure: failure("unsupported", "Native attachments are unsupported."),
      }),
    );

    expect(evidence.nativeAttachmentHonest).toBe(true);
    expect(evidence.released).toBe(true);
  });

  it("proves explicit unsupported app-managed tools before sending", async () => {
    const evidence = await runProviderChatConformance(
      makeChatFixture({
        capabilities: { appManagedTools: "unsupported" },
        sendFailure: failure("unsupported", "App-managed tools are unsupported."),
      }),
    );

    expect(evidence.appManagedToolRoundTrip).toBe(true);
    expect(evidence.released).toBe(true);
  });

  it("rejects citation events when citations are unsupported", async () => {
    await expect(
      runProviderChatConformance(makeChatFixture({ capabilities: { citations: "unsupported" } })),
    ).rejects.toThrow(/citations.*unsupported/i);
  });

  it("requires a complete native research lifecycle when support is claimed", async () => {
    await expect(
      runProviderChatConformance(makeChatFixture({ omitResearchCompleted: true })),
    ).rejects.toThrow(/nativeWebResearch.*research-completed/i);
  });

  it("does not claim attachment honesty from an ambiguous mixed failure", async () => {
    await expect(
      runProviderChatConformance(
        makeChatFixture({
          capabilities: { appManagedTools: "unsupported" },
          sendFailure: failure("unsupported", "App-managed tools are unsupported."),
        }),
      ),
    ).resolves.toMatchObject({ nativeAttachmentHonest: false, appManagedToolRoundTrip: true });
  });

  it("rejects non-increasing normalized event sequences", async () => {
    await expect(
      runProviderChatConformance(makeChatFixture({ duplicateTerminalSequence: true })),
    ).rejects.toThrow(/event sequence/i);
  });
});

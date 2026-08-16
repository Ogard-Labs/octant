import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import type { Event } from "@opencode-ai/sdk/v2/types";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeOpenCodeDriver, type OpenCodeClientPort } from "./openCodeDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000201");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000202");
const modelId = "anthropic/claude-sonnet" as ProviderModelId;
const projectRoot = "/tmp/octant-conformance";

describe("OpenCode provider conformance", () => {
  it("passes the provider-neutral lifecycle, capability, resume, and cleanup harness", async () => {
    const source = new EventSourceFixture();
    const registry = new ProviderRuntimeRegistry();
    let released = false;
    const session = {
      id: "provider-session",
      slug: "s",
      projectID: "p",
      directory: projectRoot,
      title: "t",
      version: "1",
      time: { created: 1, updated: 1 },
    } as const;
    const client: OpenCodeClientPort = {
      health: async () => ({ healthy: true, version: "1.18.0" }),
      providers: async () => ({ all: [provider()], connected: ["anthropic"] }),
      subscribe: async () => source,
      createSession: async () => session,
      getSession: async (id) => {
        if (id === "stale") throw new Error("not found");
        return session;
      },
      prompt: async () => {
        for (const event of runtimeEvents(session.id)) source.emit(event);
      },
      abort: async () => {
        source.emit({
          type: "session.error",
          properties: {
            sessionID: session.id,
            error: { name: "MessageAbortedError", data: { message: "aborted" } },
          },
        } as Event);
      },
      replyPermission: async () => undefined,
      replyQuestion: async () => undefined,
    };
    const driver = makeOpenCodeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/opencode",
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              authorization: "Basic redacted",
              pid: process.pid,
              url: new URL("http://127.0.0.1:1/"),
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      },
      runtimeRegistry: registry,
      clientFactory: () => client,
      idleLeaseMs: 0,
      permissionPersistence: () => "current-session",
      clock: () => "2026-07-15T00:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000203",
    });
    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
      resume: {
        sessionId,
        resumeCursor: { driverKind: "opencode", value: "provider-session" },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId,
        resumeCursor: { driverKind: "opencode", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId, requestId: "unknown", approved: false },
      unknownUserInput: { sessionId, requestId: "unknown", answer: "none" },
      expectedEventKinds: [
        "text-delta",
        "reasoning-delta",
        "tool-start",
        "tool-success",
        "usage",
        "diff",
        "task-progress",
        "approval-request",
        "user-input-request",
        "interrupted",
      ],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "protocol",
        unknownUserInput: "protocol",
      },
      isReleased: () => released,
    });
    const chatEvidence = await runProviderChatConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: {
        sessionId,
        prompt: "hello",
        attachments: [],
        tools: [
          {
            name: "octant_web_research",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
      isReleased: () => released,
    });
    recordProviderConformanceEvidence("opencode", evidence);
    recordProviderChatConformanceEvidence("opencode", chatEvidence);
    expect(evidence).toEqual({
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
    expect(chatEvidence).toMatchObject({ appManagedToolRoundTrip: true, released: true });
  });
});

class EventSourceFixture implements AsyncIterable<Event> {
  readonly #events: Event[] = [];
  readonly #waiters: Array<(value: IteratorResult<Event>) => void> = [];
  emit(event: Event): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter({ value: event, done: false });
  }
  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: async () => {
        const event = this.#events.shift();
        if (event !== undefined) return { value: event, done: false };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function provider() {
  const model = {
    id: "claude-sonnet",
    providerID: "anthropic",
    name: "Claude Sonnet",
    api: { id: "x", url: "https://example.invalid", npm: "x" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: { low: {}, high: {} },
  } as const;
  return {
    id: "anthropic",
    name: "Anthropic",
    source: "config" as const,
    env: [],
    options: {},
    models: { [model.id]: model },
  };
}

function runtimeEvents(sourceId: string): ReadonlyArray<Event> {
  return [
    {
      type: "session.next.text.delta",
      properties: { id: "e1", sessionID: sourceId, messageID: "m", partID: "p", delta: "hello" },
    },
    {
      type: "session.next.reasoning.delta",
      properties: { id: "e2", sessionID: sourceId, messageID: "m", partID: "r", delta: "think" },
    },
    {
      type: "session.next.tool.called",
      properties: {
        id: "e3",
        sessionID: sourceId,
        messageID: "m",
        partID: "t",
        callID: "c",
        tool: "read",
        args: {},
      },
    },
    {
      type: "session.next.tool.success",
      properties: {
        id: "e4",
        sessionID: sourceId,
        messageID: "m",
        partID: "t",
        callID: "c",
        tool: "read",
        args: {},
        result: "ok",
        time: { start: 1, end: 2 },
      },
    },
    {
      type: "session.next.step.ended",
      properties: {
        id: "e5",
        sessionID: sourceId,
        messageID: "m",
        partID: "s",
        reason: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
    {
      type: "session.diff",
      properties: {
        sessionID: sourceId,
        diff: [{ file: "README.md", patch: "+x", additions: 1, deletions: 0 }],
      },
    },
    {
      type: "todo.updated",
      properties: {
        sessionID: sourceId,
        todos: [{ content: "test", status: "pending", priority: "medium" }],
      },
    },
    {
      type: "permission.asked",
      properties: {
        id: "permission",
        sessionID: sourceId,
        permission: "edit",
        patterns: ["*"],
        metadata: {},
        always: [],
      },
    },
    {
      type: "question.asked",
      properties: {
        id: "question",
        sessionID: sourceId,
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      },
    },
  ] as unknown as ReadonlyArray<Event>;
}

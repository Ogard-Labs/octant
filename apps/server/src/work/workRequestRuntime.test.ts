import {
  decodeWorkRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderSessionId,
  CorrelationId,
  UtcTimestamp,
  type WorkRequestRecordInput,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { ShieldDecision } from "@octant/contracts";
import type { ShieldReviewPort } from "../shield/octantShield";
import { attachWorkRequestRuntime, WorkRequestRuntime } from "./workRequestRuntime";

const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000902");
const providerInstanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000903");
const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000904");
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

describe("WorkRequestRuntime", () => {
  it("records approval and user-input events from the owning provider session", async () => {
    const record = vi.fn((_input: unknown) => ({ status: "ok" as const, request: {} as never }));
    let sequence = 904;
    const runtime = new WorkRequestRuntime({
      requests: { record } as never,
      uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const connection = {
      subscribe: Effect.succeed(
        Stream.fromIterable<ProviderRuntimeEvent>([
          {
            instanceId: providerInstanceId,
            sequence: 1,
            correlationId: decodeCorrelationId(String(projectId)),
            occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
            kind: "approval-request",
            sessionId,
            requestId: "approval-1",
            action: "run-terminal-command",
            description: "Run a command",
          },
          {
            instanceId: providerInstanceId,
            sequence: 2,
            correlationId: decodeCorrelationId(String(projectId)),
            occurredAt: decodeTimestamp("2026-08-10T08:00:01.000Z"),
            kind: "user-input-request",
            sessionId,
            requestId: "input-1",
            prompt: "Choose a format",
            options: [{ label: "PDF" }],
          },
        ]),
      ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt: () => Effect.void,
    };

    await Effect.runPromise(
      runtime.subscribe({
        connection,
        projectId,
        threadId,
        providerInstanceId,
        sessionId,
      }),
    );

    expect(record).toHaveBeenNthCalledWith(1, {
      requestId: decodeWorkRequestId("00000000-0000-4000-8000-000000000905"),
      projectId,
      threadId,
      providerInstanceId,
      providerSessionId: sessionId,
      providerCallbackId: "approval-1",
      detail: {
        kind: "approval",
        action: "run-terminal-command",
        description: "Run a command",
      },
    });
    expect(record).toHaveBeenNthCalledWith(2, {
      requestId: decodeWorkRequestId("00000000-0000-4000-8000-000000000906"),
      projectId,
      threadId,
      providerInstanceId,
      providerSessionId: sessionId,
      providerCallbackId: "input-1",
      providerOptionValues: ["PDF"],
      detail: { kind: "user-input", prompt: "Choose a format", options: ["Option 1: PDF"] },
    });
  });

  it("forwards answers through the subscribed provider connection", async () => {
    const answerApproval = vi.fn(() => Effect.void);
    const answerUserInput = vi.fn(() => Effect.void);
    const runtime = new WorkRequestRuntime({
      requests: { record: vi.fn() } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(Stream.empty),
      answerApproval,
      answerUserInput,
      interrupt: () => Effect.void,
    };
    const subscription = runtime.subscribe({
      connection,
      projectId,
      threadId,
      providerInstanceId,
      sessionId,
    });
    await Effect.runPromise(subscription);

    await runtime.answerApproval({ sessionId, requestId: "approval-1", approved: true });
    await runtime.answerUserInput({ sessionId, requestId: "input-1", answer: "PDF" });
    expect(answerApproval).toHaveBeenCalledWith({
      sessionId,
      requestId: "approval-1",
      approved: true,
    });
    expect(answerUserInput).toHaveBeenCalledWith({
      sessionId,
      requestId: "input-1",
      answer: "PDF",
    });
  });

  it("taps an acquired Work connection without consuming its turn event stream", async () => {
    const record = vi.fn(() => ({ status: "ok" as const, request: {} as never }));
    const runtime = new WorkRequestRuntime({
      requests: { record, interruptSession: vi.fn(() => []) } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const event: ProviderRuntimeEvent = {
      instanceId: providerInstanceId,
      sequence: 1,
      correlationId: decodeCorrelationId(String(projectId)),
      occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
      kind: "approval-request",
      sessionId,
      requestId: "approval-1",
      action: "run-terminal-command",
      description: "Run a command",
    };
    const connection = {
      subscribe: Effect.succeed(Stream.succeed(event)),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt: () => Effect.void,
    };
    const driver = {
      acquire: () => Effect.succeed(connection),
    } as unknown as ProviderDriver;
    const attached = attachWorkRequestRuntime(driver, () => runtime);
    const acquired = await Effect.runPromise(
      Effect.scoped(
        attached.acquire({
          instanceId: providerInstanceId,
          projectRoot: "/work",
          mode: "work",
          workRequest: { projectId, threadId, sessionId },
        }),
      ),
    );
    const received: ProviderRuntimeEvent[] = [];
    await Effect.runPromise(
      Stream.unwrapScoped(acquired.subscribe).pipe(
        Stream.runForEach((next) => Effect.sync(() => received.push(next))),
      ),
    );
    expect(received).toEqual([event]);
    expect(record).toHaveBeenCalledOnce();
  });

  it("redacts and bounds provider request detail before strict Work decoding", async () => {
    const record = vi.fn((_input: unknown) => ({ status: "ok" as const, request: {} as never }));
    const runtime = new WorkRequestRuntime({
      requests: { record } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(
        Stream.succeed<ProviderRuntimeEvent>({
          instanceId: providerInstanceId,
          sequence: 1,
          correlationId: decodeCorrelationId(String(projectId)),
          occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
          kind: "user-input-request",
          sessionId,
          requestId: "input-1",
          prompt: `Choose ${"x".repeat(2_100)} from https://example.test/path`,
          options: [
            { label: "file:///Users/alice/secret" },
            ...Array.from({ length: 10 }, (_, i) => ({ label: `opt/${i}` })),
          ],
        }),
      ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt: () => Effect.void,
    };
    await Effect.runPromise(
      runtime.subscribe({ connection, projectId, threadId, providerInstanceId, sessionId }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          kind: "user-input",
          prompt: expect.not.stringMatching(/[\\/]|https?:|file:/i),
          options: [
            "Option 1: [redacted reference]",
            "Option 2: [redacted path]",
            "Option 3: [redacted path]",
            "Option 4: [redacted path]",
            "Option 5: [redacted path]",
            "Option 6: [redacted path]",
            "Option 7: [redacted path]",
            "Option 8: [redacted path]",
          ],
        },
      }),
    );
    const recorded = record.mock.calls[0]?.[0] as WorkRequestRecordInput | undefined;
    expect(recorded?.detail.kind).toBe("user-input");
    if (recorded?.detail.kind === "user-input") {
      expect(recorded.detail.prompt.length).toBeLessThanOrEqual(2_000);
    }
  });

  it("redacts each complete Unix and Windows path token before projection", async () => {
    const record = vi.fn((_input: unknown) => ({ status: "ok" as const, request: {} as never }));
    const runtime = new WorkRequestRuntime({
      requests: { record } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(
        Stream.succeed<ProviderRuntimeEvent>({
          instanceId: providerInstanceId,
          sequence: 1,
          correlationId: decodeCorrelationId(String(projectId)),
          occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
          kind: "approval-request",
          sessionId,
          requestId: "approval-1",
          action: "Read /Users/alice/.ssh/id_rsa then C:\\Users\\alice\\secret.txt",
          description: "Compare ./private/report.md with docs/guide.md",
        }),
      ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt: () => Effect.void,
    };

    await Effect.runPromise(
      runtime.subscribe({ connection, projectId, threadId, providerInstanceId, sessionId }),
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          kind: "approval",
          action: "Read [redacted path] then [redacted path]",
          description: "Compare [redacted path] with [redacted path]",
        },
      }),
    );
  });

  it("interrupts the provider and fails the owning turn when durable recording fails", async () => {
    const interrupt = vi.fn(() => Effect.void);
    const runtime = new WorkRequestRuntime({
      requests: {
        record: () => ({
          status: "failure" as const,
          failure: { code: "unavailable" as const, message: "journal unavailable" },
        }),
      } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(
        Stream.succeed<ProviderRuntimeEvent>({
          instanceId: providerInstanceId,
          sequence: 1,
          correlationId: decodeCorrelationId(String(projectId)),
          occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
          kind: "approval-request",
          sessionId,
          requestId: "approval-1",
          action: "Run report",
          description: "Generate the report",
        }),
      ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt,
    };
    await expect(
      Effect.runPromise(
        runtime.subscribe({ connection, projectId, threadId, providerInstanceId, sessionId }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Work request could not be recorded"),
    });
    expect(interrupt).toHaveBeenCalledWith(sessionId);
  });

  it("rejects and interrupts an unbounded provider callback identifier", async () => {
    const record = vi.fn();
    const interrupt = vi.fn(() => Effect.void);
    const runtime = new WorkRequestRuntime({
      requests: { record } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(
        Stream.succeed<ProviderRuntimeEvent>({
          instanceId: providerInstanceId,
          sequence: 1,
          correlationId: decodeCorrelationId(String(projectId)),
          occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
          kind: "approval-request",
          sessionId,
          requestId: "x".repeat(16_385),
          action: "Run report",
          description: "Generate the report",
        }),
      ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt,
    };

    await expect(
      Effect.runPromise(
        runtime.subscribe({ connection, projectId, threadId, providerInstanceId, sessionId }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Work request could not be recorded"),
    });
    expect(record).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledWith(sessionId);
  });

  it("settles pending requests when the provider session reaches a terminal event", async () => {
    const interruptSession = vi.fn(() => []);
    const runtime = new WorkRequestRuntime({
      requests: { record: vi.fn(), interruptSession } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(
        Stream.succeed<ProviderRuntimeEvent>({
          instanceId: providerInstanceId,
          sequence: 1,
          correlationId: decodeCorrelationId(String(projectId)),
          occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
          kind: "completed",
          sessionId,
        }),
      ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt: () => Effect.void,
    };
    await Effect.runPromise(
      runtime.subscribe({ connection, projectId, threadId, providerInstanceId, sessionId }),
    );
    expect(interruptSession).toHaveBeenCalledWith(sessionId);
  });

  it("interrupts pending requests when the provider connection detaches", () => {
    const interruptSession = vi.fn(() => []);
    const runtime = new WorkRequestRuntime({
      requests: { record: vi.fn(), interruptSession } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(Stream.empty),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      interrupt: () => Effect.void,
    };

    const detach = runtime.register({
      connection,
      projectId,
      threadId,
      providerInstanceId,
      sessionId,
    });
    detach();

    expect(interruptSession).toHaveBeenCalledWith(sessionId);
  });

  it("keeps a provider attachment alive across a transient waiting event", async () => {
    const interruptSession = vi.fn(() => []);
    const answerApproval = vi.fn(() => Effect.void);
    const runtime = new WorkRequestRuntime({
      requests: {
        record: vi.fn(() => ({ status: "ok" as const, request: {} as never })),
        interruptSession,
      } as never,
      uuid: () => "00000000-0000-4000-8000-000000000905",
    });
    const connection = {
      subscribe: Effect.succeed(
        Stream.fromIterable<ProviderRuntimeEvent>([
          {
            instanceId: providerInstanceId,
            sequence: 1,
            correlationId: decodeCorrelationId(String(projectId)),
            occurredAt: decodeTimestamp("2026-08-10T08:00:00.000Z"),
            kind: "waiting",
            sessionId,
            message: "retry",
          },
        ]),
      ),
      answerApproval,
      answerUserInput: () => Effect.void,
      interrupt: () => Effect.void,
    };

    await Effect.runPromise(
      runtime.subscribe({ connection, projectId, threadId, providerInstanceId, sessionId }),
    );
    await runtime.answerApproval({ sessionId, requestId: "approval-1", approved: true });

    expect(interruptSession).not.toHaveBeenCalled();
    expect(answerApproval).toHaveBeenCalledWith({
      sessionId,
      requestId: "approval-1",
      approved: true,
    });
  });

  describe("with Octant Shield answering a Work thread's approvals", () => {
    // Each runtime names its pending call its own way; Shield judges the
    // connection's call, never the event's text.
    const runtimes = [
      { runtime: "Claude Code", tool: "Bash", input: '{"command":"git status"}' },
      { runtime: "Codex", tool: "shell", input: '{"command":["git","status"]}' },
      { runtime: "OpenCode", tool: "bash", input: '{"command":"git status"}' },
      { runtime: "an ACP agent", tool: "execute", input: '{"command":"git status"}' },
      { runtime: "Pi", tool: "bash", input: '{"command":"git status"}' },
    ] as const;
    const decision = (verdict: ShieldDecision["verdict"]): ShieldDecision => ({
      reviewer: "octant-shield",
      verdict,
      stage: "fast-allow",
      rule: "read-only-git",
      reason: "A read-only Git command.",
      latencyMs: 1,
      decidedAt: decodeTimestamp("2026-10-31T10:00:00.000Z"),
    });
    const approval: ProviderRuntimeEvent = {
      instanceId: providerInstanceId,
      sequence: 1,
      correlationId: decodeCorrelationId(String(projectId)),
      occurredAt: decodeTimestamp("2026-10-31T10:00:00.000Z"),
      kind: "approval-request",
      sessionId,
      requestId: "approval-1",
      action: "run-terminal-command",
      description: "Run git status in [CHECKOUT]",
    };

    async function runTurn(input: {
      readonly tool: string;
      readonly input: string;
      readonly review: ShieldReviewPort["review"] | undefined;
      readonly answerFails?: boolean;
      readonly extraFolders?: ReadonlyArray<string>;
    }) {
      const record = vi.fn((_input: unknown) => ({ status: "ok" as const, request: {} as never }));
      const answerApproval = vi.fn((_answer: unknown) =>
        input.answerFails === true
          ? Effect.fail({ category: "provider-failed" as const, message: "gone" })
          : Effect.void,
      );
      const reviewed = vi.fn();
      const runtime = new WorkRequestRuntime({
        requests: { record, interruptSession: vi.fn(() => []) } as never,
        uuid: () => "00000000-0000-4000-8000-000000000905",
        shield: () => (input.review === undefined ? undefined : { review: input.review }),
      });
      const connection = {
        subscribe: Effect.succeed(Stream.succeed(approval)),
        answerApproval,
        answerUserInput: () => Effect.void,
        interrupt: () => Effect.void,
        approvalCall: () => ({ tool: input.tool, input: input.input }),
      };
      const attached = attachWorkRequestRuntime(
        { acquire: () => Effect.succeed(connection) } as unknown as ProviderDriver,
        () => runtime,
      );
      const received: ProviderRuntimeEvent[] = [];
      // The session's scope stays open for the whole turn, as in production.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const acquired = yield* attached.acquire({
              instanceId: providerInstanceId,
              projectRoot: "/work",
              ...(input.extraFolders === undefined ? {} : { extraFolders: input.extraFolders }),
              mode: "work",
              workRequest: { projectId, threadId, sessionId, onApprovalReviewed: reviewed },
            });
            yield* Stream.unwrapScoped(acquired.subscribe).pipe(
              Stream.runForEach((next) => Effect.sync(() => received.push(next))),
            );
          }),
        ),
      );
      return { record, answerApproval, reviewed, received };
    }

    for (const { runtime, tool, input } of runtimes) {
      it(`answers ${runtime}'s allowed call once without asking the person`, async () => {
        const review = vi.fn(async () => decision("allow"));
        const turn = await runTurn({ tool, input, review });
        expect(review).toHaveBeenCalledWith(
          expect.objectContaining({ threadId: String(threadId), boundRoot: "/work" }),
        );
        expect(turn.answerApproval).toHaveBeenCalledWith({
          sessionId,
          requestId: "approval-1",
          approved: true,
          scope: "once",
        });
        expect(turn.record).not.toHaveBeenCalled();
        expect(turn.received).toEqual([]);
        expect(turn.reviewed).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: "approval-1", toolName: tool }),
        );
      });

      it(`refuses ${runtime}'s denied call once without asking the person`, async () => {
        const turn = await runTurn({ tool, input, review: async () => decision("deny") });
        expect(turn.answerApproval).toHaveBeenCalledWith({
          sessionId,
          requestId: "approval-1",
          approved: false,
          scope: "once",
        });
        expect(turn.record).not.toHaveBeenCalled();
      });

      it(`hands ${runtime}'s call to the person when Shield asks, and still shows the decision`, async () => {
        const turn = await runTurn({ tool, input, review: async () => decision("ask") });
        expect(turn.answerApproval).not.toHaveBeenCalled();
        expect(turn.record).toHaveBeenCalledOnce();
        expect(turn.received).toEqual([approval]);
        expect(turn.reviewed).toHaveBeenCalledWith(
          expect.objectContaining({ decision: expect.objectContaining({ verdict: "ask" }) }),
        );
      });
    }

    it("judges a call in the Project's extra folders as it judges one in the root", async () => {
      const review = vi.fn(async () => decision("allow"));
      await runTurn({ tool: "Bash", input: "{}", review, extraFolders: ["/shared"] });
      expect(review).toHaveBeenCalledWith(
        expect.objectContaining({ boundRoot: "/work", extraRoots: ["/shared"] }),
      );
    });

    it("asks the person when Shield does not review the thread", async () => {
      const turn = await runTurn({
        tool: "Bash",
        input: "{}",
        review: async () => undefined,
      });
      expect(turn.answerApproval).not.toHaveBeenCalled();
      expect(turn.record).toHaveBeenCalledOnce();
      expect(turn.reviewed).not.toHaveBeenCalled();
    });

    it("asks the person when Shield fails or no Shield is wired", async () => {
      const failed = await runTurn({
        tool: "Bash",
        input: "{}",
        review: async () => {
          throw new Error("model unreachable");
        },
      });
      expect(failed.record).toHaveBeenCalledOnce();
      const unwired = await runTurn({ tool: "Bash", input: "{}", review: undefined });
      expect(unwired.record).toHaveBeenCalledOnce();
    });

    it("asks the person when the runtime cannot take Shield's answer", async () => {
      const turn = await runTurn({
        tool: "Bash",
        input: "{}",
        review: async () => decision("allow"),
        answerFails: true,
      });
      expect(turn.record).toHaveBeenCalledOnce();
      expect(turn.received).toEqual([approval]);
    });
  });
});

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
            options: ["PDF"],
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
      requests: { record } as never,
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
            "file:///Users/alice/secret",
            ...Array.from({ length: 10 }, (_, i) => `opt/${i}`),
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
});

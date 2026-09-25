import {
  decodeWorkTurnAuthority,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeStartWorkThreadTurnCommand,
  type ProviderRuntimeEvent,
  type ThreadTaskProgressList,
  CorrelationId,
  UtcTimestamp,
} from "@octant/contracts";
import { Effect, Queue, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { WorkTurnRuntime } from "./workTurnRuntime";

const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const ids = {
  request: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  turn: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  thread: decodeWorkThreadId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
  project: decodeProjectId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
  binding: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  provider: decodeProviderInstanceId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
  session: "11111111-1111-4111-8111-111111111111",
} as const;

describe("WorkTurnRuntime", () => {
  it("acquires Work project-backed authority with request projection context and streams a reply", async () => {
    const acquireInputs: unknown[] = [];
    const start = vi.fn((_input: Parameters<ProviderConnection["start"]>[0]) => Effect.void);
    const deltas: string[] = [];
    const usage = vi.fn();
    const events: ProviderRuntimeEvent[] = [
      {
        instanceId: ids.provider,
        sequence: 1,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
        kind: "text-delta",
        sessionId: ids.session as never,
        text: "Hello from Work",
      },
      {
        instanceId: ids.provider,
        sequence: 2,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:01.000Z"),
        kind: "usage",
        sessionId: ids.session as never,
        inputTokens: 120,
        outputTokens: 8,
        contextTokens: 128,
        contextWindow: 32000,
      },
      {
        instanceId: ids.provider,
        sequence: 3,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:02.000Z"),
        kind: "completed",
        sessionId: ids.session as never,
      },
    ];
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: (input) => {
        acquireInputs.push(input);
        return Effect.succeed({
          subscribe: Effect.succeed(Stream.fromIterable(events)),
          start,
          send: () => Effect.void,
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never);
      },
    };
    const command = decodeStartWorkThreadTurnCommand({
      kind: "start-work-thread-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      prompt: "Summarize the brief",
      authority: decodeWorkTurnAuthority({
        hostId: "local",
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: ids.provider,
        modelId: "gpt-5",
      }),
    });

    const outcome = await new WorkTurnRuntime().run({
      command,
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver,
      signal: new AbortController().signal,
      onDelta: (text) => deltas.push(text),
      onUsage: usage,
      modelOptionValues: { effort: "high" },
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ modelOptionValues: { effort: "high" } }),
    );
    expect(acquireInputs[0]).toMatchObject({
      mode: "work",
      projectRoot: "/tmp/work-project",
      workRequest: {
        projectId: ids.project,
        threadId: ids.thread,
        sessionId: ids.session,
      },
    });
    expect(JSON.stringify(acquireInputs[0])).not.toMatch(/shell|worktree|pullRequest|checkoutId/);
    expect(deltas).toEqual(["Hello from Work"]);
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 120,
        outputTokens: 8,
        contextTokens: 128,
        contextWindow: 32000,
      }),
    );
    expect(outcome).toEqual({ kind: "completed", response: "Hello from Work" });
  });

  it("hands the provider's restated task list to the service whenever it moves", async () => {
    const updates: ThreadTaskProgressList[] = [];
    const events: ProviderRuntimeEvent[] = [
      {
        instanceId: ids.provider,
        sequence: 1,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
        kind: "task-progress",
        sessionId: ids.session as never,
        taskId: "task-1",
        status: "in-progress",
        summary: "Read the brief",
      },
      {
        instanceId: ids.provider,
        sequence: 2,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:01.000Z"),
        kind: "task-progress",
        sessionId: ids.session as never,
        taskId: "task-1",
        status: "completed",
        summary: "Read the brief",
      },
      {
        instanceId: ids.provider,
        sequence: 3,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:02.000Z"),
        kind: "text-delta",
        sessionId: ids.session as never,
        text: "Read it.",
      },
      {
        instanceId: ids.provider,
        sequence: 4,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:03.000Z"),
        kind: "completed",
        sessionId: ids.session as never,
      },
    ];
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: () =>
        Effect.succeed({
          subscribe: Effect.succeed(Stream.fromIterable(events)),
          start: () => Effect.void,
          send: () => Effect.void,
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never),
    };
    const command = decodeStartWorkThreadTurnCommand({
      kind: "start-work-thread-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      prompt: "Summarize the brief",
      authority: decodeWorkTurnAuthority({
        hostId: "local",
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: ids.provider,
        modelId: "gpt-5",
      }),
    });

    const outcome = await new WorkTurnRuntime().run({
      command,
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver,
      signal: new AbortController().signal,
      onTasks: (tasks) => updates.push(tasks),
    });

    expect(outcome).toEqual({ kind: "completed", response: "Read it." });
    expect(updates).toEqual([
      [{ taskId: "task-1", state: "running", summary: "Read the brief" }],
      [{ taskId: "task-1", state: "completed", summary: "Read the brief" }],
    ]);
  });

  it.each([false, true])(
    "persists the resumed identity before sending and refuses input when persistence fails (%s)",
    async (persistenceFails) => {
      const order: string[] = [];
      const cursor = { driverKind: "pi" as const, value: "existing-native-session" };
      const start = vi.fn(() => Effect.die("must resume"));
      const resume = vi.fn((input: Parameters<ProviderConnection["resume"]>[0]) =>
        Effect.sync(() => {
          order.push("resume");
          return { sessionId: input.sessionId, resumeCursor: cursor };
        }),
      );
      const send = vi.fn(() =>
        Effect.sync(() => {
          order.push("send");
        }),
      );
      const connection: ProviderConnection = {
        start,
        resume,
        send,
        subscribe: Effect.succeed(
          Stream.make({
            instanceId: ids.provider,
            sequence: 1,
            correlationId: decodeCorrelationId(String(ids.project)),
            occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
            kind: "completed" as const,
            sessionId: ids.session as never,
          }),
        ),
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      };
      const outcome = await new WorkTurnRuntime().run({
        command: decodeStartWorkThreadTurnCommand({
          kind: "start-work-thread-turn",
          requestId: ids.request,
          threadId: ids.thread,
          turnId: ids.turn,
          prompt: "Continue",
          authority: decodeWorkTurnAuthority({
            hostId: "local",
            projectId: ids.project,
            bindingRevisionId: ids.binding,
            workingDirectory: ".",
            confinementPosture: "project-root-confined",
            providerInstanceId: ids.provider,
            modelId: "gpt-5",
          }),
        }),
        providerSessionId: ids.session as never,
        resumeCursor: cursor,
        projectRoot: "/tmp/work-project",
        signal: new AbortController().signal,
        driver: {
          kind: "pi",
          probe: () => Effect.die("unused"),
          acquire: () => Effect.succeed(connection),
        },
        onSessionReady: (handle) => {
          expect(handle.resumeCursor).toEqual(cursor);
          order.push("persist");
          if (persistenceFails) throw new Error("disk unavailable");
        },
      });
      expect(start).not.toHaveBeenCalled();
      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({ resumeCursor: cursor, tools: [] }),
      );
      expect(order).toEqual(
        persistenceFails ? ["resume", "persist"] : ["resume", "persist", "send"],
      );
      expect(outcome.kind).toBe(persistenceFails ? "failed" : "completed");
    },
  );

  it("keeps the idle window open while an app-managed action is executing", async () => {
    const answerTool = vi.fn(() => Effect.void);
    const execute = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      return { result: { status: "ok" }, isError: false } as const;
    });
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    const connection: ProviderConnection = {
      subscribe: Effect.succeed(Stream.fromQueue(queue)),
      start: (input) => Effect.succeed({ sessionId: input.sessionId }),
      resume: () => Effect.die("unused"),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            instanceId: ids.provider,
            sequence: 1,
            correlationId: decodeCorrelationId(String(ids.project)),
            occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
            kind: "tool-request",
            sessionId: ids.session as never,
            requestId: "work-tool-1",
            toolName: "work_tool",
            inputJson: "{}",
          });
          yield* Queue.offer(queue, {
            instanceId: ids.provider,
            sequence: 2,
            correlationId: decodeCorrelationId(String(ids.project)),
            occurredAt: decodeTimestamp("2026-08-11T12:00:01.000Z"),
            kind: "completed",
            sessionId: ids.session as never,
          });
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool,
    };
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: () => Effect.succeed(connection),
    };
    const outcome = await new WorkTurnRuntime({ timeoutMs: 1_000 }).run({
      command: decodeStartWorkThreadTurnCommand({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Use the Work tool",
        authority: decodeWorkTurnAuthority({
          hostId: "local",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: ids.provider,
          modelId: "gpt-5",
        }),
      }),
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver,
      signal: new AbortController().signal,
      appManagedTools: {
        definitions: [{ name: "work_tool", inputSchema: { type: "object" } }],
        execute,
      },
    });

    expect(outcome).toEqual({ kind: "completed", response: "" });
    expect(execute).toHaveBeenCalledOnce();
    expect(answerTool).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "work-tool-1", isError: false }),
    );
  });

  it("keeps the idle window open while a provider request awaits an answer", async () => {
    const queue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
    let releaseRequest: (() => void) | undefined;
    let settlementInput:
      | { readonly providerSessionId: string; readonly providerCallbackId: string }
      | undefined;
    const connection: ProviderConnection = {
      subscribe: Effect.succeed(Stream.fromQueue(queue)),
      start: (input) => Effect.succeed({ sessionId: input.sessionId }),
      resume: () => Effect.die("unused"),
      send: () =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            instanceId: ids.provider,
            sequence: 1,
            correlationId: decodeCorrelationId(String(ids.project)),
            occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
            kind: "approval-request",
            sessionId: ids.session as never,
            requestId: "call_1",
            action: "Write a note",
            description: "Save the provider's draft.",
          });
          setTimeout(() => {
            void Effect.runPromise(
              Queue.offer(queue, {
                instanceId: ids.provider,
                sequence: 2,
                correlationId: decodeCorrelationId(String(ids.project)),
                occurredAt: decodeTimestamp("2026-08-11T12:00:40.000Z"),
                kind: "text-delta",
                sessionId: ids.session as never,
                text: "Still waiting.",
              }),
            );
          }, 20);
          setTimeout(() => {
            releaseRequest?.();
          }, 40);
          setTimeout(() => {
            void Effect.runPromise(
              Queue.offer(queue, {
                instanceId: ids.provider,
                sequence: 3,
                correlationId: decodeCorrelationId(String(ids.project)),
                occurredAt: decodeTimestamp("2026-08-11T12:00:45.000Z"),
                kind: "completed",
                sessionId: ids.session as never,
              }),
            );
          }, 45);
        }),
      interrupt: () => Effect.void,
      stop: () => Effect.void,
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
    };
    const outcome = await new WorkTurnRuntime({ timeoutMs: 10 }).run({
      command: decodeStartWorkThreadTurnCommand({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Wait for approval",
        authority: decodeWorkTurnAuthority({
          hostId: "local",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: ids.provider,
          modelId: "gpt-5",
        }),
      }),
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver: {
        kind: "openai-compatible",
        probe: () => Effect.die("unused"),
        acquire: () => Effect.succeed(connection),
      },
      signal: new AbortController().signal,
      onRequestSettled: (input, release) => {
        settlementInput = {
          providerSessionId: String(input.providerSessionId),
          providerCallbackId: input.providerCallbackId,
        };
        releaseRequest = release;
        return () => undefined;
      },
    });

    expect(outcome).toEqual({ kind: "completed", response: "Still waiting." });
    expect(settlementInput).toEqual({
      providerSessionId: String(ids.session),
      providerCallbackId: "call_1",
    });
  });

  it("still times out when the provider stays silent", async () => {
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: () =>
        Effect.succeed({
          subscribe: Effect.succeed(Stream.never),
          start: () => Effect.void,
          send: () => Effect.void,
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never),
    };
    const outcome = await new WorkTurnRuntime({ timeoutMs: 10 }).run({
      command: decodeStartWorkThreadTurnCommand({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Wait",
        authority: decodeWorkTurnAuthority({
          hostId: "local",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: ids.provider,
          modelId: "gpt-5",
        }),
      }),
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver,
      signal: new AbortController().signal,
    });
    expect(outcome.kind).toBe("waiting");
    if (outcome.kind === "waiting") expect(outcome.failure?.message).toMatch(/timed out/i);
  });

  it("hands the provider the images the host already accepted", async () => {
    const sent: unknown[] = [];
    const events: ProviderRuntimeEvent[] = [
      {
        instanceId: ids.provider,
        sequence: 1,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
        kind: "completed",
        sessionId: ids.session as never,
      },
    ];
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: () =>
        Effect.succeed({
          subscribe: Effect.succeed(Stream.fromIterable(events)),
          start: () => Effect.void,
          send: (input: unknown) => {
            sent.push(input);
            return Effect.void;
          },
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never),
    };
    const attachment = {
      attachmentId: "attachment-1",
      displayName: "mockup.png",
      mediaType: "image/png",
      bytes: new Uint8Array([137, 80, 78]),
    };

    await new WorkTurnRuntime().run({
      command: decodeStartWorkThreadTurnCommand({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Match this mockup",
        authority: decodeWorkTurnAuthority({
          hostId: "local",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: ids.provider,
          modelId: "gpt-5",
        }),
      }),
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver,
      attachments: [attachment],
      signal: new AbortController().signal,
    });

    expect(sent[0]).toMatchObject({
      prompt: "Match this mockup",
      attachments: [attachment],
    });
  });

  it("starts the provider auto-accepting edits only for a thread whose access allows it", async () => {
    const started: Array<{ readonly executionPolicy?: string }> = [];
    const events: ProviderRuntimeEvent[] = [
      {
        instanceId: ids.provider,
        sequence: 1,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
        kind: "completed",
        sessionId: ids.session as never,
      },
    ];
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: () =>
        Effect.succeed({
          subscribe: Effect.succeed(Stream.fromIterable(events)),
          start: (input: { readonly executionPolicy?: string }) => {
            started.push(input);
            return Effect.void;
          },
          send: () => Effect.void,
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never),
    };
    const turn = (access?: "ask-first" | "auto-accept-edits") =>
      new WorkTurnRuntime().run({
        command: decodeStartWorkThreadTurnCommand({
          kind: "start-work-thread-turn",
          requestId: ids.request,
          threadId: ids.thread,
          turnId: ids.turn,
          prompt: "Tidy the brief",
          authority: decodeWorkTurnAuthority({
            hostId: "local",
            projectId: ids.project,
            bindingRevisionId: ids.binding,
            workingDirectory: ".",
            confinementPosture: "project-root-confined",
            providerInstanceId: ids.provider,
            modelId: "gpt-5",
          }),
        }),
        providerSessionId: ids.session as never,
        projectRoot: "/tmp/work-project",
        driver,
        ...(access === undefined ? {} : { access }),
        signal: new AbortController().signal,
      });

    await turn();
    await turn("ask-first");
    await turn("auto-accept-edits");
    expect(started.map((input) => input.executionPolicy)).toEqual([
      "approval-gated",
      "approval-gated",
      "auto-accept-edits",
    ]);
  });

  it("hands the provider the prior Work transcript as follow-up context", async () => {
    const sent: unknown[] = [];
    const events: ProviderRuntimeEvent[] = [
      {
        instanceId: ids.provider,
        sequence: 1,
        correlationId: decodeCorrelationId(String(ids.project)),
        occurredAt: decodeTimestamp("2026-08-11T12:00:00.000Z"),
        kind: "completed",
        sessionId: ids.session as never,
      },
    ];
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: () =>
        Effect.succeed({
          subscribe: Effect.succeed(Stream.fromIterable(events)),
          start: () => Effect.void,
          send: (input: unknown) => {
            sent.push(input);
            return Effect.void;
          },
          resume: () => Effect.void,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
          answerApproval: () => Effect.void,
          answerUserInput: () => Effect.void,
          answerTool: () => Effect.void,
        } as never),
    };

    await new WorkTurnRuntime().run({
      command: decodeStartWorkThreadTurnCommand({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Make that summary shorter",
        authority: decodeWorkTurnAuthority({
          hostId: "local",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: ids.provider,
          modelId: "gpt-5",
        }),
      }),
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver,
      context: [
        { kind: "user-message", text: "Summarize the brief" },
        { kind: "assistant-message", text: "Here is the confined summary." },
      ],
      signal: new AbortController().signal,
    });

    expect(sent[0]).toMatchObject({
      prompt: "Make that summary shorter",
      context: [
        { kind: "user-message", text: "Summarize the brief" },
        { kind: "assistant-message", text: "Here is the confined summary." },
      ],
    });
  });

  it("cancels before provider launch when the signal is already aborted", async () => {
    const acquire = vi.fn();
    const driver: ProviderDriver = {
      kind: "openai-compatible",
      probe: () => Effect.die("unused"),
      acquire: ((input: unknown) => {
        acquire(input);
        return Effect.die("should not acquire");
      }) as never,
    };
    const controller = new AbortController();
    controller.abort();
    const outcome = await new WorkTurnRuntime().run({
      command: decodeStartWorkThreadTurnCommand({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Summarize the brief",
        authority: decodeWorkTurnAuthority({
          hostId: "local",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: ids.provider,
          modelId: "gpt-5",
        }),
      }),
      providerSessionId: ids.session as never,
      projectRoot: "/tmp/work-project",
      driver,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(acquire).not.toHaveBeenCalled();
  });
});

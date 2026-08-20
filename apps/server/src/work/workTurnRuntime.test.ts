import {
  decodeWorkTurnAuthority,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeStartWorkThreadTurnCommand,
  type ProviderRuntimeEvent,
  CorrelationId,
  UtcTimestamp,
} from "@octant/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
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
    const deltas: string[] = [];
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
          events: Stream.fromIterable(events),
          start: () => Effect.void,
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
    });

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
    expect(outcome).toEqual({ kind: "completed", response: "Hello from Work" });
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

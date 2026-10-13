import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeNativeHarnessSlotCandidate,
  EventActor,
  type AgentRun,
  type NativeHarnessInteractionSource,
} from "@octant/contracts";
import { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import { registerNativeHarnessEvents } from "../harness/nativeHarnessEvents";
import { NativeHarnessQuestionStore } from "../harness/nativeHarnessQuestions";
import { NativeHarnessSessionStore } from "../harness/nativeHarnessSessionStore";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { listChildPendingRequests } from "./childPendingRequests";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true });
});

const now = "2026-10-06T08:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const lead = decodeNativeHarnessSlotCandidate({
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "lead-model",
});
const parentThread = "00000000-0000-4000-8000-000000000024";
const windowId = "00000000-0000-4000-8000-000000000801";
const projectId = "00000000-0000-4000-8000-000000000901";
const childRunId = "00000000-0000-4000-8000-000000000090";
const source = {
  runId: childRunId as never,
  providerInstanceId: lead.providerInstanceId,
  modelId: "worker-model" as never,
  providerName: "Local model",
} satisfies NativeHarnessInteractionSource;

const childRun = {
  id: childRunId,
  parentThreadId: parentThread,
  role: "research",
  task: "t".repeat(300),
  routingReceipt: { mode: "work" },
  workspaceReceipt: { kind: "work-project", mode: "work", projectId },
} as unknown as AgentRun;

function fixture(options: { readonly timeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-child-pending-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  let counter = 0;
  const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`;
  const sessions = new NativeHarnessSessionStore({
    journal: new Journal({
      connection,
      registry: registerNativeHarnessEvents(new EventRegistry()),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    }),
    uuid,
    actor,
    clock: () => now,
  });
  const approvals = new NativeHarnessApprovalStore({
    sessions,
    uuid,
    clock: () => now,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const questions = new NativeHarnessQuestionStore({
    sessions,
    uuid,
    clock: () => now,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const askApproval = (input: { readonly child: boolean }) =>
    approvals.ask({
      threadId: parentThread,
      mode: "work",
      lead,
      toolName: "provider-action",
      ...(input.child ? { source } : {}),
      summary: "shell: bun run test",
      approvalClass: "child-provider-action",
    });
  const askQuestion = () =>
    questions.ask({
      threadId: parentThread,
      mode: "work",
      lead,
      source,
      prompt: "Which fixture should I use?",
      options: ["a", "b"],
    });
  const list = (
    overrides: {
      readonly authorize?: boolean;
      readonly run?: AgentRun | undefined;
      readonly title?: string | undefined;
    } = {},
  ) =>
    listChildPendingRequests(
      {
        approvals,
        questions,
        readSession: (threadId) => sessions.read(threadId),
        getRun: () => ("run" in overrides ? overrides.run : childRun),
        parentThreadTitle: () => ("title" in overrides ? overrides.title : "Quarterly report"),
        authorizeThread: ({ windowId: asked }) => {
          expect(asked).toBe(windowId);
          return overrides.authorize ?? true;
        },
      },
      windowId,
    );
  return { approvals, questions, sessions, askApproval, askQuestion, list };
}

describe("subagent pending requests", () => {
  it("lists a waiting subagent approval and question with the parent title and the subagent's facts", async () => {
    const { askApproval, askQuestion, list } = fixture();
    void askApproval({ child: true });
    void askQuestion();
    const requests = await list();
    expect(requests).toHaveLength(2);
    expect(requests).toEqual([
      expect.objectContaining({
        mode: "work",
        kind: "child-approval",
        projectId,
        threadId: parentThread,
        threadTitle: "Quarterly report",
        text: "shell: bun run test",
        requestedAt: now,
        child: {
          runId: childRunId,
          role: "research",
          task: "t".repeat(200),
          providerName: "Local model",
          modelId: "worker-model",
        },
      }),
      expect.objectContaining({
        kind: "child-question",
        text: "Which fixture should I use?",
      }),
    ]);
    for (const request of requests) {
      expect(request).not.toHaveProperty("answer");
      expect(request).not.toHaveProperty("options");
    }
  });

  it("does not list the lead's own approval", async () => {
    const { askApproval, list } = fixture();
    void askApproval({ child: false });
    expect(await list()).toEqual([]);
  });

  it("does not list a subagent request that expired", async () => {
    const { sessions, askApproval, askQuestion, list } = fixture({ timeoutMs: 5 });
    const approval = askApproval({ child: true });
    const question = askQuestion();
    expect(await list()).toHaveLength(2);
    await approval;
    await question;
    expect(sessions.read(parentThread)?.approvals?.[0]?.status).toBe("expired");
    expect(await list()).toEqual([]);
  });

  it("does not list a subagent request once the person decided it", async () => {
    const { approvals, sessions, askApproval, list } = fixture();
    void askApproval({ child: true });
    const pending = sessions.read(parentThread)?.approvals?.[0];
    expect(approvals.decide(parentThread, String(pending?.id), "deny")).toBe("decided");
    expect(await list()).toEqual([]);
  });

  it("does not list a request that has no live waiter, as after a restart", async () => {
    const { sessions, askApproval, questions } = fixture();
    void askApproval({ child: true });
    const afterRestart = new NativeHarnessApprovalStore({
      sessions,
      uuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
      clock: () => now,
    });
    expect(
      await listChildPendingRequests(
        {
          approvals: afterRestart,
          questions,
          readSession: (threadId) => sessions.read(threadId),
          getRun: () => childRun,
          parentThreadTitle: () => "Quarterly report",
          authorizeThread: () => true,
        },
        windowId,
      ),
    ).toEqual([]);
  });

  it("does not list a request for a window that may not open the parent thread", async () => {
    const { askApproval, askQuestion, list } = fixture();
    void askApproval({ child: true });
    void askQuestion();
    expect(await list({ authorize: false })).toEqual([]);
  });

  it("does not list a Chat subagent, whose parent has no Agents tab to answer in", async () => {
    const { askApproval, list } = fixture();
    void askApproval({ child: true });
    const chatRun = { ...childRun, routingReceipt: { mode: "chat" } } as unknown as AgentRun;
    expect(await list({ run: chatRun })).toEqual([]);
  });

  it("leaves out a request whose run or parent title cannot be read", async () => {
    const { askApproval, list } = fixture();
    void askApproval({ child: true });
    expect(await list({ run: undefined })).toEqual([]);
    expect(await list({ title: undefined })).toEqual([]);
    expect(
      await list({ run: { ...childRun, parentThreadId: "other" } as unknown as AgentRun }),
    ).toEqual([]);
  });
});

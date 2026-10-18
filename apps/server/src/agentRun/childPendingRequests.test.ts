import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeAgentRun,
  decodeAgentRunId,
  decodeNativeHarnessSlotCandidate,
  decodeProjectId,
  decodeProviderModelId,
  decodeWindowId,
  EventActor,
  type AgentRun,
  type NativeHarnessInteractionSource,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
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
import {
  listChildPendingRequests,
  windowMayListChildParent,
  windowMayListChildThread,
  type ChildParentReads,
} from "./childPendingRequests";

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
  runId: decodeAgentRunId(childRunId),
  providerInstanceId: lead.providerInstanceId,
  modelId: decodeProviderModelId("worker-model"),
  providerName: "Local model",
} satisfies NativeHarnessInteractionSource;

function agentRun(
  input: {
    readonly mode?: "chat" | "work" | "code";
    readonly parentThreadId?: string;
    readonly task?: string;
  } = {},
): AgentRun {
  const mode = input.mode ?? "work";
  const permissions = {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: false,
  };
  return decodeAgentRun({
    id: childRunId,
    requestId: "00000000-0000-4000-8000-000000000091",
    parentThreadId: input.parentThreadId ?? parentThread,
    depth: 1,
    role: "research",
    task: input.task ?? "t".repeat(300),
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "running",
    authority: {
      ...permissions,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
    routingReceipt: {
      executionResolution: {
        providerInstanceId: lead.providerInstanceId,
        modelId: "worker-model",
        hostId: "local",
        executionPolicy: "plan",
        permissionPersistence: "current-session",
        effectivePermissions: permissions,
        source: "project-default",
        fallbackChain: ["project-default"],
        downgradeReasons: [],
      },
      selectedExecutionKind: "octant-managed",
      attemptedExecutionKind: "octant-managed",
      selectedProviderInstanceId: lead.providerInstanceId,
      selectedModelId: "worker-model",
      fallbackCandidates: [],
      capabilityDegradations: [],
      contextSnapshotId: "00000000-0000-4000-8000-000000000092",
      effectiveAuthorityDigest: "digest-1",
      usageQuality: "provider-reported",
      hostId: "local",
      mode,
    },
    workspaceReceipt:
      mode === "chat"
        ? { kind: "chat-virtual", mode: "chat" }
        : mode === "code"
          ? {
              kind: "code-worktree",
              mode: "code",
              projectId,
              checkoutRoot: "/projects/parser",
              worktreeRoot: "/projects/parser",
              verified: true,
            }
          : {
              kind: "work-root",
              mode: "work",
              projectId,
              bindingRevisionId: "00000000-0000-4000-8000-000000000093",
              canonicalRoot: "/projects/report",
            },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

const childRun = agentRun();

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
  const askApproval = (input: { readonly child: boolean; readonly summary?: string }) =>
    approvals.ask({
      threadId: parentThread,
      mode: "work",
      lead,
      toolName: "provider-action",
      ...(input.child ? { source } : {}),
      summary: input.summary ?? "shell: bun run test",
      approvalClass: "child-provider-action",
    });
  const askQuestion = (prompt = "Which fixture should I use?") =>
    questions.ask({
      threadId: parentThread,
      mode: "work",
      lead,
      source,
      prompt,
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

  it("keeps Chat subagents outside the Work and Code pending-request projection", async () => {
    const { askApproval, list } = fixture();
    void askApproval({ child: true });
    expect(await list({ run: agentRun({ mode: "chat" }) })).toEqual([]);
  });

  it("redacts a path or URL from a Work subagent's request, as a Work request does", async () => {
    const { askApproval, list } = fixture();
    void askApproval({
      child: true,
      summary: "edit /Users/me/report.md from https://example.com/x",
    });
    const [request] = await list();
    expect(request?.text).toBe("edit [redacted path] from [redacted reference]");
  });

  it("redacts a path or URL from a Work subagent's task, and leaves a Code task as written", async () => {
    const { askApproval, list } = fixture();
    void askApproval({ child: true });
    const task = "Summarise /Users/x/clients/acme/report.xlsx and https://example.com/a?b=1";
    const [work] = await list({ run: agentRun({ task }) });
    expect(work?.kind === "child-approval" ? work.child.task : undefined).toBe(
      "Summarise [redacted path] and [redacted reference]",
    );
    const [code] = await list({ run: agentRun({ mode: "code", task }) });
    expect(code?.kind === "child-approval" ? code.child.task : undefined).toBe(task);
  });

  it("cuts a task after redacting it, and never inside a surrogate pair", async () => {
    const { askApproval, list } = fixture();
    void askApproval({ child: true });
    const long = `/Users/x/${"d".repeat(400)}/report.xlsx ${"y".repeat(300)}`;
    const [redacted] = await list({ run: agentRun({ task: long }) });
    const redactedTask = redacted?.kind === "child-approval" ? redacted.child.task : "";
    expect(redactedTask.startsWith("[redacted path] yyy")).toBe(true);
    expect(redactedTask).toHaveLength(200);
    const [emoji] = await list({ run: agentRun({ mode: "code", task: "\u{1F600}".repeat(150) }) });
    const emojiTask = emoji?.kind === "child-approval" ? emoji.child.task : "";
    expect(emojiTask).toBe("\u{1F600}".repeat(100));
    expect(emojiTask.isWellFormed()).toBe(true);
  });

  it("keeps a Code subagent's question within a Code question's byte bound", async () => {
    const { askQuestion, list } = fixture();
    void askQuestion("é".repeat(5000));
    const [request] = await list({ run: agentRun({ mode: "code" }) });
    expect(request).toMatchObject({ mode: "code", kind: "child-question" });
    expect(new TextEncoder().encode(request?.text).byteLength).toBe(8192);
  });

  it("leaves out a request whose run or parent title cannot be read", async () => {
    const { askApproval, list } = fixture();
    void askApproval({ child: true });
    expect(await list({ run: undefined })).toEqual([]);
    expect(await list({ title: undefined })).toEqual([]);
    expect(
      await list({ run: agentRun({ parentThreadId: "00000000-0000-4000-8000-000000000025" }) }),
    ).toEqual([]);
  });
});

describe("windowMayListChildParent", () => {
  const window = decodeWindowId("00000000-0000-4000-8000-000000000801");
  const project = decodeProjectId("00000000-0000-4000-8000-00000000c010");
  const other = decodeProjectId("00000000-0000-4000-8000-00000000c011");
  const bound = {
    ...defaultWindowWorkspace(window),
    contextByMode: {
      ...defaultWindowWorkspace(window).contextByMode,
      code: contextKeyForProject("code", LOCAL_HOST_ID, project, "/repo"),
      work: contextKeyForProject("work", LOCAL_HOST_ID, project, "/repo"),
    },
  };

  it("lists a child on a thread the window is not showing, when the window is bound to that project", () => {
    expect(
      windowMayListChildParent({
        workspace: bound,
        parent: { mode: "code", projectId: project, active: true },
        projectActive: true,
      }),
    ).toBe(true);
    expect(
      windowMayListChildParent({
        workspace: bound,
        parent: { mode: "work", projectId: project, active: true },
        projectActive: true,
      }),
    ).toBe(true);
  });

  it("refuses a child whose project this window is not bound to, and an inactive parent", () => {
    expect(
      windowMayListChildParent({
        workspace: bound,
        parent: { mode: "code", projectId: other, active: true },
        projectActive: true,
      }),
    ).toBe(false);
    expect(
      windowMayListChildParent({
        workspace: defaultWindowWorkspace(window),
        parent: { mode: "code", projectId: project, active: true },
        projectActive: true,
      }),
    ).toBe(false);
    expect(
      windowMayListChildParent({
        workspace: bound,
        parent: { mode: "code", projectId: project, active: false },
        projectActive: true,
      }),
    ).toBe(false);
    expect(
      windowMayListChildParent({
        workspace: bound,
        parent: undefined,
        projectActive: true,
      }),
    ).toBe(false);
  });
});

describe("windowMayListChildThread", () => {
  const window = decodeWindowId(windowId);
  const project = decodeProjectId(projectId);
  const bound = {
    ...defaultWindowWorkspace(window),
    contextByMode: {
      ...defaultWindowWorkspace(window).contextByMode,
      work: contextKeyForProject("work", LOCAL_HOST_ID, project, "/repo"),
    },
  };
  const reads = (overrides: Partial<ChildParentReads> = {}): ChildParentReads => ({
    purged: () => false,
    codeThread: () => undefined,
    workThread: () => ({ projectId: project, lifecycle: "active" }),
    workspace: () => bound,
    hasActiveProject: () => true,
    ...overrides,
  });
  const ask = { threadId: parentThread, windowId };

  it("lists a child under an active Work parent in the window's bound project", () => {
    expect(windowMayListChildThread(reads(), ask)).toBe(true);
  });

  it("lists nothing under a purged parent, even while its projection row lingers", () => {
    expect(windowMayListChildThread(reads({ purged: () => true }), ask)).toBe(false);
  });

  it("lists nothing under an archived or deleted parent", () => {
    for (const lifecycle of ["archived", "deleting", "deleted"]) {
      expect(
        windowMayListChildThread(
          reads({ workThread: () => ({ projectId: project, lifecycle }) }),
          ask,
        ),
      ).toBe(false);
    }
    expect(
      windowMayListChildThread(
        reads({ codeThread: () => ({ projectId: project, lifecycle: "archived" }) }),
        ask,
      ),
    ).toBe(false);
  });

  it("lists nothing when the parent's project is gone or the parent is unknown", () => {
    expect(windowMayListChildThread(reads({ hasActiveProject: () => false }), ask)).toBe(false);
    expect(windowMayListChildThread(reads({ workThread: () => undefined }), ask)).toBe(false);
  });
});

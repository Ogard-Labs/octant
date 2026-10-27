import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeAgentRunId,
  decodeNativeHarnessSlotCandidate,
  decodeProviderModelId,
  EventActor,
  type NativeHarnessInteractionSource,
  type OctantMode,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  awaitsLeadApproval,
  awaitsLeadQuestion,
  leadApprovalFor,
  listLeadApprovalRequests,
  type LeadApprovalRowSources,
} from "./leadApprovalAttention";
import { NativeHarnessApprovalStore } from "./nativeHarnessApprovals";
import { registerNativeHarnessEvents } from "./nativeHarnessEvents";
import { NativeHarnessQuestionStore } from "./nativeHarnessQuestions";
import { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true });
});

const now = "2026-10-16T08:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const lead = decodeNativeHarnessSlotCandidate({
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "lead-model",
});
const thread = "00000000-0000-4000-8000-000000000024";
const otherThread = "00000000-0000-4000-8000-000000000025";
const windowId = "00000000-0000-4000-8000-000000000801";
const projectId = "00000000-0000-4000-8000-000000000901";
const child = {
  runId: decodeAgentRunId("00000000-0000-4000-8000-000000000090"),
  providerInstanceId: lead.providerInstanceId,
  modelId: decodeProviderModelId("worker-model"),
} satisfies NativeHarnessInteractionSource;

let counter = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`;

function openStores(connection: SqliteConnection, options: { readonly timeoutMs?: number } = {}) {
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
  return { sessions, approvals, questions };
}

function fixture(options: { readonly timeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-lead-approval-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const stores = openStores(connection, options);
  const ask = (
    input: {
      readonly mode?: OctantMode;
      readonly threadId?: string;
      readonly summary?: string;
      readonly child?: boolean;
    } = {},
  ) =>
    stores.approvals.ask({
      threadId: input.threadId ?? thread,
      mode: input.mode ?? "work",
      projectId: projectId as never,
      lead,
      toolName: "bash",
      ...(input.child === true ? { source: child } : {}),
      summary: input.summary ?? "bash: bun run test",
      approvalClass: "shell",
    });
  return { ...stores, connection, options, ask };
}

describe("a pending harness approval needs the person", () => {
  it("marks the thread from the moment the lead asks until any surface answers", async () => {
    const { approvals, sessions, ask } = fixture();
    expect(awaitsLeadApproval({ approvals, sessions }, thread)).toBe(false);
    const outcome = ask();
    expect(awaitsLeadApproval({ approvals, sessions }, thread)).toBe(true);
    expect(awaitsLeadApproval({ approvals, sessions }, otherThread)).toBe(false);
    const pending = sessions.read(thread)?.approvals?.[0];
    expect(approvals.decide(thread, String(pending?.id), "approve")).toBe("decided");
    await expect(outcome).resolves.toBe("approved");
    expect(awaitsLeadApproval({ approvals, sessions }, thread)).toBe(false);
  });

  it("clears when the person denies it, it expires, or the turn is cancelled", async () => {
    const denied = fixture();
    const deny = denied.ask();
    denied.approvals.decide(
      thread,
      String(denied.sessions.read(thread)?.approvals?.[0]?.id),
      "deny",
    );
    await deny;
    expect(awaitsLeadApproval(denied, thread)).toBe(false);

    const expired = fixture({ timeoutMs: 5 });
    await expired.ask();
    expect(awaitsLeadApproval(expired, thread)).toBe(false);

    const cancelled = fixture();
    const controller = new AbortController();
    const wait = cancelled.approvals.ask({
      threadId: thread,
      mode: "code",
      lead,
      toolName: "bash",
      summary: "bash: ls",
      approvalClass: "shell",
      signal: controller.signal,
    });
    expect(awaitsLeadApproval(cancelled, thread)).toBe(true);
    controller.abort();
    await wait;
    expect(awaitsLeadApproval(cancelled, thread)).toBe(false);
  });

  it("does not count a subagent's approval as the thread's own", () => {
    const { approvals, sessions, ask } = fixture();
    void ask({ child: true });
    expect(awaitsLeadApproval({ approvals, sessions }, thread)).toBe(false);
  });

  it("describes the oldest waiting approval with its mode and Project", () => {
    const { approvals, sessions, ask } = fixture();
    void ask({ mode: "code", summary: "bash: first" });
    void ask({ mode: "code", summary: "bash: second" });
    expect(leadApprovalFor({ approvals, sessions }, thread)).toMatchObject({
      threadId: thread,
      mode: "code",
      projectId,
      lostInRestart: false,
      approval: { summary: "bash: first" },
    });
  });
});

describe("a pending harness approval across a host restart", () => {
  function restarted() {
    const before = fixture();
    void before.ask({ mode: "code" });
    const pendingId = String(before.sessions.read(thread)?.approvals?.[0]?.id);
    const after = openStores(before.connection);
    return { before, after, pendingId };
  }

  it("keeps the thread needing the person, and says the call was lost", () => {
    const { after } = restarted();
    expect(after.sessions.read(thread)?.session.status).toBe("recovery-required");
    expect(leadApprovalFor(after, thread)).toMatchObject({ lostInRestart: true });
    expect(after.approvals.waiting()).toEqual([]);
  });

  it("never runs the action on an answer: the approval settles cancelled, not approved", () => {
    const { after, pendingId } = restarted();
    expect(after.approvals.decide(thread, pendingId, "approve")).toBe("lost-in-restart");
    expect(after.sessions.read(thread)?.approvals?.[0]?.status).toBe("cancelled");
    expect(awaitsLeadApproval(after, thread)).toBe(false);
  });

  it("stops needing the person once the session is resumed", () => {
    const { after } = restarted();
    expect(after.sessions.resume(thread)).toBe(true);
    expect(after.sessions.read(thread)?.approvals?.[0]?.status).toBe("expired");
    expect(awaitsLeadApproval(after, thread)).toBe(false);
  });

  it("keeps a paused session's live approval needing the person until it is decided", async () => {
    const { approvals, sessions, ask } = fixture();
    const outcome = ask();
    sessions.pause(thread, "paused-by-user", "Paused by the user.");
    expect(leadApprovalFor({ approvals, sessions }, thread)).toMatchObject({
      lostInRestart: false,
    });
    approvals.decide(thread, String(sessions.read(thread)?.approvals?.[0]?.id), "deny");
    await outcome;
    expect(awaitsLeadApproval({ approvals, sessions }, thread)).toBe(false);
  });
});

describe("a lead's own pending harness question needs the person", () => {
  function askQuestion(
    stores: ReturnType<typeof fixture>,
    input: { readonly child?: boolean; readonly signal?: AbortSignal } = {},
  ) {
    return stores.questions.ask({
      threadId: thread,
      mode: "work",
      projectId: projectId as never,
      lead,
      ...(input.child === true ? { source: child } : {}),
      prompt: "Which report should I update?",
      options: ["Q3", "Q4"],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  it("marks the thread from the moment the lead asks until any surface answers", async () => {
    const stores = fixture();
    expect(awaitsLeadQuestion(stores, thread)).toBe(false);
    const outcome = askQuestion(stores);
    expect(awaitsLeadQuestion(stores, thread)).toBe(true);
    expect(awaitsLeadQuestion(stores, otherThread)).toBe(false);
    // The question stays where it was journaled; nothing copies it elsewhere.
    const pending = stores.sessions.read(thread)?.questions[0];
    expect(pending).toMatchObject({ prompt: "Which report should I update?", status: "pending" });
    expect(stores.questions.answer(thread, String(pending?.id), "Q4")).toBe("answered");
    await expect(outcome).resolves.toMatchObject({ status: "answered", answer: "Q4" });
    expect(awaitsLeadQuestion(stores, thread)).toBe(false);
    expect(stores.sessions.read(thread)?.questions[0]).toMatchObject({
      status: "answered",
      answer: "Q4",
    });
  });

  it("clears when the turn is cancelled or the question expires", async () => {
    const cancelled = fixture();
    const controller = new AbortController();
    const wait = askQuestion(cancelled, { signal: controller.signal });
    expect(awaitsLeadQuestion(cancelled, thread)).toBe(true);
    controller.abort();
    await expect(wait).resolves.toMatchObject({ status: "cancelled" });
    expect(awaitsLeadQuestion(cancelled, thread)).toBe(false);

    const expired = fixture({ timeoutMs: 5 });
    await expect(askQuestion(expired)).resolves.toMatchObject({ status: "expired" });
    expect(awaitsLeadQuestion(expired, thread)).toBe(false);
  });

  it("does not count a subagent's question as the thread's own", () => {
    const stores = fixture();
    void askQuestion(stores, { child: true });
    expect(awaitsLeadQuestion(stores, thread)).toBe(false);
  });

  it("does not count a question no turn waits on any more, as after a restart", () => {
    const before = fixture();
    void askQuestion(before);
    const after = openStores(before.connection);
    expect(after.sessions.read(thread)?.questions[0]?.status).toBe("pending");
    expect(awaitsLeadQuestion(after, thread)).toBe(false);
  });
});

describe("the rows a window lists for a waiting harness approval", () => {
  function rowSources(
    stores: ReturnType<typeof fixture> | ReturnType<typeof openStores>,
    overrides: Partial<Pick<LeadApprovalRowSources, "threadFacts" | "authorizeThread">> = {},
  ): LeadApprovalRowSources {
    return {
      approvals: stores.approvals,
      sessions: stores.sessions,
      threadFacts: () => ({ title: "Quarterly report", projectId: projectId as never }),
      authorizeThread: ({ windowId: asked }) => {
        expect(asked).toBe(windowId);
        return true;
      },
      ...overrides,
    };
  }

  it("lists the approval with the thread's title and no way to answer it", async () => {
    const stores = fixture();
    void stores.ask({ mode: "code" });
    const requests = await listLeadApprovalRequests(rowSources(stores), windowId);
    expect(requests).toEqual([
      {
        mode: "code",
        kind: "lead-approval",
        projectId,
        threadId: thread,
        threadTitle: "Quarterly report",
        text: "bash: bun run test",
        requestedAt: now,
      },
    ]);
    expect(requests[0]).not.toHaveProperty("answer");
  });

  it("lists nothing for a subagent's approval, which the subagent rows carry", async () => {
    const stores = fixture();
    void stores.ask({ child: true });
    expect(await listLeadApprovalRequests(rowSources(stores), windowId)).toEqual([]);
  });

  it("names the Project the thread is in now, not the one its session started under", async () => {
    const stores = fixture();
    void stores.ask({ mode: "chat" });
    const moved = "00000000-0000-4000-8000-000000000902";
    const [request] = await listLeadApprovalRequests(
      rowSources(stores, {
        threadFacts: () => ({ title: "Quarterly report", projectId: moved as never }),
        authorizeThread: ({ projectId: asked }) => {
          expect(asked).toBe(moved);
          return true;
        },
      }),
      windowId,
    );
    expect(request).toMatchObject({ mode: "chat", projectId: moved });

    const [unfiled] = await listLeadApprovalRequests(
      rowSources(stores, { threadFacts: () => ({ title: "Quarterly report" }) }),
      windowId,
    );
    expect(unfiled).not.toHaveProperty("projectId");
  });

  it("lists nothing for a window that may not open the thread", async () => {
    const stores = fixture();
    void stores.ask();
    expect(
      await listLeadApprovalRequests(
        rowSources(stores, { authorizeThread: () => false }),
        windowId,
      ),
    ).toEqual([]);
  });

  it("lists nothing for a thread that has no title any more", async () => {
    const stores = fixture();
    void stores.ask();
    expect(
      await listLeadApprovalRequests(
        rowSources(stores, { threadFacts: () => undefined }),
        windowId,
      ),
    ).toEqual([]);
  });

  it("redacts a path or URL from a Work approval, as a Work request does", async () => {
    const stores = fixture();
    void stores.ask({
      mode: "work",
      summary: "edit: /Users/me/report.md from https://example.com/x",
    });
    const [request] = await listLeadApprovalRequests(rowSources(stores), windowId);
    expect(request?.text).toBe("edit: [redacted path] from [redacted reference]");
  });

  it("marks an approval a restart left behind as lost", async () => {
    const before = fixture();
    void before.ask({ mode: "chat" });
    const after = openStores(before.connection);
    const [request] = await listLeadApprovalRequests(rowSources(after), windowId);
    expect(request).toMatchObject({ kind: "lead-approval", mode: "chat", lostInRestart: true });
  });
});

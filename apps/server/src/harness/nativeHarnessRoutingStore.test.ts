import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { EventActor, decodeNativeHarnessSlotCandidate, decodeProjectId } from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { registerNativeHarnessEvents } from "./nativeHarnessEvents";
import { NativeHarnessRoutingStore } from "./nativeHarnessRoutingStore";
import { NativeHarnessApprovalStore } from "./nativeHarnessApprovals";
import { NativeHarnessQuestionStore } from "./nativeHarnessQuestions";
import { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const directories: string[] = [];
const now = "2026-09-05T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const host = "00000000-0000-4000-8000-0000000000aa";
const candidate = (model: string) =>
  decodeNativeHarnessSlotCandidate({
    hostId: host,
    providerInstanceId: "00000000-0000-4000-8000-000000000001",
    modelId: model,
  });
function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-harness-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function journalFor(connection: SqliteConnection): Journal {
  return new Journal({
    connection,
    registry: registerNativeHarnessEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
}

function uuidFactory() {
  let counter = 0;
  return () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`;
}

describe("native harness routing store", () => {
  it("starts with bindings but no slots, and keeps a saved table across a restart", () => {
    const connection = openConnection();
    const uuid = uuidFactory();
    const store = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(store.host().configuration.slots).toEqual([]);
    expect(store.host().configuration.jobSlots.length).toBeGreaterThan(0);
    const updated = store.updateHost({
      configuration: {
        slots: [{ id: "default" as never, candidates: [candidate("big")] }],
        jobSlots: [{ job: "lead", slotId: "default" as never }],
      } as never,
      expectedVersion: 0 as never,
    });
    expect(updated.kind).toBe("routing-settings");
    const restarted = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(restarted.host().version).toBe(1);
    expect(restarted.host().configuration.slots[0]?.candidates[0]?.modelId).toBe("big");
  });

  it("refuses a stale update instead of overwriting a newer table", () => {
    const store = new NativeHarnessRoutingStore({
      journal: journalFor(openConnection()),
      uuid: uuidFactory(),
      actor,
      clock: () => now,
    });
    store.updateHost({ configuration: { slots: [], jobSlots: [] }, expectedVersion: 0 });
    const stale = store.updateHost({
      configuration: { slots: [], jobSlots: [] },
      expectedVersion: 0 as never,
    });
    expect(stale).toMatchObject({ kind: "routing-refused", reason: "stale-version" });
  });

  it("keeps a Project override apart from the host default and clears it on request", () => {
    const connection = openConnection();
    const uuid = uuidFactory();
    const store = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    const projectId = decodeProjectId("00000000-0000-4000-8000-0000000000cc");
    // An override may only narrow the host table, so it is refused until the
    // host names the slot and the model it wants to use.
    const override = {
      kind: "set-project-routing-override" as const,
      projectId,
      configuration: {
        slots: [{ id: "task" as never, candidates: [candidate("small")] }],
        jobSlots: [],
      },
      expectedVersion: 0 as never,
    };
    expect(store.applyProjectCommand(override)).toMatchObject({
      kind: "routing-refused",
      reason: "not-a-subset",
    });
    store.updateHost({
      configuration: {
        slots: [{ id: "task" as never, candidates: [candidate("small"), candidate("big")] }],
        jobSlots: [{ job: "lead", slotId: "task" as never }],
      } as never,
      expectedVersion: 0 as never,
    });
    const set = store.applyProjectCommand(override);
    expect(set.kind).toBe("project-routing-override");
    expect(store.host().version).toBe(1);
    const restarted = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(restarted.projectOverride(projectId)?.configuration.slots[0]?.id).toBe("task");
    const cleared = restarted.applyProjectCommand({
      kind: "clear-project-routing-override",
      projectId,
      expectedVersion: 1 as never,
    });
    expect(cleared.kind).toBe("project-routing-override-cleared");
    expect(restarted.projectOverride(projectId)).toBeUndefined();
    // Clearing keeps the aggregate's version, so the Project can be set again.
    expect(restarted.applyProjectCommand({ ...override, expectedVersion: 2 as never }).kind).toBe(
      "project-routing-override",
    );
    const again = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(again.projectOverride(projectId)?.version).toBe(3);
  });
});

describe("native harness session store", () => {
  it("journals a session's routes and pause and rebuilds them after a restart", () => {
    const connection = openConnection();
    const threadId = "00000000-0000-4000-8000-000000000020";
    const uuid = uuidFactory();
    const store = new NativeHarnessSessionStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    store.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    store.recordRouteDecision(threadId, {
      kind: "primary",
      job: "researcher",
      slotId: "task" as never,
      candidate: candidate("small") as never,
      decidedAt: now as never,
      rejected: [],
    });
    store.pause(threadId, "paused-by-advisor", "The diff touches the release script.");
    const restarted = new NativeHarnessSessionStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    const view = restarted.read(threadId);
    expect(view?.routes).toHaveLength(1);
    expect(view?.session.status).toBe("paused-by-advisor");
    expect(restarted.resume(threadId)).toBe(true);
    expect(restarted.read(threadId)?.session.status).toBe("idle");
  });

  it("keeps a pause made while a turn was finishing after a restart", () => {
    const threadId = "00000000-0000-4000-8000-000000000030";
    const connection = openConnection();
    const uuid = uuidFactory();
    const open = () =>
      new NativeHarnessSessionStore({
        journal: journalFor(connection),
        uuid,
        actor,
        clock: () => now,
      });
    const store = open();
    store.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    store.markRunning(threadId);
    store.pause(threadId, "paused-by-user", "Paused by the user.");
    expect(store.turnInFlight(threadId)).toBe(true);
    store.recordTurn(threadId, turnRecord(store, threadId));

    const restarted = open();
    expect(restarted.read(threadId)?.session.status).toBe("paused-by-user");
    expect(restarted.turnInFlight(threadId)).toBe(false);
  });

  it("asks a person to recover a turn a restart cut off, and a resume settles it for good", () => {
    const threadId = "00000000-0000-4000-8000-000000000031";
    const connection = openConnection();
    const uuid = uuidFactory();
    const open = () =>
      new NativeHarnessSessionStore({
        journal: journalFor(connection),
        uuid,
        actor,
        clock: () => now,
      });
    const store = open();
    store.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    store.markRunning(threadId);

    // The process stops mid-turn; nothing picks the work back up on its own.
    const restarted = open();
    expect(restarted.read(threadId)?.session).toMatchObject({
      status: "recovery-required",
      detail: expect.stringContaining("restarted while a turn was running"),
    });
    expect(restarted.resume(threadId)).toBe(true);
    expect(restarted.read(threadId)?.session.status).toBe("idle");
    expect(open().read(threadId)?.session.status).toBe("idle");
  });

  it("expires a question a restart left unanswerable when the recovery is resumed", () => {
    const threadId = "00000000-0000-4000-8000-000000000032";
    const connection = openConnection();
    const uuid = uuidFactory();
    const open = () =>
      new NativeHarnessSessionStore({
        journal: journalFor(connection),
        uuid,
        actor,
        clock: () => now,
      });
    const store = open();
    store.ensure({
      threadId,
      mode: "chat",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    store.askQuestion(threadId, {
      id: "00000000-0000-4000-8000-0000000000c1",
      prompt: "Which database?",
      options: [],
      status: "pending",
      askedAt: now,
    } as never);

    const restarted = open();
    expect(restarted.read(threadId)?.session.status).toBe("recovery-required");
    restarted.resume(threadId);
    expect(restarted.read(threadId)?.questions[0]?.status).toBe("expired");
    expect(open().read(threadId)?.session.status).toBe("idle");
  });

  it("closes a turn that failed so neither a pause nor a restart waits on it", () => {
    const threadId = "00000000-0000-4000-8000-000000000033";
    const connection = openConnection();
    const uuid = uuidFactory();
    const open = () =>
      new NativeHarnessSessionStore({
        journal: journalFor(connection),
        uuid,
        actor,
        clock: () => now,
      });
    const store = open();
    store.ensure({
      threadId,
      mode: "work",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    store.markRunning(threadId);
    store.settleTurn(threadId);

    expect(store.turnInFlight(threadId)).toBe(false);
    expect(store.read(threadId)?.session.status).toBe("idle");
    expect(open().read(threadId)?.session.status).toBe("idle");
  });

  it("keeps a lead's question pending until any surface answers it, then rebuilds it after a restart", async () => {
    const threadId = "00000000-0000-4000-8000-000000000021";
    const connection = openConnection();
    const uuid = uuidFactory();
    const sessions = new NativeHarnessSessionStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    const shown: string[] = [];
    const questions = new NativeHarnessQuestionStore({
      sessions,
      uuid,
      clock: () => now,
      onAsked: ({ question }) => shown.push(question.prompt),
    });
    const asked = questions.ask({
      threadId,
      mode: "chat",
      lead: candidate("big") as never,
      prompt: "Which database?",
      options: ["sqlite", "postgres"],
    });
    const pending = sessions.read(threadId)?.questions[0];
    expect(pending?.status).toBe("pending");
    expect(shown).toEqual(["Which database?"]);
    expect(questions.answer("other-thread", String(pending!.id), "sqlite")).toBe(
      "question-not-found",
    );
    expect(questions.answer(threadId, String(pending!.id), "sqlite")).toBe("answered");
    await expect(asked).resolves.toMatchObject({ status: "answered", answer: "sqlite" });
    expect(questions.answer(threadId, String(pending!.id), "postgres")).toBe("already-settled");

    const restarted = new NativeHarnessSessionStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(restarted.read(threadId)?.questions[0]).toMatchObject({
      status: "answered",
      answer: "sqlite",
    });
  });

  it("settles a question as cancelled when the turn asking it is aborted", async () => {
    const threadId = "00000000-0000-4000-8000-000000000022";
    const uuid = uuidFactory();
    const sessions = new NativeHarnessSessionStore({
      journal: journalFor(openConnection()),
      uuid,
      actor,
      clock: () => now,
    });
    const questions = new NativeHarnessQuestionStore({ sessions, uuid, clock: () => now });
    const controller = new AbortController();
    const asked = questions.ask({
      threadId,
      mode: "code",
      lead: candidate("big") as never,
      prompt: "Continue?",
      options: [],
      signal: controller.signal,
    });
    controller.abort();
    await expect(asked).resolves.toMatchObject({ status: "cancelled" });
    expect(sessions.read(threadId)?.questions[0]?.status).toBe("cancelled");
  });

  it("shows the running turn's calls live and hands them to the record exactly once", () => {
    const threadId = "00000000-0000-4000-8000-000000000023";
    const store = new NativeHarnessSessionStore({
      journal: journalFor(openConnection()),
      uuid: uuidFactory(),
      actor,
      clock: () => now,
    });
    store.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    const call = { name: "read", summary: "read: a.ts", status: "ok", durationMs: 5, at: now };
    store.noteToolCall(threadId, call as never);
    expect(store.read(threadId)?.activeTools).toEqual([call]);
    expect(store.takeToolCalls(threadId)).toEqual([call]);
    expect(store.takeToolCalls(threadId)).toEqual([]);
    expect(store.read(threadId)?.activeTools).toEqual([]);
  });

  it("holds a tool call until a person allows it, and remembers an always for the session", async () => {
    const threadId = "00000000-0000-4000-8000-000000000024";
    const uuid = uuidFactory();
    const sessions = new NativeHarnessSessionStore({
      journal: journalFor(openConnection()),
      uuid,
      actor,
      clock: () => now,
    });
    const approvals = new NativeHarnessApprovalStore({ sessions, uuid, clock: () => now });
    const ask = () =>
      approvals.ask({
        threadId,
        mode: "code",
        lead: candidate("big") as never,
        toolName: "bash",
        summary: "bash: bun test",
        approvalClass: "shell-commands",
      });
    const first = ask();
    const pending = sessions.read(threadId)?.approvals?.[0];
    expect(pending).toMatchObject({ status: "pending", toolName: "bash" });
    expect(approvals.decide("other-thread", String(pending!.id), "approve")).toBe(
      "approval-not-found",
    );
    expect(approvals.decide(threadId, String(pending!.id), "deny")).toBe("decided");
    await expect(first).resolves.toBe("denied");
    expect(approvals.decide(threadId, String(pending!.id), "approve")).toBe("already-settled");

    const second = ask();
    const again = sessions.read(threadId)?.approvals?.[1];
    expect(approvals.decide(threadId, String(again!.id), "approve-always")).toBe("decided");
    await expect(second).resolves.toBe("approved");
    expect(sessions.read(threadId)?.approvals?.[1]).toMatchObject({
      status: "approved",
      remembered: true,
    });
    // The class is remembered: no third approval is journaled.
    await expect(ask()).resolves.toBe("approved");
    expect(sessions.read(threadId)?.approvals).toHaveLength(2);
  });

  it("keeps a child's approval local to one request and expires unanswered child interactions on restart", async () => {
    vi.useFakeTimers();
    const threadId = "00000000-0000-4000-8000-000000000024";
    const uuid = uuidFactory();
    const journal = journalFor(openConnection());
    const sessions = new NativeHarnessSessionStore({ journal, uuid, actor, clock: () => now });
    const approvals = new NativeHarnessApprovalStore({ sessions, uuid, clock: () => now });
    const source = {
      runId: "00000000-0000-4000-8000-000000000090" as never,
      providerInstanceId: candidate("big").providerInstanceId as never,
      modelId: "big" as never,
    };
    const controller = new AbortController();
    const ask = () =>
      approvals.ask({
        threadId,
        mode: "code",
        lead: candidate("big") as never,
        toolName: "provider-action",
        summary: "Run the child command",
        approvalClass: "provider-action",
        source,
        signal: controller.signal,
      });
    const first = ask();
    const pending = sessions.read(threadId)?.approvals?.[0];
    expect(pending).toMatchObject({ source, status: "pending" });
    expect(approvals.decide(threadId, String(pending?.id), "approve-always")).toBe("decided");
    await expect(first).resolves.toBe("approved");
    expect(sessions.read(threadId)?.approvals?.[0]?.remembered).not.toBe(true);
    void ask();
    expect(sessions.read(threadId)?.approvals).toHaveLength(2);
    const questions = new NativeHarnessQuestionStore({ sessions, uuid, clock: () => now });
    void questions.ask({
      threadId,
      mode: "code",
      lead: candidate("big") as never,
      prompt: "Choose a target",
      options: [],
      source,
      signal: controller.signal,
    });
    const restored = new NativeHarnessSessionStore({ journal, uuid, actor, clock: () => now });
    expect(restored.read(threadId)?.approvals?.[1]?.status).toBe("expired");
    expect(restored.read(threadId)?.questions[0]?.status).toBe("expired");
    const afterRestart = new NativeHarnessApprovalStore({
      sessions: restored,
      uuid,
      clock: () => now,
    });
    expect(
      afterRestart.decide(threadId, String(restored.read(threadId)?.approvals?.[1]?.id), "approve"),
    ).toBe("already-settled");
    // The old process no longer exists after a restart; its waiters never run.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("queues a steering note, delivers it once to the next tool step, and drops it when the turn ends", () => {
    const threadId = "00000000-0000-4000-8000-000000000025";
    const store = new NativeHarnessSessionStore({
      journal: journalFor(openConnection()),
      uuid: uuidFactory(),
      actor,
      clock: () => now,
    });
    store.ensure({
      threadId,
      mode: "chat",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    const note = {
      id: "00000000-0000-4000-8000-000000000091",
      text: "Use sqlite.",
      status: "queued",
      at: now,
    };
    expect(store.queueSteering(threadId, note as never)).toBe("queued");
    expect(store.read(threadId)?.steering).toMatchObject([
      { text: "Use sqlite.", status: "queued" },
    ]);
    expect(store.deliverSteering(threadId)).toEqual(["Use sqlite."]);
    expect(store.deliverSteering(threadId)).toEqual([]);
    expect(store.read(threadId)?.steering).toMatchObject([{ status: "delivered" }]);
    store.clearSteering(threadId, "delivered");
    expect(store.read(threadId)?.steering).toEqual([]);
  });

  it("keeps a steering note typed before a restart and hands it to the lead on the next turn", () => {
    const threadId = "00000000-0000-4000-8000-000000000026";
    const connection = openConnection();
    const uuid = uuidFactory();
    const open = () =>
      new NativeHarnessSessionStore({
        journal: journalFor(connection),
        uuid,
        actor,
        clock: () => now,
      });
    const note = (n: number, text: string) =>
      ({
        id: `00000000-0000-4000-8000-00000000009${n}`,
        text,
        status: "queued",
        at: now,
      }) as never;
    const before = open();
    before.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    before.queueSteering(threadId, note(1, "Use sqlite."));
    expect(before.deliverSteering(threadId)).toEqual(["Use sqlite."]);
    // Typed after the last tool step of a turn the process never finished.
    before.queueSteering(threadId, note(2, "Skip the docs."));

    const after = open();
    expect(after.read(threadId)?.steering).toMatchObject([
      { text: "Use sqlite.", status: "delivered" },
      { text: "Skip the docs.", status: "queued" },
    ]);
    after.clearSteering(threadId, "delivered");
    expect(after.deliverSteering(threadId)).toEqual(["Skip the docs."]);
    after.clearSteering(threadId, "delivered");
    expect(open().read(threadId)?.steering).toEqual([]);
  });

  it("queues a retried note once and hands the leftover notes to only one of two clients, across a restart", () => {
    const threadId = "00000000-0000-4000-8000-000000000028";
    const connection = openConnection();
    const uuid = uuidFactory();
    const open = () =>
      new NativeHarnessSessionStore({
        journal: journalFor(connection),
        uuid,
        actor,
        clock: () => now,
      });
    const note = (n: number, text: string) =>
      ({
        id: `00000000-0000-4000-8000-00000000008${n}`,
        text,
        status: "queued",
        at: now,
      }) as never;
    const before = open();
    before.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    expect(before.queueSteering(threadId, note(1, "Use sqlite."))).toBe("queued");
    // The client did not hear back and sent the same note again.
    expect(before.queueSteering(threadId, note(1, "Use sqlite."))).toBe("queued");
    before.queueSteering(threadId, note(2, "Skip the docs."));

    const after = open();
    expect(after.read(threadId)?.steering).toHaveLength(2);
    // Two terminals see the turn end together; only the first one sends the notes.
    expect(after.takeSteering(threadId).map((entry) => entry.text)).toEqual([
      "Use sqlite.",
      "Skip the docs.",
    ]);
    expect(after.takeSteering(threadId)).toEqual([]);
    // A retry that arrives after the note was taken is still the same note.
    expect(after.queueSteering(threadId, note(1, "Use sqlite."))).toBe("queued");
    expect(open().read(threadId)?.steering).toEqual([]);
  });

  it("refuses a steering note for a thread with no harness run yet", () => {
    const store = new NativeHarnessSessionStore({
      journal: journalFor(openConnection()),
      uuid: uuidFactory(),
      actor,
      clock: () => now,
    });
    expect(
      store.queueSteering("00000000-0000-4000-8000-000000000027", {
        id: "00000000-0000-4000-8000-000000000099",
        text: "Hello",
        status: "queued",
        at: now,
      } as never),
    ).toBe("no-session");
  });
});

/** A completed turn as the observer records it, for tests that only need one to exist. */
function turnRecord(store: NativeHarnessSessionStore, threadId: string): never {
  const session = store.read(threadId)?.session;
  if (session === undefined) throw new Error("no session");
  return {
    turnId: "00000000-0000-4000-8000-0000000000d1",
    sessionId: session.id,
    sequence: session.turnsRun + 1,
    job: "lead",
    route: {
      kind: "primary",
      job: "lead",
      slotId: session.leadSlotId,
      candidate: session.lead,
      decidedAt: now,
      rejected: [],
    },
    toolCalls: 0,
    stopReason: "end-of-turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    startedAt: now,
    endedAt: now,
  } as never;
}

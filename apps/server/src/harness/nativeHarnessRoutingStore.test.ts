import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("journals a session's routes and follow-ups and rebuilds them after a restart", () => {
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
    store.recordFollowUps(threadId, {
      turnId: "00000000-0000-4000-8000-000000000031",
      suggestions: [
        {
          id: "00000000-0000-4000-8000-000000000041",
          title: "Add tests",
          prompt: "Write tests for the new parser.",
          target: "new-thread",
        },
      ],
    } as never);
    store.pause(threadId, "paused-by-advisor", "The diff touches the release script.");
    const restarted = new NativeHarnessSessionStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    const view = restarted.read(threadId);
    expect(view?.routes).toHaveLength(1);
    expect(view?.followUps?.suggestions[0]?.title).toBe("Add tests");
    expect(view?.session.status).toBe("paused-by-advisor");
    expect(restarted.resume(threadId)).toBe(true);
    expect(restarted.read(threadId)?.session.status).toBe("idle");
  });

  it("activates a follow-up once and refuses the second activation", () => {
    const threadId = "00000000-0000-4000-8000-000000000020";
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
    const suggestionId = "00000000-0000-4000-8000-000000000041" as never;
    store.recordFollowUps(threadId, {
      turnId: "00000000-0000-4000-8000-000000000031",
      suggestions: [
        { id: suggestionId, title: "Next", prompt: "Do the next thing.", target: "same-thread" },
      ],
    } as never);
    const created = { kind: "same-thread", threadId } as const;
    expect(store.activateFollowUp(threadId, suggestionId, created)).toBe("activated");
    expect(store.activateFollowUp(threadId, suggestionId, created)).toBe("already-activated");
    expect(
      store.activateFollowUp(threadId, "00000000-0000-4000-8000-000000000099" as never, created),
    ).toBe("suggestion-not-found");
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
    expect(store.queueSteering(threadId, note as never)).toBe(true);
    expect(store.read(threadId)?.steering).toMatchObject([
      { text: "Use sqlite.", status: "queued" },
    ]);
    expect(store.deliverSteering(threadId)).toEqual(["Use sqlite."]);
    expect(store.deliverSteering(threadId)).toEqual([]);
    expect(store.read(threadId)?.steering).toMatchObject([{ status: "delivered" }]);
    store.clearSteering(threadId, "delivered");
    expect(store.read(threadId)?.steering).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventActor, decodeNativeHarnessSlotCandidate } from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { registerNativeHarnessEvents } from "./nativeHarnessEvents";
import { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";
import {
  UnattendedRestartResume,
  type UnattendedRestartResumeDependencies,
} from "./unattendedRestartResume";

const directories: string[] = [];
const connections: SqliteConnection[] = [];
const now = "2026-11-12T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const threadId = "00000000-0000-4000-8000-000000000020";
const windowId = "00000000-0000-4000-8000-0000000000f1";
const lead = decodeNativeHarnessSlotCandidate({
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "frontier-large",
});
let counter = 0;
const uuid = () => `cccccccc-cccc-4ccc-8ccc-${(++counter).toString(16).padStart(12, "0")}`;

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-unattended-resume-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

/** A store as a host start builds it: replayed from the journal. */
function restart(connection: SqliteConnection): NativeHarnessSessionStore {
  return new NativeHarnessSessionStore({
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
}

function askQuestion(sessions: NativeHarnessSessionStore): void {
  sessions.askQuestion(threadId, {
    id: uuid() as never,
    prompt: "Which report should I update?",
    options: ["Q3", "Q4"],
    status: "pending",
    askedAt: now as never,
  });
}

/** A session a restart found waiting on an answer, with no turn open. */
function answerDropped(connection: SqliteConnection): NativeHarnessSessionStore {
  const live = restart(connection);
  live.ensure({ threadId, mode: "work", leadSlotId: "default" as never, lead });
  askQuestion(live);
  return restart(connection);
}

/** A session a restart found with a turn that had started and never settled. */
function turnCutOff(connection: SqliteConnection): NativeHarnessSessionStore {
  const live = restart(connection);
  live.ensure({ threadId, mode: "work", leadSlotId: "default" as never, lead });
  live.markRunning(threadId);
  return restart(connection);
}

function runner(
  sessions: NativeHarnessSessionStore,
  overrides: Partial<UnattendedRestartResumeDependencies> = {},
) {
  const order: string[] = [];
  const deps = {
    settingOn: () => true,
    sessions,
    windowFor: vi.fn(async () => windowId as string | undefined),
    recoveryBlockers: vi.fn(async () => {
      order.push("blockers");
      return [] as ReadonlyArray<string>;
    }),
    settleInterruptedTurns: vi.fn(() => {
      order.push("settle");
    }),
    continueRecovery: vi.fn(async () => {
      order.push("continue");
      return { kind: "queued" } as const;
    }),
    ...overrides,
  } satisfies UnattendedRestartResumeDependencies;
  return { deps, order, subject: new UnattendedRestartResume(deps) };
}

describe("resuming interrupted turns after a restart", () => {
  it("changes nothing while the setting is off", async () => {
    const sessions = answerDropped(openConnection());
    const { deps, subject } = runner(sessions, { settingOn: () => false });
    await subject.pass();
    await subject.pass();
    expect(deps.settleInterruptedTurns).not.toHaveBeenCalled();
    expect(deps.continueRecovery).not.toHaveBeenCalled();
    expect(sessions.read(threadId)?.session.status).toBe("recovery-required");
    expect(sessions.read(threadId)?.questions?.[0]?.status).toBe("pending");
  });

  it("resumes a session with nothing running, as the person's own Resume would, under a live window", async () => {
    const connection = openConnection();
    const sessions = answerDropped(connection);
    const { deps, order, subject } = runner(sessions);
    await subject.pass();
    expect(order).toEqual(["blockers", "settle", "continue"]);
    expect(deps.continueRecovery).toHaveBeenCalledWith({ threadId, windowId, mode: "work" });
    expect(sessions.read(threadId)?.session.status).toBe("idle");
    expect(sessions.read(threadId)?.questions?.[0]?.status).toBe("expired");
    // Once: a later pass and a later start-up find nothing left to resume.
    await subject.pass();
    expect(deps.continueRecovery).toHaveBeenCalledTimes(1);
    expect(restart(connection).read(threadId)?.session.status).toBe("idle");
  });

  it("never resumes a turn the restart cut off: it queues no continuation and starts nothing", async () => {
    const sessions = turnCutOff(openConnection());
    const { deps, subject } = runner(sessions);
    await subject.pass();
    await subject.pass();
    expect(deps.windowFor).not.toHaveBeenCalled();
    expect(deps.settleInterruptedTurns).not.toHaveBeenCalled();
    expect(deps.continueRecovery).not.toHaveBeenCalled();
    expect(sessions.read(threadId)?.session.status).toBe("recovery-required");
    expect(sessions.turnInFlight(threadId)).toBe(true);
  });

  it("waits until a window that reaches the thread is back", async () => {
    const sessions = answerDropped(openConnection());
    let live: string | undefined;
    const { deps, subject } = runner(sessions, { windowFor: async () => live });
    await subject.pass();
    expect(deps.continueRecovery).not.toHaveBeenCalled();
    expect(sessions.read(threadId)?.session.status).toBe("recovery-required");
    live = windowId;
    await subject.pass();
    expect(deps.continueRecovery).toHaveBeenCalledTimes(1);
    expect(sessions.read(threadId)?.session.status).toBe("idle");
  });

  it("leaves the thread for a person when its folder or model is gone, or the continuation is refused", async () => {
    const blocked = answerDropped(openConnection());
    const first = runner(blocked, { recoveryBlockers: async () => ["The folder is gone."] });
    await first.subject.pass();
    await first.subject.pass();
    expect(first.deps.continueRecovery).not.toHaveBeenCalled();
    expect(blocked.read(threadId)?.session.status).toBe("recovery-required");

    const refused = answerDropped(openConnection());
    const continueRecovery = vi.fn(async () => ({ kind: "refused", message: "Held." }) as const);
    const second = runner(refused, { continueRecovery });
    await second.subject.pass();
    await second.subject.pass();
    expect(continueRecovery).toHaveBeenCalledTimes(1);
    expect(refused.read(threadId)?.session.status).toBe("recovery-required");
  });

  it("does not resume again when a second restart finds its own resume unfinished", async () => {
    const connection = openConnection();
    const first = answerDropped(connection);
    await runner(first).subject.pass();
    expect(first.read(threadId)?.session.status).toBe("idle");
    // The work it started asked again and no turn completed before the host stopped.
    askQuestion(first);
    const second = restart(connection);
    expect(second.recoveryStanding(threadId)).toBe("answer-dropped");
    const again = runner(second);
    await again.subject.pass();
    await again.subject.pass();
    expect(again.deps.continueRecovery).not.toHaveBeenCalled();
    expect(second.read(threadId)?.session.status).toBe("recovery-required");
  });

  it("does nothing for a thread a person already resumed", async () => {
    const sessions = answerDropped(openConnection());
    const { deps, subject } = runner(sessions, { windowFor: async () => undefined });
    await subject.pass();
    sessions.resume(threadId);
    deps.windowFor = vi.fn(async () => windowId);
    await subject.pass();
    expect(deps.continueRecovery).not.toHaveBeenCalled();
    expect(sessions.resumedUnattended(threadId)).toBe(false);
  });
});

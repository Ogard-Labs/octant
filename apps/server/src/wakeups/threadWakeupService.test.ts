import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_WAKEUP_AGGREGATE,
  THREAD_WAKEUP_CHANGED,
  THREAD_WAKEUP_TURN_HEADING,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  ThreadWakeupService,
  type ThreadWakeupLimits,
  type ThreadWakeupModePort,
} from "./threadWakeupService";

const START = Date.parse("2026-11-14T12:00:00.000Z");
const threadId = "83000000-0000-4000-8000-000000000001";

let directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openJournal(clock: () => number): { journal: Journal; connection: SqliteConnection } {
  const directory = mkdtempSync(join(tmpdir(), "octant-wakeups-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => new Date(clock()).toISOString());
  const runtime = createPhase1RuntimeRegistries();
  return {
    connection,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => new Date(clock()).toISOString(),
    }),
  };
}

/** A fake clock whose timers fire only when the test moves time forward. */
function fakeTime(start = START) {
  let now = start;
  const timers = new Map<number, { at: number; fire: () => void }>();
  let next = 0;
  return {
    now: () => now,
    schedule: (at: number, fire: () => void) => {
      next += 1;
      timers.set(next, { at, fire });
      return next;
    },
    unschedule: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pendingTimers: () => timers.size,
    async advanceTo(at: number) {
      now = at;
      for (const [handle, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.fire();
      }
      await flush();
    },
  };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function port(overrides: Partial<ThreadWakeupModePort> = {}) {
  let turns = 0;
  const startTurn = vi.fn<ThreadWakeupModePort["startTurn"]>(async () => {
    turns += 1;
    return { status: "started", turnId: `turn-${turns}` };
  });
  return {
    threadOpen: vi.fn<ThreadWakeupModePort["threadOpen"]>(() => true),
    startTurn,
    ...overrides,
  };
}

function service(
  time: ReturnType<typeof fakeTime>,
  journal: Journal,
  code: ThreadWakeupModePort,
  hostStartedAt = new Date(time.now()),
  limits?: ThreadWakeupLimits,
) {
  return new ThreadWakeupService({
    ...(limits === undefined ? {} : { limits: () => limits }),
    journal,
    clock: () => new Date(time.now()),
    uuid: () => crypto.randomUUID(),
    ports: { work: port(), code },
    hostStartedAt,
    schedule: time.schedule,
    unschedule: time.unschedule,
    busyRetryMs: 15_000,
  });
}

function journaledChanges(journal: Journal): string[] {
  return journal
    .replayAggregateType({
      aggregateType: THREAD_WAKEUP_AGGREGATE,
      afterSequence: 0,
      limit: 100,
      eventName: THREAD_WAKEUP_CHANGED,
    })
    .map((event) => (event.payload as { change: string }).change);
}

describe("thread wake-ups", () => {
  it("records a wake-up the agent asks for, shows it in its thread, and starts the thread's turn at the due time", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const code = port();
    const wakeups = service(time, journal, code);
    wakeups.start();
    const schedule = wakeups.forSession("code", threadId);

    const scheduled = await schedule.schedule({
      kind: "delay",
      providerToolName: "ScheduleWakeup",
      delaySeconds: 300,
      prompt: "Check whether the build finished.",
      reason: "The build takes about five minutes.",
    });
    expect(scheduled).toMatchObject({
      status: "scheduled",
      clampedDelaySeconds: 300,
      wasClamped: false,
      wakeup: { status: "pending", nextFireAt: "2026-11-14T12:05:00.000Z" },
    });
    expect(wakeups.list("code", threadId)).toEqual([
      expect.objectContaining({
        threadId,
        prompt: "Check whether the build finished.",
        status: "pending",
        nextFireAt: "2026-11-14T12:05:00.000Z",
      }),
    ]);
    expect(await schedule.list()).toHaveLength(1);

    await time.advanceTo(START + 4 * 60_000);
    expect(code.startTurn).not.toHaveBeenCalled();
    await time.advanceTo(START + 5 * 60_000);
    expect(code.startTurn).toHaveBeenCalledWith(
      threadId,
      `${THREAD_WAKEUP_TURN_HEADING}\n\nCheck whether the build finished.`,
    );
    expect(wakeups.list("code", threadId)).toEqual([]);
    expect(journaledChanges(journal)).toEqual(["scheduled", "fired"]);
  });

  it("lets the person cancel a waiting wake-up so it never fires", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const code = port();
    const wakeups = service(time, journal, code);
    wakeups.start();
    const scheduled = await wakeups.forSession("code", threadId).schedule({
      kind: "cron",
      providerToolName: "CronCreate",
      cron: "*/10 * * * *",
      recurring: true,
      prompt: "Look at the queue.",
    });
    if (scheduled.status !== "scheduled") throw new Error("Expected a scheduled wake-up");

    expect(wakeups.cancel(scheduled.wakeup.id)).toMatchObject({
      kind: "thread-wakeup-updated",
      wakeup: { status: "ended", endedReason: "cancelled-by-person" },
    });
    expect(time.pendingTimers()).toBe(0);
    await time.advanceTo(START + 60 * 60_000);
    expect(code.startTurn).not.toHaveBeenCalled();
    expect(wakeups.list("code", threadId)).toEqual([]);
  });

  it("shows a wake-up that came due while the host was down as missed and fires it only when the person runs it", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const before = service(time, journal, port());
    before.start();
    await before.forSession("code", threadId).schedule({
      kind: "delay",
      providerToolName: "ScheduleWakeup",
      delaySeconds: 600,
      prompt: "Resume the migration.",
    });
    before.stop();

    // The host comes back an hour later.
    const later = fakeTime(START + 60 * 60_000);
    const code = port();
    const after = service(later, journal, code, new Date(later.now()));
    after.start();
    await flush();
    expect(code.startTurn).not.toHaveBeenCalled();
    const [missed] = after.list("code", threadId);
    expect(missed).toMatchObject({ status: "missed", nextFireAt: "2026-11-14T12:10:00.000Z" });
    if (missed === undefined) throw new Error("Expected the missed wake-up");
    await later.advanceTo(later.now() + 24 * 60 * 60_000);
    expect(code.startTurn).not.toHaveBeenCalled();

    await expect(after.runMissed(missed.id)).resolves.toMatchObject({
      kind: "thread-wakeup-updated",
      wakeup: { status: "ended", endedReason: "fired" },
    });
    expect(code.startTurn).toHaveBeenCalledOnce();
    expect(journaledChanges(journal)).toEqual(["scheduled", "missed", "run-requested", "fired"]);
  });

  it("runs a wake-up that came due while the host was down once on return when Settings asks", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const before = service(time, journal, port());
    before.start();
    await before.forSession("code", threadId).schedule({
      kind: "delay",
      providerToolName: "ScheduleWakeup",
      delaySeconds: 600,
      prompt: "Resume the migration.",
    });
    before.stop();

    const later = fakeTime(START + 60 * 60_000);
    const code = port();
    const after = service(later, journal, code, new Date(later.now()), {
      waitingPerThread: 8,
      runMissedOnReturn: true,
    });
    after.start();
    await flush();
    expect(code.startTurn).toHaveBeenCalledOnce();
    expect(after.list("code", threadId)).toEqual([]);
    expect(journaledChanges(journal)).toEqual(["scheduled", "fired"]);
  });

  it("keeps a due wake-up waiting while its thread is busy and fires it after the thread's turn", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    let busy = true;
    const code = port({
      startTurn: vi.fn(async () =>
        busy ? { status: "busy" as const } : { status: "started" as const, turnId: "turn-1" },
      ),
    });
    const wakeups = service(time, journal, code);
    wakeups.start();
    await wakeups.forSession("code", threadId).schedule({
      kind: "delay",
      providerToolName: "ScheduleWakeup",
      delaySeconds: 60,
      prompt: "Check again.",
    });
    await time.advanceTo(START + 60_000);
    expect(code.startTurn).toHaveBeenCalledOnce();
    busy = false;
    // Past the grace window: it came due on time, so it still fires.
    await time.advanceTo(START + 60_000 + 15_000);
    await time.advanceTo(START + 10 * 60_000);
    expect(code.startTurn).toHaveBeenCalledTimes(2);
    expect(wakeups.list("code", threadId)).toEqual([]);
  });

  it("ends a recurring wake-up that outlived its seven days while its thread was busy, without starting a turn", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    let busy = true;
    const code = port({
      startTurn: vi.fn(async () =>
        busy ? { status: "busy" as const } : { status: "started" as const, turnId: "turn-1" },
      ),
    });
    const wakeups = service(time, journal, code);
    wakeups.start();
    const scheduled = await wakeups.forSession("code", threadId).schedule({
      kind: "cron",
      providerToolName: "CronCreate",
      cron: "*/30 * * * *",
      recurring: true,
      prompt: "Look at the queue.",
    });
    const expiresAt = wakeups.list("code", threadId)[0]?.expiresAt;
    if (scheduled.status !== "scheduled" || expiresAt === undefined) {
      throw new Error("Expected a scheduled recurring wake-up");
    }
    await time.advanceTo(Date.parse(scheduled.wakeup.nextFireAt));
    expect(code.startTurn).toHaveBeenCalledOnce();
    busy = false;
    // The busy retry comes round only after the wake-up's lifetime ended.
    await time.advanceTo(Date.parse(expiresAt) + 60_000);
    expect(code.startTurn).toHaveBeenCalledOnce();
    expect(wakeups.list("code", threadId)).toEqual([]);
    expect(journaledChanges(journal).at(-1)).toBe("ended");
  });

  it("follows a recurring wake-up to its next match after each fire", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const code = port();
    const wakeups = service(time, journal, code);
    wakeups.start();
    const scheduled = await wakeups.forSession("code", threadId).schedule({
      kind: "cron",
      providerToolName: "CronCreate",
      cron: "*/30 * * * *",
      recurring: true,
      prompt: "Look at the queue.",
    });
    if (scheduled.status !== "scheduled") throw new Error("Expected a scheduled wake-up");
    const first = Date.parse(scheduled.wakeup.nextFireAt);
    await time.advanceTo(first);
    expect(code.startTurn).toHaveBeenCalledOnce();
    expect(wakeups.list("code", threadId)).toEqual([
      expect.objectContaining({
        status: "pending",
        nextFireAt: new Date(first + 30 * 60_000).toISOString(),
        lastTurnId: "turn-1",
      }),
    ]);
  });

  it("refuses a wake-up past the thread's cap from Settings, and holds one asked too soon", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const wakeups = service(time, journal, port(), new Date(time.now()), {
      waitingPerThread: 3,
      runMissedOnReturn: false,
    });
    wakeups.start();
    const schedule = wakeups.forSession("code", threadId);
    await expect(
      schedule.schedule({
        kind: "cron",
        providerToolName: "CronCreate",
        cron: "* * * * *",
        recurring: true,
        prompt: "Every minute.",
      }),
    ).resolves.toMatchObject({ status: "scheduled" });
    // A delay under a minute is held to one minute, as the runtime's tool says.
    await expect(
      schedule.schedule({
        kind: "delay",
        providerToolName: "ScheduleWakeup",
        delaySeconds: 1,
        prompt: "Now.",
      }),
    ).resolves.toMatchObject({ status: "scheduled", clampedDelaySeconds: 60, wasClamped: true });
    await schedule.schedule({
      kind: "delay",
      providerToolName: "ScheduleWakeup",
      delaySeconds: 600,
      prompt: "Check again.",
    });
    await expect(
      schedule.schedule({
        kind: "delay",
        providerToolName: "ScheduleWakeup",
        delaySeconds: 600,
        prompt: "One too many.",
      }),
    ).resolves.toMatchObject({ status: "refused" });
    expect(wakeups.list("code", threadId)).toHaveLength(3);
    // Another thread has its own cap.
    await expect(
      wakeups.forSession("code", "83000000-0000-4000-8000-000000000002").schedule({
        kind: "delay",
        providerToolName: "ScheduleWakeup",
        delaySeconds: 600,
        prompt: "Elsewhere.",
      }),
    ).resolves.toMatchObject({ status: "scheduled" });
  });

  it("drops a purged thread's wake-ups and journals nothing after the purge", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const code = port();
    const wakeups = service(time, journal, code);
    wakeups.start();
    await wakeups.forSession("code", threadId).schedule({
      kind: "delay",
      providerToolName: "ScheduleWakeup",
      delaySeconds: 600,
      prompt: "Later.",
    });
    wakeups.onCommittedAppend({
      events: [
        {
          eventName: "thread-retention.thread-purged@1",
          payload: {
            kind: "thread-purged",
            mode: "code",
            threadId,
            purgedAt: "2026-11-14T12:01:00.000Z",
          },
        },
      ],
    });
    expect(wakeups.list("code", threadId)).toEqual([]);
    await time.advanceTo(START + 60 * 60_000);
    expect(code.startTurn).not.toHaveBeenCalled();
    // The purge already took the wake-up's events; ending it would journal
    // the purged thread's id again.
    expect(journaledChanges(journal)).toEqual(["scheduled"]);
  });

  it("lets the agent delete its own wake-up and end its delayed loop, and nobody else's", async () => {
    const time = fakeTime();
    const { journal } = openJournal(time.now);
    const wakeups = service(time, journal, port());
    wakeups.start();
    const mine = wakeups.forSession("code", threadId);
    const other = wakeups.forSession("work", threadId);
    const created = await mine.schedule({
      kind: "cron",
      providerToolName: "CronCreate",
      cron: "0 * * * *",
      recurring: false,
      prompt: "On the hour.",
    });
    if (created.status !== "scheduled") throw new Error("Expected a scheduled wake-up");
    await mine.schedule({
      kind: "delay",
      providerToolName: "ScheduleWakeup",
      delaySeconds: 120,
      prompt: "Loop.",
    });
    await expect(other.cancel(created.wakeup.id)).resolves.toMatchObject({ status: "refused" });
    await expect(mine.cancelDelayed()).resolves.toBe(1);
    await expect(mine.cancel(created.wakeup.id)).resolves.toEqual({ status: "cancelled" });
    expect(wakeups.list("code", threadId)).toEqual([]);
  });
});

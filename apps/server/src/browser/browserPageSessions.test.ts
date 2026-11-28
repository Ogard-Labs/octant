import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserPageOpened,
  decodeBrowserThreadId,
  decodeEventActor,
  decodeWindowId,
  type BrowserPageCloseReason,
  type BrowserProfile,
  type ThreadRetentionThreadId,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import {
  BrowserPageProjection,
  compactClosedBrowserPages,
} from "../persistence/browserPageProjection";
import { recordJournalWatermark } from "../persistence/journalWatermark";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedProjectData, erasePurgedThread } from "../persistence/threadPurge";
import { readJournalGrowth } from "../persistence/journalGrowth";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { BrowserPageOffers } from "./browserPageOffers";
import { BrowserPageSessions } from "./browserPageSessions";

const now = "2026-11-25T09:00:00.000Z";
const projectId = "a0000000-0000-4000-8000-0000000000a1";
const windowId = decodeWindowId("a0000000-0000-4000-8000-0000000000b1");
const otherWindow = decodeWindowId("a0000000-0000-4000-8000-0000000000b2");
const accountId = "a0000000-0000-4000-8000-0000000000c1";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open() {
  const directory = mkdtempSync(join(tmpdir(), "octant-browser-pages-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const sessions = new BrowserPageSessions({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const events = () =>
    connection
      .prepare(
        `SELECT aggregate_id, aggregate_version, event_name, payload_json
         FROM event_journal WHERE aggregate_type = 'browser-page' ORDER BY global_sequence`,
      )
      .all() as ReadonlyArray<{
      readonly aggregate_id: string;
      readonly aggregate_version: number;
      readonly event_name: string;
      readonly payload_json: string;
    }>;
  return { connection, journal, runtime, sessions, events };
}

const page = (
  pageId: string,
  threadId: string,
  extra: Partial<Parameters<BrowserPageSessions["opened"]>[0]> = {},
): Parameters<BrowserPageSessions["opened"]>[0] =>
  ({
    pageId,
    threadId,
    windowId,
    mode: "code",
    profileKind: "private",
    projectId,
    ...extra,
  }) as never;
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const thread = (n: number) => id(1000 + n);
const actor = { kind: "local-user" as const, actorId: OCTANT_LOCAL_ACTOR_ID };

describe("Browser session records", () => {
  it("records a start and an end, and the open row leaves with the end", () => {
    const { sessions, events } = open();
    sessions.opened(page(id(1), thread(1)));
    expect(sessions.open().map((row) => row.pageId)).toEqual([id(1)]);
    expect(sessions.ended(id(1), thread(1), "closed-by-person")).toBe(true);
    expect(sessions.open()).toEqual([]);
    expect(events().map((row) => row.event_name)).toEqual([
      "browser.page-opened@1",
      "browser.page-closed@1",
    ]);
  });

  it("never records an address, a title, or page content", () => {
    const { sessions, events } = open();
    sessions.opened(page(id(1), thread(1), { profileKind: "personal" }));
    sessions.ended(id(1), thread(1), "expired");
    const keys = events().flatMap((row) => Object.keys(JSON.parse(row.payload_json)));
    expect(keys.sort()).toEqual(
      [
        "pageId",
        "threadId",
        "windowId",
        "mode",
        "profileKind",
        "projectId",
        "openedAt",
        "pageId",
        "threadId",
        "reason",
        "closedAt",
      ].sort(),
    );
    expect(
      Schema.decodeUnknownResult(BrowserPageOpened, { onExcessProperty: "error" })({
        ...JSON.parse(events()[0]?.payload_json ?? "{}"),
        url: "https://example.com/private",
      })._tag,
    ).toBe("Failure");
  });

  it("records a Private page only as the kind Private, and an account page with its account", () => {
    const { sessions, events } = open();
    sessions.opened(page(id(1), thread(1)));
    sessions.opened(page(id(2), thread(2), { profileKind: "account", accountId } as never));
    const [privatePage, accountPage] = events().map((row) => JSON.parse(row.payload_json));
    expect(privatePage.profileKind).toBe("private");
    expect(privatePage.accountId).toBeUndefined();
    expect(accountPage.accountId).toBe(accountId);
    // An account id on a page that is not an account page is not a record.
    sessions.opened(page(id(3), thread(3), { accountId } as never));
    expect(sessions.page(id(3))).toBeUndefined();
  });

  it("writes one end per page, and says so to the second caller", () => {
    const { sessions } = open();
    sessions.opened(page(id(1), thread(1)));
    expect(sessions.ended(id(1), thread(1), "reopened")).toBe(true);
    expect(sessions.ended(id(1), thread(1), "dismissed")).toBe(false);
    expect(sessions.ended(id(404), thread(1), "dismissed")).toBe(false);
  });

  it("rebuilds the same open pages from the journal, and nothing from a journal with neither event", () => {
    const { sessions, connection, journal, runtime } = open();
    const projection = new BrowserPageProjection();
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(sessions.open()).toEqual([]);
    sessions.opened(page(id(1), thread(1)));
    sessions.opened(page(id(2), thread(2)));
    sessions.ended(id(2), thread(2), "closed-by-agent");
    const before = sessions.open();
    rebuildProjection({ connection, journal, projection, clock: () => now });
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(sessions.open()).toEqual(before);
    expect(before.map((row) => row.pageId)).toEqual([id(1)]);
    expect(
      runtime.events.decode("browser.page-closed@1", 1, {
        pageId: id(1),
        threadId: thread(1),
        reason: "dismissed",
        closedAt: now,
      }),
    ).toMatchObject({ reason: "dismissed" });
    expect(() =>
      runtime.events.decode("browser.page-closed@1", 1, {
        pageId: id(1),
        threadId: thread(1),
        reason: "dismissed",
        closedAt: now,
        url: "https://example.com",
      }),
    ).toThrow();
  });

  it("deletes nothing from the journal while it runs, so the verification watermark survives", () => {
    const { sessions, connection } = open();
    recordJournalWatermark(connection, "fingerprint", 1, now);
    for (let n = 0; n < 100; n += 1) {
      sessions.opened(page(id(n), thread(1)));
      sessions.ended(id(n), thread(1), "closed-by-person");
    }
    const watermark = connection
      .prepare("SELECT verified_through FROM journal_verification_watermark")
      .get();
    expect(watermark).toEqual({ verified_through: 1 });
    expect(sessions.open()).toEqual([]);
  });

  it("leaves no more than the open pages once the persistence start compacts the ended ones", () => {
    const { sessions, connection, events } = open();
    for (let n = 0; n < 1000; n += 1) {
      sessions.opened(page(id(n), thread(1)));
      sessions.ended(id(n), thread(1), "closed-by-person");
    }
    sessions.opened(page(id(5000), thread(1)));
    const report = compactClosedBrowserPages(connection);
    expect(report).toEqual({ pagesRemoved: 1000, eventsRemoved: 2000 });
    expect(events().map((row) => row.aggregate_id)).toEqual([id(5000)]);
    expect(sessions.open().map((row) => row.pageId)).toEqual([id(5000)]);
    // The heads of the removed aggregates left with them, and only theirs.
    const heads = connection
      .prepare(`SELECT aggregate_id FROM aggregate_heads WHERE aggregate_type = 'browser-page'`)
      .all();
    expect(heads).toEqual([{ aggregate_id: id(5000) }]);
    // The projection checkpoint still matches the journal after the sweep.
    const head = connection
      .prepare(`SELECT coalesce(max(global_sequence), 0) AS n FROM event_journal`)
      .get() as { n: number };
    const checkpoint = connection
      .prepare(`SELECT last_sequence AS n FROM projection_checkpoints WHERE projection_name = ?`)
      .get("browser-page") as { n: number } | undefined;
    expect(checkpoint?.n ?? 0).toBeLessThanOrEqual(head.n);
    // A page that opens after the sweep still appends at its own version.
    expect(sessions.ended(id(5000), thread(1), "closed-by-person")).toBe(true);
  });

  it("keeps the projection checkpoint inside the journal when the compaction removes the journal's tail", () => {
    const { sessions, connection } = open();
    for (let n = 0; n < 10; n += 1) {
      sessions.opened(page(id(n), thread(1)));
      sessions.ended(id(n), thread(1), "closed-by-person");
    }
    const checkpoint = () =>
      connection
        .prepare(`SELECT last_sequence AS n FROM projection_checkpoints WHERE projection_name = ?`)
        .get("browser-page") as { n: number } | undefined;
    expect(checkpoint()?.n).toBe(20);
    compactClosedBrowserPages(connection);
    const head = connection
      .prepare(`SELECT coalesce(max(global_sequence), 0) AS n FROM event_journal`)
      .get() as { n: number };
    expect(head.n).toBe(0);
    expect(checkpoint()?.n ?? 0).toBeLessThanOrEqual(head.n);
  });

  it("offers no more pages after a start than the bound, newest first", () => {
    const { sessions } = open();
    for (let n = 1; n <= 40; n += 1) {
      sessions.opened(page(id(n), thread(n)));
    }
    const offered = sessions.settleAtStart(() => false);
    expect(offered.size).toBe(25);
    expect(offered.has(id(40))).toBe(true);
    expect(offered.has(id(1))).toBe(false);
    expect(sessions.open()).toHaveLength(25);
  });

  it("does not offer a page whose start never reached the journal, and offers one whose end did not", () => {
    const { sessions } = open();
    // A crash between opening the page and journaling it leaves no record.
    expect(sessions.open()).toEqual([]);
    // A crash between closing the page and journaling the end leaves the start,
    // so the next start offers it and the person can dismiss it.
    sessions.opened(page(id(1), thread(1)));
    const offered = sessions.settleAtStart(() => false);
    expect([...offered]).toEqual([id(1)]);
  });

  it("settles the pages a run left: ends those of a closed thread and offers the newest of each thread", () => {
    const { sessions, events, connection } = open();
    sessions.opened(page(id(1), thread(1)));
    sessions.opened(page(id(2), thread(1)));
    sessions.opened(page(id(3), thread(2)));
    sessions.opened(page(id(4), thread(3)));
    const offered = sessions.settleAtStart((row) => row.threadId === thread(3));
    expect([...offered].sort()).toEqual([id(2), id(3)].sort());
    expect(
      sessions
        .open()
        .map((row) => row.pageId)
        .sort(),
    ).toEqual([id(2), id(3)].sort());
    // Settled pages end in the journal; the next persistence start compacts them.
    compactClosedBrowserPages(connection);
    expect(events().every((row) => [id(2), id(3)].includes(row.aggregate_id))).toBe(true);
  });
});

describe("Browser session diagnostics", () => {
  it("counts the records by kind name and never names a page, a thread, or a Project", () => {
    const { sessions, connection } = open();
    sessions.opened(page(id(1), thread(1)));
    const growth = JSON.stringify(readJournalGrowth(connection, new Date(now)));
    expect(growth).toContain("browser-page");
    for (const secret of [id(1), thread(1), projectId, String(windowId)]) {
      expect(growth).not.toContain(secret);
    }
  });
});

describe("Browser session views", () => {
  it("feeds no usage, activity or other view: only its own table holds a trace", () => {
    const { sessions, connection } = open();
    sessions.opened(page(id(1), thread(1)));
    sessions.opened(page(id(2), thread(2)));
    sessions.ended(id(2), thread(2), "closed-by-person");
    const tables = connection
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%projection%'
         AND name NOT IN ('browser_page_projection', 'projection_checkpoints', 'projection_quarantine')`,
      )
      .all() as ReadonlyArray<{ name: string }>;
    expect(tables.length).toBeGreaterThan(5);
    for (const { name } of tables) {
      const count = connection.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
        n: number;
      };
      expect(count.n, name).toBe(0);
    }
  });
});

describe("Browser session purge", () => {
  it("is taken with its thread, both events and the open row", () => {
    const { sessions, connection, events } = open();
    sessions.opened(page(id(1), thread(1)));
    sessions.opened(page(id(2), thread(1)));
    sessions.ended(id(2), thread(1), "closed-by-person");
    sessions.opened(page(id(3), thread(2)));
    erasePurgedThread({
      connection,
      mode: "code",
      threadId: thread(1) as unknown as ThreadRetentionThreadId,
    });
    expect(sessions.open().map((row) => row.pageId)).toEqual([id(3)]);
    expect(events().map((row) => row.aggregate_id)).toEqual([id(3)]);
  });

  it("is taken with its Project", () => {
    const { sessions, connection, events } = open();
    const other = "a0000000-0000-4000-8000-0000000000a2";
    sessions.opened(page(id(1), thread(1)));
    sessions.opened(page(id(2), thread(2), { projectId: other as never }));
    erasePurgedProjectData({ connection, projectId: projectId as never, canvasIds: [] });
    expect(sessions.open().map((row) => row.pageId)).toEqual([id(2)]);
    expect(events().map((row) => row.aggregate_id)).toEqual([id(2)]);
  });
});

describe("Browser page offers", () => {
  function offers(
    harness: ReturnType<typeof open>,
    overrides: Partial<ConstructorParameters<typeof BrowserPageOffers>[0]> = {},
  ) {
    const offered = harness.sessions.settleAtStart(() => false);
    return new BrowserPageOffers({
      sessions: harness.sessions,
      offeredAtStart: offered,
      canOpenBrowser: () => true,
      hasOpenPage: () => false,
      profileState: async () => "exists" as const,
      ...overrides,
    });
  }
  const command = (pageId: string, threadId: string) => ({
    pageId: pageId as never,
    threadId: decodeBrowserThreadId(threadId),
    mode: "code" as const,
  });

  it("offers a page the previous run left open, in the profile it was in", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1), { profileKind: "project" }));
    const result = await offers(harness).read(windowId, decodeBrowserThreadId(thread(1)));
    expect(result).toMatchObject({
      pageId: id(1),
      status: "offered",
      profile: { kind: "project", projectId },
    });
  });

  it("offers a page this running host held when its app quit, without a restart, until a newer page supersedes it", async () => {
    const harness = open();
    const subject = offers(harness);
    harness.sessions.opened(page(id(2), thread(2)));
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(2)))).toBeUndefined();
    harness.sessions.hold(id(2));
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(2)))).toMatchObject({
      pageId: id(2),
      status: "offered",
    });
    harness.sessions.opened(page(id(3), thread(2)));
    expect(harness.sessions.open().map((row) => row.pageId)).toEqual([id(3)]);
  });

  it("offers nothing for a page opened after this start, or while the thread has a page", async () => {
    const harness = open();
    const subject = offers(harness);
    harness.sessions.opened(page(id(2), thread(2)));
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(2)))).toBeUndefined();
    harness.sessions.opened(page(id(3), thread(3)));
    const later = offers(harness, { hasOpenPage: () => true });
    expect(await later.read(windowId, decodeBrowserThreadId(thread(3)))).toBeUndefined();
  });

  it("says the profile is gone instead of offering it, and refuses the claim", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1), { profileKind: "account", accountId } as never));
    const subject = offers(harness, { profileState: async () => "gone" as const });
    const read = await subject.read(windowId, decodeBrowserThreadId(thread(1)));
    expect(read?.status).toBe("profile-gone");
    expect(await subject.claim(windowId, command(id(1), thread(1)))).toEqual({
      status: "refused",
      reason: "profile-gone",
    });
    expect(subject.dismiss(windowId, command(id(1), thread(1)), actor)).toEqual({
      status: "dismissed",
    });
  });

  it("lets exactly one of two windows reserve the page, and writes no end by itself", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness);
    const results = await Promise.all([
      subject.claim(windowId, command(id(1), thread(1))),
      subject.claim(otherWindow, command(id(1), thread(1))),
    ]);
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "refused")).toEqual([
      { status: "refused", reason: "not-offered" },
    ]);
    // A reservation is not an ending: the record is still open for the next start.
    expect(harness.sessions.open().map((row) => row.pageId)).toEqual([id(1)]);
    // The holder still sees the offer after a reload; the other window does not.
    const holder = results[0]?.status === "claimed" ? windowId : otherWindow;
    const other = holder === windowId ? otherWindow : windowId;
    expect(await subject.read(holder, decodeBrowserThreadId(thread(1)))).toMatchObject({
      status: "offered",
    });
    expect(await subject.read(other, decodeBrowserThreadId(thread(1)))).toBeUndefined();
  });

  it("gives the page back when the open fails, is abandoned, or the window goes away", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness);
    const cmd = command(id(1), thread(1));
    expect(await subject.claim(windowId, cmd)).toMatchObject({ status: "claimed" });
    expect(await subject.claim(otherWindow, cmd)).toMatchObject({ reason: "not-offered" });
    expect(subject.release(otherWindow, cmd)).toEqual({ status: "released" });
    expect(await subject.claim(otherWindow, cmd)).toMatchObject({ reason: "not-offered" });
    expect(subject.release(windowId, cmd)).toEqual({ status: "released" });
    expect(await subject.claim(otherWindow, cmd)).toMatchObject({ status: "claimed" });
    subject.releaseWindow(otherWindow);
    expect(await subject.claim(windowId, cmd)).toMatchObject({ status: "claimed" });
    expect(harness.sessions.open()).toHaveLength(1);
  });

  it("lets a reservation lapse so a window that vanished cannot hold the page for good", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    let clock = 0;
    const subject = offers(harness, { now: () => clock });
    const cmd = command(id(1), thread(1));
    expect(await subject.claim(windowId, cmd)).toMatchObject({ status: "claimed" });
    expect(subject.holds(windowId, cmd)).toBe(true);
    clock += 121_000;
    expect(subject.holds(windowId, cmd)).toBe(false);
    expect(await subject.claim(otherWindow, cmd)).toMatchObject({ status: "claimed" });
  });

  it("re-reserves a lapsed page for the open that names it, and says so when another window holds it", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    let clock = 0;
    const subject = offers(harness, { now: () => clock });
    const cmd = command(id(1), thread(1));
    expect(await subject.claim(windowId, cmd)).toMatchObject({ status: "claimed" });
    clock += 121_000;
    // The person's open names the page after the reservation lapsed: it holds it again.
    expect(subject.holdForOpen(windowId, cmd)).toBe("held");
    expect(subject.holds(windowId, cmd)).toBe(true);
    expect(await subject.claim(otherWindow, cmd)).toMatchObject({ reason: "not-offered" });
    // Lapsed again, another window claims first: the first window's open is refused.
    clock += 121_000;
    expect(await subject.claim(otherWindow, cmd)).toMatchObject({ status: "claimed" });
    expect(subject.holdForOpen(windowId, cmd)).toBe("held-by-other");
    expect(subject.holdForOpen(otherWindow, cmd)).toBe("held");
    expect(subject.holdForOpen(windowId, command(id(9), thread(1)))).toBe("not-offered");
  });

  it("ends the old record as reopened only when the reserved open succeeds, and supersedes older offers of the thread", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    harness.sessions.opened(page(id(2), thread(2)));
    const subject = offers(harness);
    expect(await subject.claim(windowId, command(id(1), thread(1)))).toMatchObject({
      status: "claimed",
    });
    // The open that was reserved for it succeeds: the new page ends the old record.
    harness.sessions.opened(page(id(10), thread(1)), { actor, reopens: id(1) });
    expect(harness.sessions.page(id(1))).toBeUndefined();
    const closed = harness.connection
      .prepare(
        `SELECT payload_json FROM event_journal WHERE aggregate_id = ? AND event_name = 'browser.page-closed@1'`,
      )
      .get(id(1)) as { payload_json: string };
    expect(JSON.parse(closed.payload_json).reason).toBe("reopened");
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(1)))).toBeUndefined();
    // An open of its own in another thread ends that thread's carried offer.
    harness.sessions.opened(page(id(11), thread(2)), { actor });
    expect(harness.sessions.page(id(2))).toBeUndefined();
    expect([...harness.sessions.settleAtStart(() => false)].sort()).toEqual([id(10), id(11)]);
  });

  it("keeps the offer and says it could not be checked when the profile list cannot be read", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1), { profileKind: "account", accountId } as never));
    const subject = offers(harness, { profileState: async () => "unknown" as const });
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(1)))).toMatchObject({
      status: "profile-unchecked",
    });
    expect(await subject.claim(windowId, command(id(1), thread(1)))).toMatchObject({
      status: "claimed",
    });
  });

  it("holds the offer for a thread that cannot open a Browser now and shows it when it can", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    // The thread is live but its mode is off or its Project archived: not ended.
    const hidden = harness.sessions.settleAtStart(() => false);
    expect([...hidden]).toEqual([id(1)]);
    let allowed = false;
    const subject = new BrowserPageOffers({
      sessions: harness.sessions,
      offeredAtStart: hidden,
      canOpenBrowser: () => allowed,
      hasOpenPage: () => false,
      profileState: async () => "exists",
    });
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(1)))).toBeUndefined();
    expect(harness.sessions.open()).toHaveLength(1);
    allowed = true;
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(1)))).toMatchObject({
      status: "offered",
    });
  });

  it("ends the offer on dismiss and does not offer it at the next start", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness);
    const deviceActor = decodeEventActor({
      kind: "remote-device",
      actorId: "c0000000-0000-4000-8000-0000000000d1",
      deviceId: "c0000000-0000-4000-8000-0000000000d1",
    });
    expect(subject.dismiss(windowId, command(id(1), thread(1)), deviceActor)).toEqual({
      status: "dismissed",
    });
    // The end names the device that dismissed, never the host's own actor.
    const written = harness.connection
      .prepare(
        `SELECT actor_kind FROM event_journal WHERE aggregate_id = ? AND event_name = 'browser.page-closed@1'`,
      )
      .get(id(1));
    expect(written).toEqual({ actor_kind: "remote-device" });
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(1)))).toBeUndefined();
    expect([...harness.sessions.settleAtStart(() => false)]).toEqual([]);
  });

  it("refuses a window that cannot open the thread before changing anything", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness, { canOpenBrowser: () => false });
    expect(await subject.claim(windowId, command(id(1), thread(1)))).toEqual({
      status: "refused",
      reason: "not-allowed",
    });
    expect(subject.dismiss(windowId, command(id(1), thread(1)), actor)).toEqual({
      status: "refused",
      reason: "not-allowed",
    });
    expect(harness.sessions.open()).toHaveLength(1);
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(1)))).toBeUndefined();
  });

  it("refuses to claim a page of another thread or a page that is not offered", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness);
    expect(await subject.claim(windowId, command(id(1), thread(2)))).toEqual({
      status: "refused",
      reason: "not-offered",
    });
    expect(await subject.claim(windowId, command(id(9), thread(1)))).toEqual({
      status: "refused",
      reason: "not-offered",
    });
  });
});

export type { BrowserPageCloseReason, BrowserProfile };

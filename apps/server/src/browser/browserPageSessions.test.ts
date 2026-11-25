import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserPageOpened,
  decodeBrowserThreadId,
  decodeWindowId,
  type BrowserPageCloseReason,
  type BrowserProfile,
  type ThreadRetentionThreadId,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { BrowserPageProjection } from "../persistence/browserPageProjection";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedProjectData, erasePurgedThread } from "../persistence/threadPurge";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { BrowserPageOffers } from "./browserPageOffers";
import { BrowserPageSessions } from "./browserPageSessions";

const now = "2026-11-25T09:00:00.000Z";
const projectId = "a0000000-0000-4000-8000-0000000000a1";
const windowId = decodeWindowId("a0000000-0000-4000-8000-0000000000b1");
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
      Schema.decodeUnknownEither(BrowserPageOpened)({
        ...JSON.parse(events()[0]?.payload_json ?? "{}"),
        url: "https://example.com/private",
      })._tag,
    ).toBe("Left");
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

  it("keeps the journal and the table bounded across a thousand opens and closes", () => {
    const { sessions, connection } = open();
    for (let n = 0; n < 1000; n += 1) {
      sessions.opened(page(id(n), thread(1)));
      sessions.ended(id(n), thread(1), "closed-by-person");
    }
    sessions.opened(page(id(5000), thread(1)));
    const kept = (
      connection
        .prepare(`SELECT count(*) AS n FROM event_journal WHERE aggregate_type = 'browser-page'`)
        .get() as { n: number }
    ).n;
    expect(kept).toBeLessThanOrEqual(2 * 32 + 1);
    expect(sessions.open().map((row) => row.pageId)).toEqual([id(5000)]);
    // The projection checkpoint still matches the journal after the sweeps.
    const head = connection
      .prepare(`SELECT coalesce(max(global_sequence), 0) AS n FROM event_journal`)
      .get() as { n: number };
    const checkpoint = connection
      .prepare(`SELECT last_sequence AS n FROM projection_checkpoints WHERE projection_name = ?`)
      .get("browser-page") as { n: number } | undefined;
    expect(checkpoint?.n ?? 0).toBeLessThanOrEqual(head.n);
  });

  it("does not offer a page whose start never reached the journal, and offers one whose end did not", () => {
    const { sessions } = open();
    // A crash between opening the page and journaling it leaves no record.
    expect(sessions.open()).toEqual([]);
    // A crash between closing the page and journaling the end leaves the start,
    // so the next start offers it and the person can dismiss it.
    sessions.opened(page(id(1), thread(1)));
    const offered = sessions.settleAtStart(() => true);
    expect([...offered]).toEqual([id(1)]);
  });

  it("settles the pages a run left: ends those of a closed thread and offers the newest of each thread", () => {
    const { sessions, events } = open();
    sessions.opened(page(id(1), thread(1)));
    sessions.opened(page(id(2), thread(1)));
    sessions.opened(page(id(3), thread(2)));
    sessions.opened(page(id(4), thread(3)));
    const offered = sessions.settleAtStart((row) => row.threadId !== thread(3));
    expect([...offered].sort()).toEqual([id(2), id(3)].sort());
    expect(
      sessions
        .open()
        .map((row) => row.pageId)
        .sort(),
    ).toEqual([id(2), id(3)].sort());
    // Settled pages left no history once swept.
    expect(events().every((row) => [id(2), id(3)].includes(row.aggregate_id))).toBe(true);
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
    const offered = harness.sessions.settleAtStart(() => true);
    return new BrowserPageOffers({
      sessions: harness.sessions,
      offeredAtStart: offered,
      canOpenBrowser: () => true,
      hasOpenPage: () => false,
      profileExists: async () => true,
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
    const subject = offers(harness, { profileExists: async () => false });
    const read = await subject.read(windowId, decodeBrowserThreadId(thread(1)));
    expect(read?.status).toBe("profile-gone");
    expect(await subject.claim(windowId, command(id(1), thread(1)))).toEqual({
      status: "refused",
      reason: "profile-gone",
    });
    expect(subject.dismiss(windowId, command(id(1), thread(1)))).toEqual({ status: "dismissed" });
  });

  it("lets exactly one of two windows claim, and ends the offer for the next start", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness);
    const results = await Promise.all([
      subject.claim(windowId, command(id(1), thread(1))),
      subject.claim(windowId, command(id(1), thread(1))),
    ]);
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "refused")).toEqual([
      { status: "refused", reason: "not-offered" },
    ]);
    // The claim wrote the end, so a later start offers nothing.
    expect([...harness.sessions.settleAtStart(() => true)]).toEqual([]);
  });

  it("ends the offer on dismiss and does not offer it at the next start", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness);
    expect(subject.dismiss(windowId, command(id(1), thread(1)))).toEqual({ status: "dismissed" });
    expect(await subject.read(windowId, decodeBrowserThreadId(thread(1)))).toBeUndefined();
    expect([...harness.sessions.settleAtStart(() => true)]).toEqual([]);
  });

  it("refuses a window that cannot open the thread before changing anything", async () => {
    const harness = open();
    harness.sessions.opened(page(id(1), thread(1)));
    const subject = offers(harness, { canOpenBrowser: () => false });
    expect(await subject.claim(windowId, command(id(1), thread(1)))).toEqual({
      status: "refused",
      reason: "not-allowed",
    });
    expect(subject.dismiss(windowId, command(id(1), thread(1)))).toEqual({
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

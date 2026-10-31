import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeBrowserCaptureId,
  decodeBrowserThreadId,
  MAX_BROWSER_CAPTURE_BYTES,
  MAX_BROWSER_CAPTURES_PER_THREAD,
  type BrowserCaptureOutcome,
  type BrowserThreadId,
  type CorrelationId,
  type ProviderInstanceId,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { BrowserCaptureService, type KeepBrowserCaptureInput } from "./browserCaptureService";
import { BrowserCaptureStore } from "./browserCaptureStore";

/** 1x1 PNG: magic-number valid and tiny. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const now = "2026-10-12T09:00:00.000Z";
const threadA = decodeBrowserThreadId("d0000000-0000-4000-8000-00000000000a");
const threadB = decodeBrowserThreadId("d0000000-0000-4000-8000-00000000000b");
const personActorId = "d0000000-0000-4000-8000-0000000000ff";
const providerInstanceId = "d0000000-0000-4000-8000-0000000000aa" as ProviderInstanceId;
const correlationId = "d0000000-0000-4000-8000-0000000000cc" as CorrelationId;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function open(dataDirectory?: string) {
  const directory = mkdtempSync(join(tmpdir(), "octant-browser-capture-"));
  directories.push(directory);
  const root = dataDirectory ?? directory;
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let tick = 0;
  const service = new BrowserCaptureService({
    store: new BrowserCaptureStore(root),
    journal,
    connection,
    personActor: { kind: "local-user", actorId: personActorId as never },
    uuid: randomUUID,
    clock: () => new Date(Date.parse(now) + ++tick * 1_000).toISOString(),
  });
  return { connection, directory: root, service };
}

function pngDataUrl(bytes: Uint8Array = PNG): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function request(overrides: Partial<KeepBrowserCaptureInput> = {}): KeepBrowserCaptureInput {
  return {
    threadId: threadA,
    dataUrl: pngDataUrl(),
    url: "https://example.com/pricing?plan=pro",
    title: "Pricing",
    takenBy: "agent",
    providerInstanceId,
    correlationId,
    ...overrides,
  };
}

function kept(outcome: BrowserCaptureOutcome) {
  if (outcome.status !== "kept") throw new Error(`capture was not kept: ${outcome.reason}`);
  return outcome.captureId;
}

function captureDirectory(root: string, threadId: BrowserThreadId, captureId: string): string {
  return join(root, "browser-captures", String(threadId), captureId);
}

function journalRows(connection: SqliteConnection) {
  return connection
    .prepare(
      `SELECT aggregate_type, aggregate_id, aggregate_version, event_name, actor_kind, payload_json
       FROM event_journal WHERE aggregate_type = 'browser-capture' ORDER BY global_sequence`,
    )
    .all() as ReadonlyArray<{
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly aggregate_version: number;
    readonly event_name: string;
    readonly actor_kind: string;
    readonly payload_json: string;
  }>;
}

describe("BrowserCaptureService", () => {
  it("keeps a screenshot as a thread capture that records where it came from but holds no bytes", async () => {
    const { connection, directory, service } = open();
    const captureId = kept(await service.keep(request()));

    const [row, ...rest] = journalRows(connection);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      aggregate_id: String(threadA),
      event_name: "browser.capture-kept@1",
      actor_kind: "agent",
    });
    const payload = JSON.parse(row?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      captureId,
      threadId: String(threadA),
      origin: "https://example.com",
      url: "https://example.com/pricing?plan=pro",
      title: "Pricing",
      mime: "image/png",
      size: PNG.length,
    });
    expect(String(payload.hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.payload_json).not.toContain(PNG.toString("base64"));
    expect(row?.payload_json).not.toContain("data:image");
    expect(existsSync(join(captureDirectory(directory, threadA, captureId), "finalized.bin"))).toBe(
      true,
    );
    expect(service.list(threadA).map((capture) => capture.captureId)).toEqual([captureId]);
  });

  it("records the profile a signed-in page lived in, and none for a page outside one", async () => {
    const { service } = open();
    const signedIn = kept(await service.keep(request({ profile: { kind: "personal" } })));
    const plain = kept(await service.keep(request()));

    const byId = new Map(service.list(threadA).map((capture) => [capture.captureId, capture]));
    expect(byId.get(signedIn)?.profile).toEqual({ kind: "personal" });
    expect(byId.get(plain)?.profile).toBeUndefined();
  });

  it("attributes a capture to the person when they took it in the pane", async () => {
    const { connection, service } = open();
    kept(await service.keep(request({ takenBy: "person" })));
    expect(journalRows(connection)[0]?.actor_kind).toBe("local-user");
  });

  it("reads back the same bytes for the thread that owns the capture", async () => {
    const { service } = open();
    const captureId = kept(await service.keep(request()));
    const found = await service.read(threadA, captureId);
    expect(found?.capture.origin).toBe("https://example.com");
    expect(Buffer.from(found?.bytes ?? [])).toEqual(PNG);
  });

  it("does not hand a capture to another thread", async () => {
    const { service } = open();
    const captureId = kept(await service.keep(request()));
    expect(await service.read(threadB, captureId)).toBeUndefined();
    expect(service.list(threadB)).toEqual([]);
    expect(await service.read(threadA, decodeBrowserCaptureId(randomUUID()))).toBeUndefined();
  });

  it("lists newest first and keeps only the newest 32, removing the oldest bytes first", async () => {
    const { directory, service } = open();
    const ids: string[] = [];
    for (let index = 0; index < MAX_BROWSER_CAPTURES_PER_THREAD + 2; index += 1) {
      ids.push(kept(await service.keep(request({ title: `Page ${index}` }))));
    }

    const listed = service.list(threadA);
    expect(listed).toHaveLength(MAX_BROWSER_CAPTURES_PER_THREAD);
    expect(listed[0]?.captureId).toBe(ids.at(-1));
    expect(listed.at(-1)?.captureId).toBe(ids[2]);
    expect(existsSync(captureDirectory(directory, threadA, ids[0] ?? ""))).toBe(false);
    expect(existsSync(captureDirectory(directory, threadA, ids[1] ?? ""))).toBe(false);
    expect(existsSync(captureDirectory(directory, threadA, ids[2] ?? ""))).toBe(true);
    expect(await service.read(threadA, decodeBrowserCaptureId(ids[0] ?? ""))).toBeUndefined();
  });

  it("does not let one thread's captures push out another thread's", async () => {
    const { service } = open();
    const first = kept(await service.keep(request({ threadId: threadB })));
    for (let index = 0; index < MAX_BROWSER_CAPTURES_PER_THREAD + 1; index += 1) {
      kept(await service.keep(request()));
    }
    expect(service.list(threadB).map((capture) => capture.captureId)).toEqual([first]);
  });

  it("finishes removing dropped bytes on recovery and keeps the retained ones", async () => {
    const { directory, service } = open();
    const ids: string[] = [];
    for (let index = 0; index < MAX_BROWSER_CAPTURES_PER_THREAD + 1; index += 1) {
      ids.push(kept(await service.keep(request())));
    }
    // A crash between the journal append and the byte removal leaves the
    // dropped capture's file behind.
    const stale = captureDirectory(directory, threadA, ids[0] ?? "");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "finalized.bin"), PNG);
    // So does bytes staged but never finalized.
    const staged = captureDirectory(directory, threadA, ids[1] ?? "");
    writeFileSync(join(staged, "staged.bin.tmp"), PNG);

    await service.recover();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(staged, "finalized.bin"))).toBe(true);
    expect(existsSync(join(staged, "staged.bin.tmp"))).toBe(false);
    expect(service.list(threadA)).toHaveLength(MAX_BROWSER_CAPTURES_PER_THREAD);
  });

  it("removes bytes that no journaled capture owns on recovery", async () => {
    const { directory, service } = open();
    const orphan = captureDirectory(directory, threadA, randomUUID());
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "finalized.bin"), PNG);
    await service.recover();
    expect(existsSync(orphan)).toBe(false);
  });

  it("refuses bytes that are not an image whatever the data URL declared", async () => {
    const { connection, directory, service } = open();
    const outcome = await service.keep(
      request({ dataUrl: pngDataUrl(Buffer.from("<html>not a picture</html>")) }),
    );
    expect(outcome).toEqual({ status: "not-kept", reason: "not-an-image" });
    expect(journalRows(connection)).toEqual([]);
    expect(existsSync(join(directory, "browser-captures", String(threadA)))).toBe(false);
  });

  it("refuses a picture larger than the screenshot envelope", async () => {
    const { connection, service } = open();
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_BROWSER_CAPTURE_BYTES)]);
    expect(await service.keep(request({ dataUrl: pngDataUrl(oversized) }))).toEqual({
      status: "not-kept",
      reason: "too-large",
    });
    expect(journalRows(connection)).toEqual([]);
  });

  it("refuses a page with no web origin", async () => {
    const { connection, service } = open();
    expect(await service.keep(request({ url: "about:blank" }))).toEqual({
      status: "not-kept",
      reason: "no-page-origin",
    });
    expect(await service.keep(request({ url: undefined }))).toEqual({
      status: "not-kept",
      reason: "no-page-origin",
    });
    expect(journalRows(connection)).toEqual([]);
  });

  it("reports unavailable instead of throwing when the capture store cannot be written", async () => {
    const blocker = mkdtempSync(join(tmpdir(), "octant-browser-capture-blocked-"));
    directories.push(blocker);
    // A file where the store's directory should be: every write fails.
    writeFileSync(join(blocker, "browser-captures"), "not a directory");
    const { connection, service } = open(blocker);
    expect(await service.keep(request())).toEqual({ status: "not-kept", reason: "unavailable" });
    expect(journalRows(connection)).toEqual([]);
  });
});

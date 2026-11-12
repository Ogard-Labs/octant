import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEventActor,
  decodeToolActionAuthority,
  decodeProviderModelId,
  decodeWindowId,
} from "@octant/contracts";
import {
  decodeBrowserSessionGrantsCommand,
  type BrowserSessionTarget,
} from "@octant/contracts/browser-session-grants";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { BrowserSessionGrants, type CurrentBrowserSessionTarget } from "./browserSessionGrants";
import { browserSessionGrantJournal, heldBrowserSessionGrants } from "./browserSessionGrantJournal";

it("records real grant and revocation events and restores nothing a person revoked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octant-session-journal-"));
  const connection = openSqlite(join(directory, "events.sqlite3"));
  const now = () => Date.parse("2026-11-07T10:00:00.000Z");
  const clock = () => new Date(now()).toISOString();
  let service: BrowserSessionGrants | undefined;
  let restarted: BrowserSessionGrants | undefined;
  try {
    applyMigrations(connection, MIGRATIONS, clock);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock,
    });
    const actorId = "00000000-0000-4000-8000-000000000002";
    const record = browserSessionGrantJournal({
      connection,
      journal,
      now,
      uuid: randomUUID,
      personActor: decodeEventActor({ kind: "local-user", actorId }),
      hostActor: decodeEventActor({ kind: "system", actorId }),
    });
    const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
    const command = decodeBrowserSessionGrantsCommand({
      kind: "review",
      grantee: { kind: "child", runId: "20000000-0000-4000-8000-000000000001" },
      profile: { kind: "personal" },
      origins: ["https://example.com"],
      durationMinutes: 15,
    });
    if (command.kind !== "review") throw Error("Expected review");
    const target: BrowserSessionTarget = {
      grantee: command.grantee,
      label: "Read report",
      modelId: decodeProviderModelId("example-model"),
      authority: decodeToolActionAuthority({
        hostId: "30000000-0000-4000-8000-000000000001",
        mode: "work",
        projectId: "40000000-0000-4000-8000-000000000001",
        providerInstanceId: "50000000-0000-4000-8000-000000000001",
        extension: { kind: "core" },
      }),
    };
    const options = {
      now,
      uuid: randomUUID,
      isLocalWindow: () => true,
      canReview: () => true,
      targets: () => [{ target, revision: "one" }],
      current: () => ({ target, revision: "one" }),
      profileLabel: async () => "Personal",
      record,
      onRevoked: () => {},
    };
    service = new BrowserSessionGrants(options);
    const review = await service.execute(windowId, command);
    if (review.kind !== "browser-session-review") throw Error(JSON.stringify(review));
    const allowed = await service.execute(windowId, { kind: "grant", reviewId: review.reviewId });
    expect(allowed.kind).toBe("browser-session-granted");
    if (allowed.kind !== "browser-session-granted") return;
    expect(service.find(command.grantee, command.profile, command.origins)).toBe(
      allowed.grant.grantId,
    );
    expect(
      await service.execute(windowId, { kind: "revoke", grantId: allowed.grant.grantId }),
    ).toMatchObject({ kind: "browser-session-revoked" });
    const rows = connection
      .prepare(
        "SELECT event_name, actor_kind FROM event_journal WHERE aggregate_type = 'browser-session-permission' ORDER BY global_sequence",
      )
      .all();
    expect(rows).toEqual([
      { event_name: "browser.session-granted@1", actor_kind: "local-user" },
      { event_name: "browser.session-revoked@1", actor_kind: "local-user" },
    ]);
    expect(journal.inspectCompatibility()).toEqual({ compatible: true });
    restarted = new BrowserSessionGrants(options);
    expect(await restarted.execute(windowId, { kind: "list" })).toEqual({
      kind: "browser-session-grants",
      grants: [],
    });
  } finally {
    service?.close();
    restarted?.close();
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const routineWindow = decodeWindowId("10000000-0000-4000-8000-000000000001");
function reviewOf(input: Record<string, unknown>) {
  const command = decodeBrowserSessionGrantsCommand({
    kind: "review",
    grantee: { kind: "routine", routineId: "60000000-0000-4000-8000-000000000001" },
    profile: { kind: "personal" },
    origins: ["https://example.com"],
    ...input,
  });
  if (command.kind !== "review") throw Error("Expected review");
  return command;
}
const routineReview = reviewOf({});
const routineTarget: BrowserSessionTarget = {
  grantee: routineReview.grantee,
  label: "Morning report",
  modelId: decodeProviderModelId("example-model"),
  authority: decodeToolActionAuthority({
    hostId: "30000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "40000000-0000-4000-8000-000000000001",
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  }),
};
const SESSION_ROWS =
  "SELECT event_name, actor_kind FROM event_journal WHERE aggregate_type = 'browser-session-permission' ORDER BY global_sequence";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One journal on disk and as many host lifetimes over it as a test starts. */
function hostOverOneJournal() {
  const directory = mkdtempSync(join(tmpdir(), "octant-session-restart-"));
  const connection = openSqlite(join(directory, "events.sqlite3"));
  cleanups.push(() => {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = Date.parse("2026-11-07T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  applyMigrations(connection, MIGRATIONS, clock);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  const actorId = "00000000-0000-4000-8000-000000000002";
  const write = browserSessionGrantJournal({
    connection,
    journal,
    now: () => now,
    uuid: randomUUID,
    personActor: decodeEventActor({ kind: "local-user", actorId }),
    hostActor: decodeEventActor({ kind: "system", actorId }),
  });
  const state: {
    current: CurrentBrowserSessionTarget | undefined;
    local: boolean;
    journalWritable: boolean;
    journalReadable: boolean;
    profile: string | undefined;
  } = {
    current: { target: routineTarget, revision: "definition-1" },
    local: true,
    journalWritable: true,
    journalReadable: true,
    profile: "Personal",
  };
  return {
    connection,
    journal,
    state,
    advance: (ms: number) => {
      now += ms;
    },
    rows: () => connection.prepare(SESSION_ROWS).all(),
    /** A host lifetime that never calls `close()` is one that was killed. */
    start: () =>
      new BrowserSessionGrants({
        now: () => now,
        uuid: randomUUID,
        isLocalWindow: () => state.local,
        canReview: () => true,
        targets: () => (state.current === undefined ? [] : [state.current]),
        current: () => state.current,
        profileLabel: async () => state.profile,
        record: (event) => {
          if (!state.journalWritable) throw Error("disk full");
          write(event);
        },
        held: () => {
          if (!state.journalReadable) throw Error("journal unreadable");
          return heldBrowserSessionGrants(journal)();
        },
        onRevoked: () => {},
      }),
  };
}
type Host = ReturnType<typeof hostOverOneJournal>;

async function grantTo(service: BrowserSessionGrants, command = routineReview) {
  const review = await service.execute(routineWindow, command);
  if (review.kind !== "browser-session-review") throw Error(JSON.stringify(review));
  const allowed = await service.execute(routineWindow, {
    kind: "grant",
    reviewId: review.reviewId,
  });
  if (allowed.kind !== "browser-session-granted") throw Error(JSON.stringify(allowed));
  return allowed.grant;
}

async function restarted(host: Host) {
  const service = host.start();
  await service.restore();
  return service;
}

async function listed(service: BrowserSessionGrants) {
  const result = await service.execute(routineWindow, { kind: "list" });
  if (result.kind !== "browser-session-grants") throw Error(JSON.stringify(result));
  return result.grants;
}

describe("a routine's Browser grant across host restarts", () => {
  it("is restored after a clean restart with the sites, profile and expiry the person reviewed", async () => {
    const host = hostOverOneJournal();
    const first = host.start();
    const grant = await grantTo(first);
    expect(grant.survivesRestart).toBe(true);
    first.close();

    const second = await restarted(host);

    expect(second.find(routineReview.grantee, routineReview.profile, routineReview.origins)).toBe(
      grant.grantId,
    );
    expect(await listed(second)).toEqual([grant]);
    expect(host.rows()).toEqual([
      { event_name: "browser.session-granted@1", actor_kind: "local-user" },
      { event_name: "browser.session-held@1", actor_kind: "system" },
      { event_name: "browser.session-resumed@1", actor_kind: "system" },
    ]);
    expect(host.journal.inspectCompatibility()).toEqual({ compatible: true });
  });

  it("refuses a different routine, profile, site or model on a restored grant", async () => {
    const host = hostOverOneJournal();
    const first = host.start();
    const grant = await grantTo(first);
    first.close();
    const second = await restarted(host);

    const otherRoutine = reviewOf({
      grantee: { kind: "routine", routineId: "60000000-0000-4000-8000-000000000002" },
    });
    const otherProfile = reviewOf({
      profile: { kind: "project", projectId: "40000000-0000-4000-8000-000000000001" },
    });
    expect(
      second.find(otherRoutine.grantee, routineReview.profile, routineReview.origins),
    ).toBeUndefined();
    expect(
      second.find(routineReview.grantee, otherProfile.profile, routineReview.origins),
    ).toBeUndefined();
    expect(
      second.find(routineReview.grantee, routineReview.profile, ["https://other.example"]),
    ).toBeUndefined();
    expect(
      second.find(routineReview.grantee, routineReview.profile, [
        "https://example.com",
        "https://other.example",
      ]),
    ).toBeUndefined();
    expect(
      second.isCurrent(
        grant.grantId,
        { ...routineTarget, modelId: decodeProviderModelId("another-model") },
        routineReview.profile,
        routineReview.origins,
      ),
    ).toBe(false);
  });

  it("refuses a paired device that tries to create, widen, list or revoke a restored grant", async () => {
    const host = hostOverOneJournal();
    const first = host.start();
    const grant = await grantTo(first);
    first.close();
    const second = await restarted(host);
    host.state.local = false;

    for (const command of [
      reviewOf({ origins: ["https://example.com", "https://other.example"] }),
      { kind: "list" as const },
      { kind: "revoke" as const, grantId: grant.grantId },
    ])
      expect(await second.execute(routineWindow, command)).toMatchObject({ reason: "not-local" });

    host.state.local = true;
    expect(await listed(second)).toEqual([grant]);
    expect(
      second.find(routineReview.grantee, routineReview.profile, ["https://other.example"]),
    ).toBeUndefined();
  });

  it("does not confirm a revocation whose record could not be saved, and never restores that grant", async () => {
    const host = hostOverOneJournal();
    const first = host.start();
    const grant = await grantTo(first);
    host.state.journalWritable = false;

    expect(
      await first.execute(routineWindow, { kind: "revoke", grantId: grant.grantId }),
    ).toMatchObject({ kind: "browser-session-refused", reason: "record-failed" });
    expect(
      first.find(routineReview.grantee, routineReview.profile, routineReview.origins),
    ).toBeUndefined();
    host.state.journalWritable = true;
    first.close();

    expect(await listed(await restarted(host))).toEqual([]);
    expect(host.rows()).toEqual([
      { event_name: "browser.session-granted@1", actor_kind: "local-user" },
    ]);
  });

  it("confirms a revocation only after it is journaled and restores nothing afterwards", async () => {
    const host = hostOverOneJournal();
    const first = host.start();
    const grant = await grantTo(first);
    first.close();
    const second = await restarted(host);

    expect(await second.execute(routineWindow, { kind: "revoke", grantId: grant.grantId })).toEqual(
      { kind: "browser-session-revoked", grantId: grant.grantId },
    );
    expect(host.rows().at(-1)).toEqual({
      event_name: "browser.session-revoked@1",
      actor_kind: "local-user",
    });
    second.close();

    expect(await listed(await restarted(host))).toEqual([]);
  });

  it("restores nothing when the earlier host ended without a clean close", async () => {
    const killed = hostOverOneJournal();
    await grantTo(killed.start());
    expect(await listed(await restarted(killed))).toEqual([]);

    // A grant resumed once is not resumed again after a later unclean end.
    const host = hostOverOneJournal();
    const clean = host.start();
    await grantTo(clean);
    clean.close();
    expect(await listed(await restarted(host))).toHaveLength(1);
    expect(await listed(await restarted(host))).toEqual([]);
  });

  it("restores nothing from a partially written, incomplete or unreadable record", async () => {
    const truncated = hostOverOneJournal();
    const first = truncated.start();
    await grantTo(first);
    first.close();
    // The table refuses text that is not JSON, so a partial record is one
    // that parses and is missing what the grant needs.
    truncated.connection
      .prepare(
        `UPDATE event_journal SET payload_json = '{"kind":"held","grant":{}}' WHERE event_name = 'browser.session-held@1'`,
      )
      .run();
    expect(await listed(await restarted(truncated))).toEqual([]);

    const incomplete = hostOverOneJournal();
    const second = incomplete.start();
    await grantTo(second);
    second.close();
    incomplete.connection
      .prepare("DELETE FROM event_journal WHERE event_name = 'browser.session-granted@1'")
      .run();
    expect(await listed(await restarted(incomplete))).toEqual([]);

    const unreadable = hostOverOneJournal();
    const third = unreadable.start();
    await grantTo(third);
    third.close();
    unreadable.connection
      .prepare(
        "UPDATE event_journal SET event_version = 99 WHERE event_name = 'browser.session-granted@1'",
      )
      .run();
    expect(await listed(await restarted(unreadable))).toEqual([]);

    const failing = hostOverOneJournal();
    const fourth = failing.start();
    await grantTo(fourth);
    fourth.close();
    failing.state.journalReadable = false;
    expect(await listed(await restarted(failing))).toEqual([]);
  });

  it("lapses instead of restoring when the routine's definition or model changed, the routine or profile is gone, or the expiry passed", async () => {
    const changes: ReadonlyArray<(host: Host) => void> = [
      (host) => {
        host.state.current = { target: routineTarget, revision: "definition-2" };
      },
      (host) => {
        host.state.current = {
          target: { ...routineTarget, modelId: decodeProviderModelId("another-model") },
          revision: "definition-1",
        };
      },
      (host) => {
        host.state.current = undefined;
      },
      (host) => {
        host.state.profile = undefined;
      },
      (host) => host.advance(8 * 24 * 60 * 60_000),
    ];
    for (const change of changes) {
      const host = hostOverOneJournal();
      const first = host.start();
      await grantTo(first);
      first.close();
      change(host);

      const second = await restarted(host);
      expect(await listed(second)).toEqual([]);
      expect(
        second.find(routineReview.grantee, routineReview.profile, routineReview.origins),
      ).toBeUndefined();
      second.close();
      // Changing back does not revive it: the lapse is on record.
      host.state.current = { target: routineTarget, revision: "definition-1" };
      host.state.profile = "Personal";
      expect(await listed(await restarted(host))).toEqual([]);
    }
  });

  it("ends a terminal's permission with the host", async () => {
    const host = hostOverOneJournal();
    const terminal = reviewOf({
      grantee: { kind: "terminal", grantId: "70000000-0000-4000-8000-000000000001" },
      durationMinutes: 15,
    });
    host.state.current = {
      target: { ...routineTarget, grantee: terminal.grantee },
      revision: "terminal-1",
    };
    const first = host.start();
    const grant = await grantTo(first, terminal);
    expect(grant.survivesRestart).toBeUndefined();
    first.close();

    expect(await listed(await restarted(host))).toEqual([]);
    expect(host.rows().at(-1)).toEqual({
      event_name: "browser.session-revoked@1",
      actor_kind: "system",
    });
  });
});

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
import { expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { BrowserSessionGrants } from "./browserSessionGrants";
import { browserSessionGrantJournal } from "./browserSessionGrantJournal";

it("records real grant and revocation events and never restores permission from their replay", async () => {
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

import { erasePurgedProjectData } from "../persistence/threadPurge";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeEventActor, decodeWindowId, ReplayCursor } from "@octant/contracts";
import { decodeBrowserDownloadPermissionsResult } from "@octant/contracts/browser-download-permissions";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { browserDownloadPermissionJournal } from "./browserDownloadPermissionJournal";

it("records typed manifest and use metadata under local-person and host actors", () => {
  const directory = mkdtempSync(join(tmpdir(), "octant-download-journal-"));
  const connection = openSqlite(join(directory, "journal.sqlite3"));
  const clock = () => "2026-11-07T10:00:00.000Z";
  try {
    applyMigrations(connection, MIGRATIONS, clock);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock,
    });
    const actorId = "00000000-0000-4000-8000-000000000001";
    const record = browserDownloadPermissionJournal({
      connection,
      journal,
      now: () => Date.parse(clock()),
      uuid: randomUUID,
      personActor: decodeEventActor({ kind: "local-user", actorId }),
      hostActor: decodeEventActor({ kind: "system", actorId }),
    });
    const decoded = decodeBrowserDownloadPermissionsResult({
      kind: "download-permission-granted",
      permission: {
        permissionId: randomUUID(),
        target: {
          grantee: { kind: "routine", routineId: randomUUID() },
          label: "Send report",
          modelId: "test-model",
          authority: {
            hostId: randomUUID(),
            mode: "work",
            projectId: randomUUID(),
            providerInstanceId: randomUUID(),
            extension: { kind: "core" },
          },
        },
        recipientRevisionDigest: `sha256:${"a".repeat(64)}`,
        profile: { kind: "personal" },
        origin: "https://example.com",
        folder: { id: `folder_${"b".repeat(64)}`, label: "Reports", kind: "extra" },
        sourceOrigins: ["https://example.com"],
        directory: "reports",
        mediaTypes: ["text/plain"],
        maxFiles: 5,
        maxBytes: 1000,
        grantedAt: clock(),
        expiresAt: "2026-11-14T10:00:00.000Z",
      },
    });
    if (decoded.kind !== "download-permission-granted") throw Error("Missing fixture permission");
    const permission = decoded.permission;
    record({
      kind: "granted",
      permission,
      remainingFiles: 5,
      remainingBytes: 1000,
      windowId: decodeWindowId(randomUUID()),
    });
    record({
      kind: "consumed",
      permission,
      remainingFiles: 4,
      remainingBytes: 988,
    });
    record({ kind: "revoked", permission, remainingFiles: 4, remainingBytes: 988 });
    const rows = journal.replay(
      Schema.decodeUnknownSync(ReplayCursor)({ afterSequence: 0, limit: 10 }),
    );
    expect(rows.map((row) => row.actor.kind)).toEqual(["local-user", "system", "system"]);
    expect(rows.map((row) => row.payload)).toMatchObject([
      { kind: "granted" },
      { kind: "consumed" },
      { kind: "revoked" },
    ]);
    expect(journal.inspectCompatibility()).toEqual({ compatible: true });
    if (permission.target.authority.projectId === undefined) throw Error("Missing Project");
    erasePurgedProjectData({
      connection,
      projectId: String(permission.target.authority.projectId),
      canvasIds: [],
    });
    expect(
      journal.replay(Schema.decodeUnknownSync(ReplayCursor)({ afterSequence: 0, limit: 10 })),
    ).toEqual([]);
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

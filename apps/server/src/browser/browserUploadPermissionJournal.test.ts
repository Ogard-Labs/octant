import { erasePurgedProjectData } from "../persistence/threadPurge";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeEventActor, decodeWindowId, ReplayCursor } from "@octant/contracts";
import { decodeBrowserUploadPermissionsResult } from "@octant/contracts/browser-upload-permissions";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { browserUploadPermissionJournal } from "./browserUploadPermissionJournal";

it("records typed manifest and use metadata under local-person and host actors", () => {
  const directory = mkdtempSync(join(tmpdir(), "octant-upload-journal-"));
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
    const record = browserUploadPermissionJournal({
      connection,
      journal,
      now: () => Date.parse(clock()),
      uuid: randomUUID,
      personActor: decodeEventActor({ kind: "local-user", actorId }),
      hostActor: decodeEventActor({ kind: "system", actorId }),
    });
    const decoded = decodeBrowserUploadPermissionsResult({
      kind: "upload-permission-granted",
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
        files: [{ path: "report.txt", sizeBytes: 12, sha256: "c".repeat(64), fileType: ".txt" }],
        maxFiles: 5,
        maxBytes: 1000,
        grantedAt: clock(),
        expiresAt: "2026-11-14T10:00:00.000Z",
      },
    });
    if (decoded.kind !== "upload-permission-granted") throw Error("Missing fixture permission");
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
      transferredFiles: permission.files.map((file) => file.path),
    });
    record({ kind: "revoked", permission, remainingFiles: 4, remainingBytes: 988 });
    const rows = journal.replay(
      Schema.decodeUnknownSync(ReplayCursor)({ afterSequence: 0, limit: 10 }),
    );
    expect(rows.map((row) => row.actor.kind)).toEqual(["local-user", "system", "system"]);
    expect(rows.map((row) => row.payload)).toMatchObject([
      { kind: "granted" },
      { kind: "consumed", transferredFiles: ["report.txt"] },
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

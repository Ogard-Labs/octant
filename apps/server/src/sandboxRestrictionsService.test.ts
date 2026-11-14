import { mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Project, EventActor } from "@octant/contracts";
import {
  decodeSandboxPolicy,
  decodeSandboxRestrictionsCommand,
} from "@octant/contracts/sandbox-policy";
import { AggregateHeadsProjection } from "./persistence/aggregateHeadsProjection";
import { EventRegistry } from "./persistence/eventRegistry";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { ProjectionRegistry } from "./persistence/projection";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import {
  SandboxRestrictionsService,
  registerSandboxRestrictionsEvents,
} from "./sandboxRestrictionsService";
const projectId = "20000000-0000-4000-8000-000000000001";
const threadId = "10000000-0000-4000-8000-000000000001";
const now = "2026-11-14T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const directories: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "octant-restrictions-"));
  directories.push(base);
  const root = join(base, "project");
  const shared = mkdtempSync(
    join(process.platform === "linux" ? "/dev/shm" : tmpdir(), "octant-policy-folder-"),
  );
  directories.push(shared);
  mkdirSync(root);
  const project = Schema.decodeUnknownSync(Project)({
    id: projectId,
    type: "work",
    name: "Project",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: root },
    bindingHistory: [
      {
        revisionId: "30000000-0000-4000-8000-000000000001",
        revision: 1,
        currentBinding: { canonicalRoot: root },
        actor,
        changedAt: now,
      },
    ],
  });
  const connection = openSqlite(join(base, "journal.sqlite3"));
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  const journal = new Journal({
    connection,
    registry: registerSandboxRestrictionsEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const create = () =>
    new SandboxRestrictionsService({
      journal,
      hostId: "host",
      dataDirectory: base,
      actor,
      project: () => project,
      thread: () => ({ projectId, mode: "work" }),
      platform: process.platform,
    });
  const service = create();
  const policy = decodeSandboxPolicy({
    schemaVersion: 1,
    revision: 0,
    filesystem: { readOnlyRoots: [shared], readWriteRoots: [], protectedPaths: [] },
    network: "existing-policy",
    credentials: "existing-policy",
    hostServices: "blocked",
  });
  const settings = { kind: "settings", mode: "work" } as const;
  const save = (value: unknown) => service.change(decodeSandboxRestrictionsCommand(value));
  const start = () =>
    service.beginTurn({ threadId, projectId, mode: "work", root, provider: "codex" });
  return { base, root, shared, project, service, create, policy, settings, save, start };
}
describe.skipIf(process.platform !== "linux")("trusted sandbox restrictions", () => {
  it("replays trusted policies without migrating or changing legacy defaults", () => {
    const f = fixture();
    expect(f.service.snapshot(f.settings).source).toBe("legacy");
    expect(
      f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 }).kind,
    ).toBe("sandbox-restrictions");
    expect(f.create().snapshot(f.settings)).toMatchObject({
      source: "settings",
      version: 1,
      policy: { revision: 1 },
    });
    expect(f.save({ kind: "inherit-policy", scope: f.settings, expectedVersion: 0 })).toMatchObject(
      { reason: "stale-version" },
    );
  });
  it("keeps running turns immutable and expires session exceptions on restart", () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    const admitted = f.start();
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error(admitted.message);
    f.save({
      kind: "set-policy",
      scope: { kind: "session", threadId },
      policy: { ...f.policy, network: "deny" },
      expectedVersion: 1,
    });
    expect(f.service.active(threadId)?.policy.network).toBe("existing-policy");
    expect(f.start()).toMatchObject({ status: "refused" });
    admitted.turn.end();
    const next = f.start();
    expect(next.status === "admitted" && next.turn.selection?.policy.network).toBe("deny");
    if (next.status === "admitted") next.turn.end();
    expect(f.create().snapshot({ kind: "session", threadId }).source).toBe("settings");
  });
  it("refuses an allowed folder that has been replaced instead of transferring its authority", () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    directories.push(`${f.shared}-old`);
    renameSync(f.shared, `${f.shared}-old`);
    mkdirSync(f.shared);
    expect(f.start()).toMatchObject({ status: "refused" });
  });
  it("groups denials and grants the exact read-only folder only through trusted commands", () => {
    const f = fixture();
    f.save({
      kind: "set-policy",
      scope: f.settings,
      policy: { ...f.policy, filesystem: { ...f.policy.filesystem, readOnlyRoots: [] } },
      expectedVersion: 0,
    });
    const denial = {
      threadId,
      projectId: f.project.id,
      code: "sandbox-read-denied",
      ruleId: "filesystem.allowedFolders",
      operation: "read",
      resource: f.shared,
      message: "Read blocked",
      remedy: "Review this exact folder.",
      grantable: true,
    } as const;
    f.service.deny(denial);
    f.service.deny(denial);
    const blocked = f.service.snapshot({ kind: "session", threadId }).denials[0];
    expect(blocked?.count).toBe(2);
    if (blocked === undefined) throw new Error("Missing denial");
    const granted = f.save({
      kind: "grant-denial",
      denialId: blocked.id,
      duration: "session",
      expectedVersion: 1,
    });
    expect(granted).toMatchObject({
      source: "session",
      policy: { filesystem: { readOnlyRoots: [f.shared] } },
    });
    expect(
      f.create().snapshot({ kind: "session", threadId }).policy?.filesystem.readOnlyRoots,
    ).toEqual([]);
  });
  it("revokes a running turn before cleanup and prevents replacement admission until owned resources stop", async () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    const admitted = f.start();
    if (admitted.status !== "admitted" || admitted.turn.selection === undefined)
      throw new Error("Admission failed");
    let stopped = () => {};
    const stoppedPromise = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    f.service.registerCleanup(admitted.turn.selection.context.sessionId, () => stoppedPromise);
    const ending = admitted.turn.end();
    expect(admitted.turn.current()).toBe(false);
    expect(f.service.active(threadId)).toBeUndefined();
    expect(f.start()).toMatchObject({ status: "refused" });
    expect(() =>
      f.service.registerCleanup(
        admitted.turn.selection?.context.sessionId ?? "",
        async () => undefined,
      ),
    ).toThrow();
    stopped();
    await ending;
    expect(f.start().status).toBe("admitted");
  });
  it("intersects helper grants and refuses a helper workspace outside its parent's writable boundary", () => {
    const f = fixture();
    f.save({
      kind: "set-policy",
      scope: f.settings,
      policy: { ...f.policy, network: "deny" },
      expectedVersion: 0,
    });
    const parent = f.start();
    if (parent.status !== "admitted") throw new Error(parent.message);
    f.save({
      kind: "set-policy",
      scope: { kind: "project", projectId },
      policy: {
        ...f.policy,
        network: "unrestricted",
        filesystem: { ...f.policy.filesystem, readWriteRoots: [f.base] },
      },
      expectedVersion: 1,
    });
    const helperId = "10000000-0000-4000-8000-000000000002";
    const helper = f.service.beginTurn({
      threadId: helperId,
      parentThreadId: threadId,
      projectId,
      mode: "work",
      root: f.root,
      provider: "codex",
    });
    expect(helper.status).toBe("admitted");
    if (helper.status === "admitted") {
      expect(helper.turn.selection?.policy.network).toBe("deny");
      expect(helper.turn.selection?.policy.filesystem.readWriteRoots).toEqual([]);
      helper.turn.end();
    }
    expect(
      f.service.beginTurn({
        threadId: helperId,
        parentThreadId: threadId,
        projectId,
        mode: "work",
        root: f.base,
        provider: "codex",
      }),
    ).toMatchObject({ status: "refused" });
  });
  it("remembers only the requested exception without copying unrelated session overrides into the Project", () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    f.save({
      kind: "set-policy",
      scope: { kind: "session", threadId },
      policy: { ...f.policy, network: "unrestricted" },
      expectedVersion: 1,
    });
    f.service.deny({
      threadId,
      projectId: f.project.id,
      code: "sandbox-network-denied",
      ruleId: "network.destinations",
      operation: "network",
      resource: "packages.example.com:443",
      destination: { host: "packages.example.com", port: 443 },
      message: "Destination blocked",
      remedy: "Review the exact destination.",
      grantable: true,
    });
    const denial = f.service.snapshot({ kind: "session", threadId }).denials[0];
    if (denial === undefined) throw new Error("Missing denial");
    const result = f.save({
      kind: "grant-denial",
      denialId: denial.id,
      duration: "project",
      expectedVersion: 2,
    });
    expect(result).toMatchObject({
      source: "project",
      policy: {
        network: "existing-policy",
        approvedDestinations: [{ host: "packages.example.com", port: 443 }],
      },
    });
    expect(
      f.create().snapshot({ kind: "project", projectId: f.project.id }).policy
        ?.approvedDestinations,
    ).toEqual([{ host: "packages.example.com", port: 443 }]);
  });
  it("freezes admitted grants and refuses a folder replaced during a running turn", async () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    const admitted = f.start();
    if (admitted.status !== "admitted" || admitted.turn.selection === undefined)
      throw new Error("Admission failed");
    expect(Object.isFrozen(admitted.turn.selection.policy.filesystem.readOnlyRoots)).toBe(true);
    const old = `${f.shared}-replaced`;
    directories.push(old);
    renameSync(f.shared, old);
    mkdirSync(f.shared);
    expect(() => f.service.active(threadId)).toThrow(/changed identity/);
    await admitted.turn.end();
    expect(f.start()).toMatchObject({ status: "refused" });
  });
  it("refuses a folder grant over the host's private enforcement artifacts", () => {
    const f = fixture();
    const filters = join(f.base, "sandbox-filters");
    mkdirSync(filters);
    f.save({
      kind: "set-policy",
      scope: f.settings,
      policy: { ...f.policy, filesystem: { ...f.policy.filesystem, readWriteRoots: [filters] } },
      expectedVersion: 0,
    });
    expect(f.start()).toMatchObject({
      status: "refused",
      message: expect.stringContaining("private policy store"),
    });
  });
});

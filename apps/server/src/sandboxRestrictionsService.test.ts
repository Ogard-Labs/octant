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
function fixture(strict = true, accessTimeMediationAvailable = false) {
  let legacy = false;
  let strictEnabled = strict;
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
      accessTimeMediationAvailable: () => accessTimeMediationAvailable,
      strictPreferences: () =>
        legacy
          ? { executionPolicy: "full-access", thread: { fullAccessSandbox: true } }
          : { executionPolicy: "approval-gated", thread: { strict: strictEnabled } },
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
  const start = (provider = "codex") =>
    service.beginTurn({ threadId, projectId, mode: "work", root, provider });
  return {
    base,
    root,
    shared,
    project,
    service,
    create,
    policy,
    settings,
    save,
    start,
    setLegacy: (value: boolean) => {
      legacy = value;
    },
    setStrict: (value: boolean) => {
      strictEnabled = value;
    },
  };
}
describe.skipIf(process.platform !== "linux")("trusted sandbox restrictions", () => {
  it("does not label a Project's mixed running policies as one newly active setting", async () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    const first = f.start();
    if (first.status !== "admitted") throw new Error("Missing first turn");
    f.setStrict(false);
    const second = f.service.beginTurn({
      threadId: "10000000-0000-4000-8000-000000000002",
      projectId,
      mode: "work",
      root: f.root,
      provider: "codex",
    });
    if (second.status !== "admitted") throw new Error("Missing second turn");
    const view = f.service.snapshot({ kind: "project", projectId: f.project.id });
    expect(view).toMatchObject({
      running: true,
      pending: true,
      summary: expect.stringContaining("different admitted policies"),
    });
    expect(view.activeStrict).toBeUndefined();
    expect(view.activePolicy).toBeUndefined();
    await first.turn.end();
    await second.turn.end();
  });
  it("shows the admitted policy and pending change at Project and Settings scopes while a turn still runs", async () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    const active = f.start();
    if (active.status !== "admitted") throw new Error("Missing active turn");
    f.save({
      kind: "set-policy",
      scope: f.settings,
      policy: { ...f.policy, network: "deny" },
      expectedVersion: 1,
    });
    for (const scope of [f.settings, { kind: "project" as const, projectId: f.project.id }])
      expect(f.service.snapshot(scope)).toMatchObject({
        running: true,
        pending: true,
        activeStrict: true,
        policy: { network: "deny" },
        activePolicy: { network: "existing-policy" },
      });
    await active.turn.end();
    expect(f.service.snapshot(f.settings)).toMatchObject({ running: false, pending: false });
  });
  it("admits a personal terminal from its Project policy without pretending that it is a provider session", async () => {
    const f = fixture();
    f.save({
      kind: "set-policy",
      scope: { kind: "project", projectId: f.project.id },
      policy: { ...f.policy, network: "deny" },
      expectedVersion: 0,
    });
    const terminal = f.service.beginTurn({
      executionRoute: "terminal",
      threadId: "30000000-0000-4000-8000-000000000099",
      projectId,
      mode: "work",
      root: f.root,
      provider: "terminal",
    });
    expect(terminal.status).toBe("admitted");
    if (terminal.status !== "admitted") return;
    expect(terminal.turn.selection?.policy.network).toBe("deny");
    expect(terminal.turn.selection?.context.provider).toBe("terminal");
    await terminal.turn.end();
  });
  it("keeps command consent bound to the admitted policy while a requested change is pending", async () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    const before = f.service.commandState(threadId);
    const active = f.start();
    if (active.status !== "admitted") throw new Error("Missing admitted turn");
    expect(f.service.commandState(threadId)).toEqual(before);
    const borrowed = f.service.currentTurn(threadId);
    expect(borrowed?.selection).toBe(active.turn.selection);
    await borrowed?.end();
    expect(active.turn.current()).toBe(true);
    f.save({
      kind: "set-policy",
      scope: f.settings,
      policy: { ...f.policy, network: "deny" },
      expectedVersion: 1,
    });
    expect(f.service.commandState(threadId)).toEqual(before);
    await active.turn.end();
    expect(borrowed?.current()).toBe(false);
    expect(f.service.commandState(threadId)).not.toEqual(before);
  });
  it("keeps a local-service grant pending for an active turn and persists only the requested Project endpoint", async () => {
    const f = fixture();
    f.save({ kind: "set-policy", scope: f.settings, policy: f.policy, expectedVersion: 0 });
    const active = f.start();
    if (active.status !== "admitted") throw new Error("Missing admitted turn");
    f.service.deny({
      threadId,
      projectId: f.project.id,
      code: "sandbox-network-denied",
      ruleId: "network.destinations",
      operation: "network",
      resource: "127.0.0.1:5173",
      localService: { host: "127.0.0.1", port: 5173 },
      message: "Local service blocked",
      remedy: "Review the service's effects.",
      grantable: true,
    });
    const denial = f.service.snapshot({ kind: "session", threadId }).denials[0];
    if (denial === undefined) throw new Error("Missing service denial");
    expect(
      f.save({
        kind: "grant-denial",
        denialId: denial.id,
        duration: "project",
        expectedVersion: 1,
      }),
    ).toMatchObject({
      policy: { hostServices: "blocked", localServices: [{ host: "127.0.0.1", port: 5173 }] },
    });
    expect(active.turn.selection?.policy.localServices).toBeUndefined();
    expect(f.service.snapshot({ kind: "session", threadId })).toMatchObject({ pending: true });
    await active.turn.end();
    const next = f.start();
    if (next.status !== "admitted") throw new Error("Missing next turn");
    expect(next.turn.selection?.policy.localServices).toEqual([{ host: "127.0.0.1", port: 5173 }]);
    expect(Object.isFrozen(next.turn.selection?.policy.localServices)).toBe(true);
    expect(Object.isFrozen(next.turn.selection?.policy.localServices?.[0])).toBe(true);
    await next.turn.end();
    expect(
      f.create().snapshot({ kind: "project", projectId: f.project.id }).policy?.localServices,
    ).toEqual([{ host: "127.0.0.1", port: 5173 }]);
  });
  it("keeps a saved policy inactive outside Strict and shows a change pending until the active turn ends", async () => {
    const f = fixture(false);
    const saved = f.save({
      kind: "set-policy",
      expectedVersion: 0,
      scope: f.settings,
      policy: f.policy,
    });
    expect(saved).toMatchObject({ strict: false, policy: { network: f.policy.network } });
    const open = f.start();
    if (open.status !== "admitted") throw new Error(open.message);
    expect(open.turn.strict).toBe(false);
    expect(open.turn.selection).toBeUndefined();
    await open.turn.end();
    f.setStrict(true);
    const protectedTurn = f.start();
    if (protectedTurn.status !== "admitted") throw new Error(protectedTurn.message);
    expect(protectedTurn.turn.selection).toBeDefined();
    f.setStrict(false);
    expect(f.service.snapshot({ kind: "session", threadId })).toMatchObject({
      strict: false,
      activeStrict: true,
      pending: true,
    });
    expect(f.service.active(threadId)).toBe(protectedTurn.turn.selection);
    await protectedTurn.turn.end();
    const resumed = f.start();
    if (resumed.status !== "admitted") throw new Error(resumed.message);
    expect(resumed.turn.selection).toBeUndefined();
    expect(f.service.snapshot(f.settings).policy).toBeDefined();
    await resumed.turn.end();
  });
  it("does not silently activate newly saved Strict configuration through a retained Full-access-only sandbox", async () => {
    const f = fixture(false);
    f.setLegacy(true);
    f.save({ kind: "set-policy", expectedVersion: 0, scope: f.settings, policy: f.policy });
    const previous = f.start();
    if (previous.status !== "admitted") throw new Error(previous.message);
    expect(previous.turn).toMatchObject({ strict: true, legacy: true });
    expect(previous.turn.selection).toBeUndefined();
    expect(f.service.snapshot({ kind: "session", threadId }).activePolicy).toBeUndefined();
    expect(f.service.snapshot({ kind: "session", threadId }).pending).toBe(false);
    await previous.turn.end();
    f.setLegacy(false);
    f.setStrict(true);
    const current = f.start();
    if (current.status !== "admitted") throw new Error(current.message);
    expect(current.turn.legacy).toBe(false);
    expect(current.turn.selection?.policy.network).toBe(f.policy.network);
    await current.turn.end();
  });

  it("admits default Strict through the same immutable backend policy without requiring a custom save", async () => {
    const f = fixture();
    const first = f.start();
    if (first.status !== "admitted") throw new Error(first.message);
    expect(first.turn).toMatchObject({
      strict: true,
      legacy: false,
      selection: { policy: { revision: 0, network: "existing-policy" } },
    });
    expect(f.service.snapshot({ kind: "session", threadId })).toMatchObject({
      activeStrict: true,
      pending: false,
    });
    await first.turn.end();
    f.setStrict(false);
    const next = f.start();
    if (next.status !== "admitted") throw new Error(next.message);
    expect(next.turn.selection).toBeUndefined();
    await next.turn.end();
  });

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
  it("grants a folder exception against the default Strict policy when no policy was saved", async () => {
    const f = fixture();
    f.service.deny({
      threadId,
      projectId: f.project.id,
      code: "sandbox-read-denied",
      ruleId: "filesystem.allowedFolders",
      operation: "read",
      resource: f.shared,
      message: "Read blocked",
      remedy: "Review this exact folder.",
      grantable: true,
    });
    const blocked = f.service.snapshot({ kind: "session", threadId }).denials[0];
    if (blocked === undefined) throw new Error("Missing denial");
    const granted = f.save({
      kind: "grant-denial",
      denialId: blocked.id,
      duration: "session",
      expectedVersion: 0,
    });
    expect(granted).toMatchObject({
      source: "session",
      policy: { filesystem: { readOnlyRoots: [f.shared] } },
    });
    const next = f.start();
    if (next.status !== "admitted") throw new Error(next.message);
    expect(next.turn.selection?.policy.filesystem.readOnlyRoots).toEqual([f.shared]);
    await next.turn.end();
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
    for (const [index, name] of ["sandbox-filters", "linux-mediation-runtime"].entries()) {
      const privateRuntime = join(f.base, name);
      mkdirSync(privateRuntime);
      f.save({
        kind: "set-policy",
        scope: f.settings,
        policy: {
          ...f.policy,
          filesystem: { ...f.policy.filesystem, readWriteRoots: [privateRuntime] },
        },
        expectedVersion: index,
      });
      expect(f.start()).toMatchObject({
        status: "refused",
        message: expect.stringContaining("private policy store"),
      });
    }
  });
  it("admits same-filesystem read-only folders when access-time mediation is available", () => {
    const f = fixture(true, true);
    const sameFilesystem = join(f.base, "same-filesystem-read-only");
    mkdirSync(sameFilesystem);
    f.save({
      kind: "set-policy",
      scope: f.settings,
      policy: {
        ...f.policy,
        filesystem: { ...f.policy.filesystem, readOnlyRoots: [sameFilesystem] },
      },
      expectedVersion: 0,
    });
    expect(f.start()).toMatchObject({ status: "admitted" });
  });
  it("refuses object-mediated rules for native-harness file tools", () => {
    const sameFilesystem = (rule: "read-only" | "protected") => {
      const f = fixture(true, true);
      const guarded = join(f.base, rule);
      mkdirSync(guarded);
      f.save({
        kind: "set-policy",
        scope: f.settings,
        policy: {
          ...f.policy,
          filesystem: {
            ...f.policy.filesystem,
            readOnlyRoots: rule === "read-only" ? [guarded] : [],
            protectedPaths: rule === "protected" ? [{ path: guarded, mode: "deny" }] : [],
          },
        },
        expectedVersion: 0,
      });
      return f.start("openai-compatible");
    };
    expect(sameFilesystem("read-only")).toMatchObject({
      status: "refused",
      message: expect.stringContaining("hard-link aliases"),
    });
    expect(sameFilesystem("protected")).toMatchObject({
      status: "refused",
      message: expect.stringContaining("filesystem.protectedPaths"),
    });
  });
});

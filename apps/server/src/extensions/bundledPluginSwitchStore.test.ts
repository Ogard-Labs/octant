import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommand, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isFirstPartyIntegrationEffective,
  isGithubIntegrationEffective,
} from "../github/githubIntegrationEffective";
import { BundledPluginSwitchProjection } from "../persistence/bundledPluginSwitchProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { BundledPluginSwitchStore } from "./bundledPluginSwitchStore";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";
import { ExtensionApiService, UNAVAILABLE_EXTENSION_PACKAGE_RESOLVER } from "./extensionApiService";
import type { ExtensionLifecycleService } from "./extensionLifecycleService";

const actorId = "70000000-0000-4000-8000-000000000001";
const githubId = "10000000-0000-4000-8000-0000000000c1";
const githubPackageId = "20000000-0000-4000-8000-0000000000c1";
const boardId = "10000000-0000-4000-8000-0000000000b1";
const zenId = "10000000-0000-4000-8000-000000000051";
const now = "2026-11-07T12:00:00.000Z";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const emptySnapshot: ExtensionSnapshot = {
  sequence: 0 as never,
  snapshotAt: now as never,
  packages: [],
  collisions: [],
};

function host(installed: ExtensionSnapshot = emptySnapshot) {
  const directory = mkdtempSync(join(tmpdir(), "octant-bundled-plugins-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => now,
  });
  let counter = 0;
  const switches = new BundledPluginSwitchStore({
    journal,
    connection,
    uuid: () => `73000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    clock: () => now,
    actor: { kind: "local-user", actorId } as never,
  });
  const lifecycleCalls = vi.fn(async () => installed);
  const lifecycle = new Proxy(
    { snapshot: () => installed },
    {
      get: (target, property) =>
        property === "snapshot" ? target.snapshot : (lifecycleCalls as unknown),
    },
  ) as unknown as ExtensionLifecycleService;
  const onStateChanged = vi.fn();
  const api = new ExtensionApiService({
    lifecycle,
    resolver: UNAVAILABLE_EXTENSION_PACKAGE_RESOLVER,
    bundledPlugins: switches,
    activation: new ExtensionActivationService({
      policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
      catalogStatus: () => "available",
    }),
    onStateChanged,
  });
  const journalCount = () =>
    (connection.prepare("SELECT count(*) AS n FROM event_journal").get() as { n: number }).n;
  return { api, connection, journal, journalCount, lifecycleCalls, onStateChanged };
}

function row(snapshot: ExtensionSnapshot, extensionId: string) {
  return snapshot.packages.find((candidate) => String(candidate.extensionId) === extensionId);
}

function switchGithub(desired: boolean, expectedStateVersion: number): ExtensionCommand {
  return {
    kind: "set-plugin-desired",
    commandVersion: 1,
    extensionId: githubId,
    expectedStateVersion,
    desired,
  } as never;
}

describe("switches of the plugins built into Octant", () => {
  it("lists GitHub, the board, and Zen as installed, trusted, and on before anyone switches them", () => {
    const { api } = host();
    const snapshot = api.snapshot();
    for (const id of [githubId, boardId, zenId]) {
      const state = row(snapshot, id);
      expect(state?.source.kind).toBe("bundled");
      expect(state?.stateVersion).toBe(0);
      expect(state?.activation).toMatchObject({
        installed: true,
        trusted: true,
        pluginDesired: true,
      });
      expect(state?.components.every((c) => c.effectiveState.kind === "effective")).toBe(true);
    }
    expect(isGithubIntegrationEffective(snapshot)).toBe(true);
    expect(isFirstPartyIntegrationEffective(snapshot, "board", { missingRow: "effective" })).toBe(
      true,
    );
    expect(isFirstPartyIntegrationEffective(snapshot, "zen", { missingRow: "effective" })).toBe(
      true,
    );
  });

  it("turns GitHub off and on again through the extension API, and the integration follows", async () => {
    const { api } = host();
    const off = await api.execute(switchGithub(false, 0));
    expect(off.kind).toBe("extension-state-updated");
    const afterOff = api.snapshot();
    expect(row(afterOff, githubId)?.activation.pluginDesired).toBe(false);
    expect(row(afterOff, githubId)?.stateVersion).toBe(1);
    expect(row(afterOff, githubId)?.components[0]?.effectiveState).toEqual({
      kind: "blocked",
      reason: "plugin-disabled",
    });
    expect(isGithubIntegrationEffective(afterOff)).toBe(false);
    // The board has its own switch and stays on.
    expect(isFirstPartyIntegrationEffective(afterOff, "board", { missingRow: "effective" })).toBe(
      true,
    );

    expect((await api.execute(switchGithub(true, 1))).kind).toBe("extension-state-updated");
    expect(isGithubIntegrationEffective(api.snapshot())).toBe(true);
    expect(row(api.snapshot(), githubId)?.stateVersion).toBe(2);
  });

  it("refuses a switch made against a version the person did not see, and records nothing", async () => {
    const { api, journalCount } = host();
    await api.execute(switchGithub(false, 0));
    const before = journalCount();
    const stale = await api.execute(switchGithub(true, 0));
    expect(stale).toEqual({
      kind: "extension-command-failed",
      failure: { category: "stale", message: "Extension lifecycle state changed; retry." },
    });
    expect(journalCount()).toBe(before);
    expect(isGithubIntegrationEffective(api.snapshot())).toBe(false);
  });

  it("records nothing for a switch already in the asked position", async () => {
    const { api, journalCount } = host();
    const before = journalCount();
    expect((await api.execute(switchGithub(true, 0))).kind).toBe("extension-state-updated");
    expect(journalCount()).toBe(before);
  });

  it("refuses every other package command on a built-in plugin before it reaches the installed-package lifecycle", async () => {
    const { api, lifecycleCalls, onStateChanged } = host();
    const target = {
      extensionId: githubId,
      packageId: githubPackageId,
      version: "1.0.0",
      digest: `sha256:${"c".repeat(64)}`,
    };
    const mutation = { commandVersion: 1, extensionId: githubId, expectedStateVersion: 0 };
    const commands = [
      { kind: "install-package", ...target },
      { kind: "update-package", ...target },
      { kind: "rollback-package", ...target },
      { kind: "uninstall-package", extensionId: githubId, packageId: githubPackageId },
      { kind: "set-source-trust", ...mutation, trusted: false },
      { kind: "forget-publisher", ...mutation, publisherKey: `ed25519:${"a".repeat(64)}` },
      {
        kind: "set-component-desired",
        ...mutation,
        componentId: "github-integration",
        desired: false,
      },
      { kind: "check-npm-update", extensionId: githubId },
      { kind: "resolve-npm-package", packageName: "github", updateOf: githubId },
    ] as unknown as ReadonlyArray<ExtensionCommand>;
    for (const command of commands) {
      expect(await api.execute(command)).toEqual({
        kind: "extension-command-failed",
        failure: {
          category: "invalid",
          message: "A plugin built into Octant can only be switched on or off.",
        },
      });
    }
    expect(lifecycleCalls).not.toHaveBeenCalled();
    expect(onStateChanged).not.toHaveBeenCalled();
    expect(isGithubIntegrationEffective(api.snapshot())).toBe(true);
  });

  it("keeps the host's own row when an installed package claims a built-in plugin's id", () => {
    const claimed = host().api.snapshot();
    const impostor = row(claimed, githubId);
    if (impostor === undefined) throw new Error("GitHub row is missing.");
    const { api } = host({
      ...emptySnapshot,
      packages: [
        {
          ...impostor,
          source: { kind: "catalog", catalogId: "octant", entryId: "github" },
          activation: { ...impostor.activation, trusted: false },
        } as never,
      ],
    });
    const rows = api.snapshot().packages.filter((pkg) => String(pkg.extensionId) === githubId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toEqual({ kind: "bundled", sourceRef: "app:github" });
  });

  it("leaves built-in plugins out of a scope's effective state, so they are never addressed or selected", async () => {
    const { api } = host();
    const scope = {
      hostId: "local",
      mode: "code",
      projectId: null,
      threadId: null,
      providerFamily: "codex",
    } as const;
    const query = { kind: "query-effective-state", commandVersion: 1, scope } as never;
    const before = await api.execute(query);
    if (before.kind !== "extension-effective-state") throw new Error("No effective state.");
    expect(before.snapshot.packages).toEqual([]);
    await api.execute(switchGithub(false, 0));
    const after = await api.execute(query);
    if (after.kind !== "extension-effective-state") throw new Error("No effective state.");
    expect(after.snapshot.packages).toEqual([]);
    expect(after.snapshot.catalogEpoch).toBe(before.snapshot.catalogEpoch);
  });

  it("rebuilds the same switches from the journal, and ignores an event it already applied", async () => {
    const { api, connection, journal } = host();
    await api.execute(switchGithub(false, 0));
    await api.execute(switchGithub(true, 1));
    await api.execute(switchGithub(false, 2));
    const [first] = journal.replayAggregate({
      aggregateType: "extension-bundled-plugin-switch",
      aggregateId: githubId,
      afterVersion: 0,
      limit: 10,
    });
    if (first === undefined) throw new Error("No switch event was journaled.");
    // Replaying the first switch (on → off at version 1) again changes nothing.
    new BundledPluginSwitchProjection().apply(connection, first);
    expect(row(api.snapshot(), githubId)?.stateVersion).toBe(3);
    rebuildProjection({
      connection,
      journal,
      projection: new BundledPluginSwitchProjection(),
      clock: () => now,
    });
    const rebuilt = row(api.snapshot(), githubId);
    expect(rebuilt?.activation.pluginDesired).toBe(false);
    expect(rebuilt?.stateVersion).toBe(3);
  });
});

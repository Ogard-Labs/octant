import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ShellSettingsReplaced, type SkillFolderSettings } from "@octant/contracts";
import { defaultShellSettings } from "@octant/domain";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import {
  readShellSettings,
  SHELL_SETTINGS_AGGREGATE_ID,
  ShellProjection,
} from "../persistence/shellProjection";
import { openSqlite } from "../persistence/sqlitePort";
import { SkillDiscoveryService } from "./skillDiscoveryService";
import { extraSkillRootsFromSettings } from "./skillFolderRoots";
import { observeSkillFolderSettings } from "./skillFolderSettingsReconciliation";

it("reconciles real committed setting changes while Extensions Settings is never mounted", async () => {
  const root = await mkdtemp(join(tmpdir(), "octant-skill-settings-journal-"));
  const connection = openSqlite(join(root, "journal.sqlite"));
  const clock = () => "2026-11-02T12:00:00.000Z";
  applyMigrations(connection, MIGRATIONS, clock);
  const journal = new Journal({
    connection,
    clock,
    registry: new EventRegistry().register("shell.settings-replaced", 1, ShellSettingsReplaced),
    projections: new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(new ShellProjection()),
  });
  const read = () => readShellSettings(connection)?.settings ?? defaultShellSettings();
  const global = join(root, "global");
  const first = join(root, "first");
  const second = join(root, "second");
  for (const [folder, name] of [
    [first, "first-skill"],
    [second, "second-skill"],
  ] as const) {
    await mkdir(join(folder, name), { recursive: true });
    await writeFile(join(folder, name, "SKILL.md"), `# ${name}\n`);
  }
  const replace = (folders: SkillFolderSettings["folders"]) =>
    journal.append({
      aggregate: { aggregateType: "shell-settings", aggregateId: SHELL_SETTINGS_AGGREGATE_ID },
      expectedVersion: readShellSettings(connection)?.aggregateVersion ?? 0,
      events: [
        {
          eventId: randomUUID(),
          eventName: "shell.settings-replaced",
          eventVersion: 1,
          correlationId: randomUUID(),
          actor: { kind: "local-user", actorId: randomUUID() },
          occurredAt: clock(),
          payload: { settings: { ...read(), skillFolders: { providers: [], folders } } },
        },
      ],
    });
  replace([first]);
  const discovery = new SkillDiscoveryService({
    roots: {
      resolve: async () => [
        {
          workingDirectory: root,
          projectRoot: root,
          projectRef: "fixture",
          userGlobalSkillsRoot: global,
          extraSkillRoots: extraSkillRootsFromSettings(read().skillFolders, {
            home: root,
            userGlobalSkillsRoot: global,
            env: {},
          }),
        },
      ],
    },
  });
  const reconcile = async () => {
    await discovery.reconcile();
    await discovery.startWatching();
  };
  await reconcile();
  const stop = observeSkillFolderSettings({ journal, read: () => read().skillFolders, reconcile });
  try {
    expect(discovery.snapshot().skills.map((skill) => skill.skill.name)).toEqual(["first-skill"]);
    replace([second]);
    await vi.waitFor(
      () =>
        expect(discovery.snapshot().skills.map((skill) => skill.skill.name)).toEqual([
          "second-skill",
        ]),
      { timeout: 1200, interval: 25 },
    );
    replace([]);
    await vi.waitFor(() => expect(discovery.snapshot().skills).toHaveLength(0), {
      timeout: 1200,
      interval: 25,
    });
  } finally {
    stop();
    discovery.close();
    connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

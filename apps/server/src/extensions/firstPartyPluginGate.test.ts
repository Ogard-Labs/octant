import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  EXTENSION_AGGREGATE_TYPE,
  EXTENSION_LIFECYCLE_EVENT,
  readExtensionRecord,
} from "../persistence/extensionProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";
import {
  BOARD_EXTENSION_ID,
  boardPluginManifest,
  seedFirstPartyPluginIfAbsent,
} from "./firstPartyPlugins";
import { isFirstPartyPluginEffective } from "./firstPartyPluginGate";

const directories: Array<string> = [];
const now = "2026-08-16T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-first-party-plugin-gate-"));
  directories.push(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  seedFirstPartyPluginIfAbsent({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
    manifest: boardPluginManifest(),
  });
  const activationService = new ExtensionActivationService({
    policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
    catalogStatus: () => "available",
  });
  return { connection, journal, activationService };
}

describe("isFirstPartyPluginEffective", () => {
  it("is effective for the board component in Code mode once seeded", async () => {
    const { connection, activationService } = await setup();
    expect(
      isFirstPartyPluginEffective({
        connection,
        activationService,
        clock: () => now,
        extensionId: BOARD_EXTENSION_ID,
        componentId: "board",
        mode: "code",
      }),
    ).toBe(true);
  });

  it("is blocked outside Code mode: the board manifest only declares Code compatibility", async () => {
    const { connection, activationService } = await setup();
    expect(
      isFirstPartyPluginEffective({
        connection,
        activationService,
        clock: () => now,
        extensionId: BOARD_EXTENSION_ID,
        componentId: "board",
        mode: "work",
      }),
    ).toBe(false);
  });

  it("is blocked once the component is disabled through the existing generic toggle", async () => {
    const { connection, journal, activationService } = await setup();
    const record = readExtensionRecord(connection, BOARD_EXTENSION_ID);
    journal.append({
      aggregate: { aggregateType: EXTENSION_AGGREGATE_TYPE, aggregateId: BOARD_EXTENSION_ID },
      expectedVersion: record?.aggregateVersion ?? 0,
      events: [
        {
          eventId: randomUUID(),
          eventName: EXTENSION_LIFECYCLE_EVENT,
          eventVersion: 1,
          correlationId: randomUUID(),
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: now,
          payload: {
            eventVersion: 1,
            extensionId: BOARD_EXTENSION_ID,
            payload: {
              kind: "component-desired-state-changed",
              componentId: "board",
              desired: false,
            },
          },
        },
      ],
    });

    expect(
      isFirstPartyPluginEffective({
        connection,
        activationService,
        clock: () => now,
        extensionId: BOARD_EXTENSION_ID,
        componentId: "board",
        mode: "code",
      }),
    ).toBe(false);
  });
});

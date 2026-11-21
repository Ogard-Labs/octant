import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeEventActor, decodeProviderInstanceId } from "@octant/contracts";
import { decodeProviderCloudJob } from "@octant/contracts/provider-cloud-sessions";
import { openSqlite } from "../persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { Journal } from "../persistence/journal";
import { ThreadRetentionService } from "../threadRetentionService";
import { rebuildProjection } from "../persistence/projection";
import { decodeThreadRetentionThreadId } from "@octant/contracts/thread-retention";
import { ProviderCloudSessionStore } from "./providerCloudSessionStore";

describe("provider cloud journal", () => {
  it("recovers the same session and one unpriced dispatch, and purges private snapshots without relinking spend", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-cloud-journal-")));
    const connection = openSqlite(join(directory, "events.sqlite3"));
    const now = "2026-11-04T12:00:00.000Z";
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registry = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registry.events,
        projections: registry.projections,
        clock: () => now,
      });
      const input = { connection, journal, now: () => now };
      const store = new ProviderCloudSessionStore(input);
      const instanceId = decodeProviderInstanceId(randomUUID());
      const other = decodeProviderInstanceId(randomUUID());
      expect(store.enabled(instanceId)).toBe(false);
      store.setEnabled(instanceId, true);
      const job = decodeProviderCloudJob({
        id: randomUUID(),
        version: 1,
        threadId: randomUUID(),
        projectId: randomUUID(),
        instanceId,
        modelId: "fixture-model",
        inputDigest: "a".repeat(64),
        input: "synthetic reviewed snapshot",
        state: "running",
        remoteId: "sess_fixture",
        output: "",
        truncated: false,
        createdAt: now,
        updatedAt: now,
      });
      store.put(job);
      connection
        .prepare(`INSERT INTO code_thread_projection (
        thread_id, project_id, checkout_id, lifecycle, schema_version, thread_json,
        aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, ?, 'active', 1, '{}', 1, ?, 1)`)
        .run(job.threadId, job.projectId, randomUUID(), now);
      store.recordCreateDispatch(job);
      store.recordCreateDispatch(job);
      const usageRows = () =>
        connection
          .prepare(`SELECT subject_type, subject_id, quality
        FROM usage_record_projection WHERE request_shape = 'provider-cloud-turn'`)
          .all();
      expect(usageRows()).toEqual([
        { subject_type: "code-thread", subject_id: job.threadId, quality: "unavailable" },
      ]);
      const recovered = new ProviderCloudSessionStore(input);
      expect(recovered.enabled(instanceId)).toBe(true);
      expect(recovered.enabled(other)).toBe(false);
      expect(recovered.get(job.id)).toEqual(job);
      expect(recovered.active()).toEqual([job]);
      expect(recovered.hasCreateDispatch(job.id)).toBe(true);
      const usage = registry.projections.get("usage");
      if (usage === undefined) throw new Error("Usage projection missing.");
      rebuildProjection({ connection, journal, projection: usage, clock: () => now });
      expect(usageRows()).toHaveLength(1);
      const retention = new ThreadRetentionService({
        connection,
        journal,
        clock: () => now,
        uuid: randomUUID,
        listWorkThreads: () => [],
      });
      await retention.purge(
        {
          scope: {
            kind: "thread",
            mode: "code",
            threadId: decodeThreadRetentionThreadId(job.threadId),
          },
          confirm: true,
        },
        "local-window",
      );
      expect(recovered.get(job.id)).toBeUndefined();
      expect(recovered.enabled(instanceId)).toBe(true);
      expect(usageRows()).toEqual([
        { subject_type: "code-thread", subject_id: null, quality: "unavailable" },
      ]);
      rebuildProjection({ connection, journal, projection: usage, clock: () => now });
      expect(usageRows()).toEqual([
        { subject_type: "code-thread", subject_id: null, quality: "unavailable" },
      ]);
    } finally {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes v2 events with remote-device actor and credentialGeneration for person-paired acts and replays mixed v1/v2 journals", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-cloud-journal-v2-")));
    const connection = openSqlite(join(directory, "events.sqlite3"));
    const now = "2026-11-04T12:00:00.000Z";
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registry = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registry.events,
        projections: registry.projections,
        clock: () => now,
      });
      const store = new ProviderCloudSessionStore({ connection, journal, now: () => now });
      const instanceId = decodeProviderInstanceId(randomUUID());
      const deviceId = "77000000-0000-4000-8000-000000000001";
      const deviceActor = decodeEventActor({
        kind: "remote-device",
        actorId: deviceId,
        deviceId,
      });
      const pairedPrincipal = {
        kind: "person-paired-device" as const,
        credentialGeneration: 5,
      };
      const recordPrincipal = {
        ...pairedPrincipal,
        actor: deviceActor,
      };

      // Person-paired device enables opt-in (writes v2)
      store.setEnabled(instanceId, true, recordPrincipal);
      const job = decodeProviderCloudJob({
        id: randomUUID(),
        version: 1,
        threadId: randomUUID(),
        projectId: randomUUID(),
        instanceId,
        modelId: "fixture-model",
        inputDigest: "b".repeat(64),
        input: "reviewed snapshot from paired device",
        state: "submitting",
        output: "",
        truncated: false,
        createdAt: now,
        updatedAt: now,
      });
      // Person-paired submit writes v2; subsequent system observation writes v1.
      const submitted = store.put(job, recordPrincipal);
      const observed = store.put({
        ...submitted,
        state: "running",
        remoteId: "sess_paired" as never,
      });

      const events = journal.replay({ afterSequence: 0 as never, limit: 50 });
      expect(events.map((event) => event.eventName)).toEqual([
        "provider-cloud.opt-in-changed@2",
        "provider-cloud.job-changed@2",
        "provider-cloud.job-changed@1",
      ]);
      expect(events[0]?.actor).toEqual(deviceActor);
      expect((events[0]?.payload as { principal?: unknown } | undefined)?.principal).toEqual(
        pairedPrincipal,
      );
      expect(events[1]?.actor).toEqual(deviceActor);
      expect((events[1]?.payload as { principal?: unknown } | undefined)?.principal).toEqual(
        pairedPrincipal,
      );

      const recovered = new ProviderCloudSessionStore({ connection, journal, now: () => now });
      expect(recovered.enabled(instanceId)).toBe(true);
      expect(recovered.get(job.id)).toEqual(observed);
      expect(recovered.active()).toEqual([observed]);
    } finally {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

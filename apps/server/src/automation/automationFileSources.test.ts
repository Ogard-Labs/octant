import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateVersion, EventActor, type AutomationDefinition } from "@octant/contracts";
import { Schema } from "effect";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { liveWorkFilesystem, type WorkFilesystemPort } from "../work/workFilesystemPort";
import { AutomationEventStore } from "./automationEventStore";
import { AutomationSchedulerService } from "./automationSchedulerService";
import { AutomationFileSources } from "./automationFileSources";
import { prepareAutomationFileSource } from "./automationFileSourceScan";
import { initialAutomationFileCheckpoint } from "./automationFileSourceState";
import { automationDefinitionFixture, AUTOMATION_TEST_IDS } from "./automationTestFixtures";
import type { AutomationDispatchOffer } from "./automationDispatchPort";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(filesystem: WorkFilesystemPort = liveWorkFilesystem) {
  const directory = await mkdtemp(join(tmpdir(), "octant-file-source-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "Inbox"));
  const connection = openSqlite(join(directory, "events.sqlite3"));
  cleanups.push(async () => {
    connection.close();
  });
  const definition = automationDefinitionFixture({
    trigger: {
      kind: "file-arrival",
      directory: "Inbox",
      includeExtensions: ["txt"],
      excludeDirectories: [],
      settleSeconds: 2,
      automaticStartLimit: 8,
    },
    nextDueAt: null,
  });
  applyMigrations(connection, MIGRATIONS, () => definition.createdAt);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => definition.createdAt,
  });
  const store = new AutomationEventStore({
    journal,
    uuid: randomUUID,
    actor: Schema.decodeUnknownSync(EventActor)({
      kind: "local-user",
      actorId: AUTOMATION_TEST_IDS.actor,
    }),
  });
  const projection = runtime.automationProjection;
  let allowed = true;
  let monotonic = 0;
  let activity: "quiet" | "busy" | "unknown" = "quiet";
  let hint: (() => void) | undefined;
  let watchClosed = 0;
  const offers: AutomationDispatchOffer[] = [];
  const scheduler = new AutomationSchedulerService({
    store,
    projection,
    dispatch: {
      offer: (offer) => {
        offers.push(offer);
      },
    },
    now: () => definition.createdAt,
  });
  if (definition.trigger.kind !== "file-arrival") throw new Error("Expected file trigger");
  const root = await prepareAutomationFileSource({
    filesystem: liveWorkFilesystem,
    canonicalRoot: directory,
    bindingIdentity: "actual-host-project-binding",
    trigger: definition.trigger,
    signal: new AbortController().signal,
    current: () => true,
  });
  store.appendDefinitionCreated({
    automation: definition,
    fileSource: initialAutomationFileCheckpoint(root.sourceIdentity, definition.createdAt),
  });
  const sources = new AutomationFileSources({
    projection,
    scheduler,
    filesystem,
    watch: {
      watch: (_root, changed) => {
        hint = () => changed(undefined);
        return {
          close: () => {
            watchClosed += 1;
          },
        };
      },
    },
    authority: () =>
      allowed
        ? {
            canonicalRoot: directory,
            bindingIdentity: "actual-host-project-binding",
            current: () => allowed,
          }
        : undefined,
    activity: async () => activity,
    now: () => definition.createdAt,
    monotonic: () => monotonic,
    wake: () => undefined,
  });
  cleanups.push(async () => {
    sources.close();
  });
  return {
    directory,
    definition,
    store,
    projection,
    scheduler,
    sources,
    offers,
    advance: () => {
      monotonic += 2_001;
    },
    hint: () => hint?.(),
    revoke: () => {
      allowed = false;
    },
    activity: (next: typeof activity) => {
      activity = next;
    },
    closed: () => watchClosed,
  };
}

describe("file input reconciliation on the host routine owner", () => {
  it("baselines existing files, settles atomic input hints, then journals exactly one ordinary dispatch offer", async () => {
    const host = await fixture();
    await writeFile(join(host.directory, "Inbox/old.txt"), "already here");
    await host.sources.reconcile();
    expect(host.projection.getFileSource(host.definition.id)?.baselineReady).toBe(false);
    host.advance();
    await host.sources.reconcile();
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      baselineReady: true,
      baseline: [{ path: "old.txt" }],
    });
    expect(host.offers).toHaveLength(0);
    await writeFile(join(host.directory, "Inbox/new.txt"), "new arrival");
    host.hint();
    host.hint();
    await host.sources.reconcile();
    expect(host.offers).toHaveLength(0);
    host.advance();
    await host.sources.reconcile();
    expect(host.offers).toHaveLength(1);
    expect(host.offers[0]?.run.occurrence).toMatchObject({
      kind: "file-arrival",
      source: { files: ["new.txt"], automaticStartOrdinal: 1 },
    });
    await host.sources.reconcile();
    expect(host.offers).toHaveLength(1);
    expect(host.projection.getFileSource(host.definition.id)?.automaticStarts).toBe(1);
  });
  it("durably holds observed busy output instead of treating it as a fresh arrival", async () => {
    const host = await fixture();
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    host.activity("busy");
    await writeFile(join(host.directory, "Inbox/maybe-own-output.txt"), "unknown author");
    await host.sources.reconcile();
    host.activity("quiet");
    host.advance();
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      phase: "held",
      reason: "input-changed-while-running",
      held: { files: ["maybe-own-output.txt"] },
    });
    expect(host.offers).toHaveLength(0);
  });
  it.each(["revoke", "close", "pause"])("cannot publish a held scan after %s", async (action) => {
    let release: (() => void) | undefined;
    let start: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      start = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await fixture({
      ...liveWorkFilesystem,
      openFile: async (path) => {
        const file = await liveWorkFilesystem.openFile(path);
        return {
          ...file,
          read: async (maximum) => {
            start?.();
            await hold;
            return file.read(maximum);
          },
        };
      },
    });
    await writeFile(join(host.directory, "Inbox/input.txt"), "held input");
    const pending = host.sources.reconcile();
    await entered;
    if (action === "revoke") host.revoke();
    else if (action === "close") host.sources.close();
    else {
      const current = host.projection.getDefinition(host.definition.id);
      if (current === undefined) throw new Error("Missing definition");
      const paused: AutomationDefinition = {
        ...current,
        lifecycle: "paused",
        version: Schema.decodeUnknownSync(AggregateVersion)(current.version + 1),
      };
      host.store.appendDefinitionLifecycleChanged({
        automation: paused,
        previousLifecycle: current.lifecycle,
        expectedVersion: current.version,
      });
    }
    release?.();
    await pending;
    expect(host.projection.getFileSource(host.definition.id)?.baselineReady).toBe(false);
    expect(host.offers).toHaveLength(0);
    host.sources.close();
    expect(host.closed()).toBe(1);
  });
});

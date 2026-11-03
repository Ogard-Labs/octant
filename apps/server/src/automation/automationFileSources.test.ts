import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AggregateVersion,
  EventActor,
  decodeAutomationCommand,
  type AutomationDefinition,
} from "@octant/contracts";
import { Schema } from "effect";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { liveWorkFilesystem, type WorkFilesystemPort } from "../work/workFilesystemPort";
import { AutomationEventStore } from "./automationEventStore";
import { AutomationProjection } from "./automationProjection";
import { AutomationCommandService } from "./automationCommandService";
import { AutomationSchedulerService } from "./automationSchedulerService";
import { AutomationFileSources } from "./automationFileSources";
import { prepareAutomationFileSource } from "./automationFileSourceScan";
import { initialAutomationFileCheckpoint } from "./automationFileSourceState";
import {
  automationDefinitionFixture,
  automationLocalWindowPrincipal,
  AUTOMATION_TEST_IDS,
} from "./automationTestFixtures";
import type { AutomationDispatchOffer } from "./automationDispatchPort";

import {
  Project,
  ProviderInstance,
  decodeAutomationId,
  decodeWindowId,
  decodeWorkThreadId,
  type AutomationRun,
} from "@octant/contracts";
import {
  decodeStartWorkThreadTurnCommand,
  decodeWorkTurnAccepted,
  decodeWorkTurnUpdated,
  WORK_TURN_CAPABILITIES,
} from "@octant/contracts/work-turns";
import { createAutomationClient } from "../../../../packages/client-runtime/src/automationClient";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { WorkTurnProjection } from "../work/workTurnProjection";
import {
  AutomationDispatchService,
  buildAutomationAuthorityFactsFromHost,
} from "./automationDispatchService";
import { createAutomationWorkDispatchPort } from "./automationWorkDispatchPort";
import { createAutomationRouteHandler } from "./automationRoutes";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  filesystem: WorkFilesystemPort = liveWorkFilesystem,
  missedRunPolicy: "skip" | "run-once" = "skip",
) {
  const directory = await mkdtemp(join(tmpdir(), "octant-file-source-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "Inbox"));
  const connection = openSqlite(join(directory, "events.sqlite3"));
  cleanups.push(async () => {
    connection.close();
  });
  const definition = automationDefinitionFixture({
    missedRunPolicy,
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
    journal,
    definition,
    store,
    projection,
    scheduler,
    sources,
    offers,
    commands: new AutomationCommandService({
      store,
      projection,
      hostId: "local",
      clock: () => definition.createdAt,
    }),
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

async function heldFixture() {
  const host = await fixture();
  await host.sources.reconcile();
  host.advance();
  await host.sources.reconcile();
  await writeFile(join(host.directory, "Inbox/first.txt"), "first arrival");
  await host.sources.reconcile();
  host.advance();
  await host.sources.reconcile();
  const run = host.projection.latestRun(host.definition.id);
  if (run === undefined) throw new Error("Expected the ordinary automatic claim");
  host.store.appendRunStatusChanged({
    automationId: run.automationId,
    runId: run.id,
    previousLifecycle: run.lifecycle,
    lifecycle: "failed",
    failure: { reason: "runtime-failed", message: "Controlled fixture terminal result" },
    version: run.version + 1,
    expectedVersion: run.version,
    updatedAt: run.updatedAt,
  });
  await writeFile(
    join(host.directory, "Inbox/held.txt"),
    "changed through the retained busy window",
  );
  await host.sources.reconcile();
  host.advance();
  await host.sources.reconcile();
  expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
    phase: "held",
    automaticStarts: 1,
    held: { files: ["held.txt"] },
  });
  return host;
}

function reviewCommand(
  host: Awaited<ReturnType<typeof fixture>>,
  disposition: "skip" | "run-once",
) {
  const definition = host.projection.getDefinition(host.definition.id);
  const source = host.projection.getFileSource(host.definition.id);
  if (definition === undefined || source === undefined) throw new Error("Missing held source");
  const command = decodeAutomationCommand({
    kind: "rearm-file-automation",
    automationId: definition.id,
    expectedVersion: definition.version,
    principal: automationLocalWindowPrincipal(),
    origin: { kind: "interactive" },
    sourceIdentity: source.sourceIdentity,
    observationRevision: source.observationRevision,
    batchDigest: source.held?.digest ?? source.baselineDigest,
    disposition,
  });
  if (command.kind !== "rearm-file-automation") throw new Error("Expected review command");
  return command;
}

describe("file input reconciliation on the host routine owner", () => {
  it("delivers a settled source through normal Work dispatch, holds its output, and admits only an explicit protected reviewed batch", async () => {
    const host = await fixture();
    const definition = host.definition;
    const project = Schema.decodeUnknownSync(Project)({
      id: definition.projectId,
      name: "Local input Project",
      type: "work",
      lifecycle: "active",
      pinned: false,
      rank: "0/1",
      version: definition.projectVersion,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
      binding: { canonicalRoot: host.directory },
      bindingHistory: [
        {
          revisionId: AUTOMATION_TEST_IDS.bindingRevision,
          revision: 1,
          currentBinding: { canonicalRoot: host.directory },
          actor: { kind: "local-user", actorId: AUTOMATION_TEST_IDS.actor },
          changedAt: definition.createdAt,
        },
      ],
    });
    const provider = Schema.decodeUnknownSync(ProviderInstance)({
      id: definition.executionProfile.providerInstanceId,
      displayName: "Controlled provider",
      driverKind: "codex",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: definition.createdAt,
      updatedAt: definition.createdAt,
      configuration: { kind: "codex-cli", binaryPath: "/fixture/not-launched" },
    });
    const turns = new WorkTurnProjection();
    const delivered: string[] = [];
    const marked: string[] = [];
    const current = (run: AutomationRun) =>
      host.projection.getDefinition(run.automationId)?.lifecycle === "enabled" &&
      host.projection.getRun(run.id)?.cancellationTombstone === undefined;
    const work = createAutomationWorkDispatchPort({
      threads: {
        bootstrap: async () => ({ threads: [] }),
        execute: async (_scope, raw) => {
          if (typeof raw !== "object" || raw === null || !("threadId" in raw))
            throw new Error("Missing ordinary thread creation");
          return { kind: "thread-created", thread: { id: decodeWorkThreadId(raw.threadId) } };
        },
      },
      turns: {
        startFirstTurn: async (_scope, raw, options) => {
          const command = decodeStartWorkThreadTurnCommand(raw);
          expect(options?.admissionCurrent?.()).toBe(true);
          expect(command.prompt).toBe(definition.taskPrompt);
          expect(options?.accessCeiling).toBe("ask-first");
          delivered.push(options?.externalData?.content.text ?? "missing file data");
          const accepted = decodeWorkTurnAccepted({
            kind: "turn-accepted",
            requestId: command.requestId,
            threadId: command.threadId,
            turnId: command.turnId,
            projectId: definition.projectId,
            authority: command.authority,
            providerSessionId: command.requestId,
            prompt: command.prompt,
            capabilities: WORK_TURN_CAPABILITIES,
            acceptedAt: definition.createdAt,
          });
          const completed = decodeWorkTurnUpdated({
            kind: "turn-updated",
            requestId: command.requestId,
            threadId: command.threadId,
            turnId: command.turnId,
            status: "completed",
            response: "Controlled first turn finished",
            updatedAt: definition.createdAt,
          });
          host.journal.append({
            aggregate: { aggregateType: "work-turn", aggregateId: command.requestId },
            expectedVersion: 0,
            events: [accepted, completed].map((payload) => ({
              eventId: randomUUID(),
              eventName:
                payload.kind === "turn-accepted" ? "work.turn-accepted@1" : "work.turn-updated@1",
              eventVersion: 1,
              correlationId: randomUUID(),
              actor: Schema.decodeUnknownSync(EventActor)({
                kind: "local-user",
                actorId: AUTOMATION_TEST_IDS.actor,
              }),
              payload,
              occurredAt: definition.createdAt,
            })),
          });
          turns.apply(accepted);
          turns.apply(completed);
          // A normal task writes into the selected input. Filesystem hints do not prove authorship.
          await writeFile(join(host.directory, "Inbox/result.txt"), "task output");
          const turn = turns.lookup(command.requestId);
          if (turn === undefined) throw new Error("Missing actual persisted Work turn");
          return { kind: "accepted", turn };
        },
      },
      clock: () => definition.createdAt,
      uuid: randomUUID,
      fileInputCurrent: current,
      markFileInput: ({ contentReference }) => {
        marked.push(contentReference);
        return true;
      },
    });
    const dispatch = new AutomationDispatchService({
      store: host.store,
      projection: host.projection,
      work,
      code: {
        createApprovalGatedThread: async () => ({
          kind: "failed",
          reason: "unavailable",
          message: "Not Code",
        }),
        startOrRecoverFirstTurn: async () => ({
          kind: "failed",
          reason: "provider-launch-failed",
          message: "Not Code",
        }),
      },
      capacity: { admit: () => ({ kind: "admitted", release: () => undefined }) },
      resolveFacts: () =>
        buildAutomationAuthorityFactsFromHost({
          hostId: "local",
          project,
          providerInstance: provider,
          providerSupportsModel: true,
          executionProfileMatches: true,
          authorityDigestMatches: true,
          codeBindingMatches: true,
          workBindingMatches: true,
        }),
      now: () => definition.createdAt,
    });
    const terminalObserver = new AutomationSchedulerService({
      store: host.store,
      projection: host.projection,
      dispatch: { offer: () => undefined },
      now: () => definition.createdAt,
      readWorkTurn: (id) => turns.lookup(id),
    });
    await writeFile(join(host.directory, "Inbox/existing.txt"), "baseline");
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    expect(host.offers).toHaveLength(0);
    await writeFile(join(host.directory, "Inbox/new.txt"), "arrival bytes stay on disk");
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    const first = host.projection.latestRun(definition.id);
    if (first === undefined) throw new Error("Expected durable automatic occurrence");
    await dispatch.dispatchNow(definition.id, first.id);
    expect(host.projection.getRun(first.id)?.lifecycle).toBe("running");
    terminalObserver.runPass();
    expect(host.projection.getRun(first.id)?.lifecycle).toBe("completed");
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    expect(host.projection.getFileSource(definition.id)).toMatchObject({
      phase: "held",
      automaticStarts: 1,
      held: { files: ["result.txt"] },
    });
    expect(host.offers).toHaveLength(1);
    expect(delivered[0]).toContain("new.txt");
    expect(delivered[0]).not.toContain("arrival bytes stay on disk");
    expect(marked).toHaveLength(1);

    const window = decodeWindowId(randomUUID());
    const capability = "A".repeat(43);
    const authority = new WindowAuthorityStore();
    authority.register({ windowId: window, capability, now: 0 });
    let holdReview = false;
    let reviewEntered: (() => void) | undefined;
    let releaseReview: (() => void) | undefined;
    const enteredReview = new Promise<void>((resolve) => {
      reviewEntered = resolve;
    });
    const pendingReview = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const route = createAutomationRouteHandler({
      projection: host.projection,
      commands: host.commands,
      windowAuthorityStore: authority,
      projects: {
        bootstrap: async () => ({ active: [project], archived: [], availability: [], memory: [] }),
      },
      hostId: "local",
      now: () => 1,
      prepareFileRearm: async (input) => {
        const proof = await host.sources.prepareRearm(input);
        if (holdReview) {
          reviewEntered?.();
          await pendingReview;
        }
        return proof;
      },
    });
    const fetch = new Proxy(globalThis.fetch, {
      apply: async (_target, _receiver, args: Parameters<typeof globalThis.fetch>) => {
        const response = await route(new Request(args[0], args[1]));
        if (response === undefined) throw new Error("Actual route did not handle request");
        return response;
      },
    });
    let client = createAutomationClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: capability,
    });
    const shown = await client.get(definition.id, undefined, { fileSourceReview: true });
    expect(shown.fileSource).toMatchObject({
      phase: "held",
      heldFiles: ["result.txt"],
      remainingStarts: 7,
    });
    if (
      shown.fileSource?.sourceIdentity === undefined ||
      shown.fileSource.reviewDigest === undefined
    )
      throw new Error("Missing displayed review binding");
    const decision = {
      kind: "rearm-file-automation" as const,
      automationId: definition.id,
      expectedVersion: shown.automation.version,
      sourceIdentity: shown.fileSource.sourceIdentity,
      observationRevision: shown.fileSource.observationRevision,
      batchDigest: shown.fileSource.reviewDigest,
      disposition: "run-once" as const,
    };
    expect(await client.execute({ ...decision, batchDigest: "f".repeat(64) })).toMatchObject({
      kind: "automation-command-failed",
      reason: "blocked",
    });
    expect(host.projection.getFileSource(definition.id)?.automaticStarts).toBe(1);
    holdReview = true;
    const oldDecision = client.execute(decision);
    await enteredReview;
    authority.revoke(window);
    const replacementCapability = `${"B".repeat(42)}A`;
    authority.register({ windowId: window, capability: replacementCapability, now: 1 });
    releaseReview?.();
    expect(await oldDecision).toMatchObject({
      kind: "automation-command-failed",
      reason: "stale-version",
    });
    expect(host.projection.getFileSource(definition.id)?.automaticStarts).toBe(1);
    expect(delivered).toHaveLength(1);
    holdReview = false;
    client = createAutomationClient({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: replacementCapability,
    });
    const result = await client.execute(decision);
    expect(result.kind).toBe("automation-run-accepted");
    expect(await client.execute(decision)).toMatchObject({
      kind: "automation-command-failed",
      reason: "blocked",
    });
    const second = host.projection.latestRun(definition.id);
    if (second === undefined || second.id === first.id)
      throw new Error("Missing explicit new occurrence");
    await dispatch.dispatchNow(definition.id, second.id);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain("result.txt");
    expect(host.projection.getFileSource(definition.id)).toMatchObject({
      armGeneration: 2,
      automaticStarts: 1,
    });
    authority.revoke(window);
    await expect(
      client.get(definition.id, undefined, { fileSourceReview: true }),
    ).rejects.toThrow();
    expect(delivered).toHaveLength(2);
  });

  it("explicitly skips the held batch and resets only the reviewed arm, without a hidden run", async () => {
    const host = await heldFixture();
    const command = reviewCommand(host, "skip");
    const proof = await host.sources.prepareRearm({
      command,
      current: () => true,
      signal: new AbortController().signal,
    });
    expect(host.commands.execute(command, undefined, proof).kind).toBe("automation-resumed");
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      phase: "watching",
      armGeneration: 2,
      automaticStarts: 0,
    });
    expect(host.projection.getFileSource(host.definition.id)?.held).toBeUndefined();
    host.scheduler.runPass();
    expect(host.offers).toHaveLength(1);
    await writeFile(join(host.directory, "Inbox/next.txt"), "next arm");
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    expect(host.offers).toHaveLength(2);
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      armGeneration: 2,
      automaticStarts: 1,
    });
  });

  it("runs the reviewed surviving batch once under a new arm and refuses a stale repeated decision", async () => {
    const host = await heldFixture();
    const command = reviewCommand(host, "run-once");
    const proof = await host.sources.prepareRearm({
      command,
      current: () => true,
      signal: new AbortController().signal,
    });
    const result = host.commands.execute(command, undefined, proof);
    expect(result.kind).toBe("automation-run-accepted");
    host.scheduler.runPass();
    host.scheduler.runPass();
    expect(host.offers).toHaveLength(2);
    expect(host.offers[1]?.run.occurrence).toMatchObject({
      source: {
        files: ["held.txt"],
        rearm: {
          disposition: "run-once",
          previousObservationRevision: command.observationRevision,
        },
      },
    });
    expect(host.commands.execute(command, undefined, proof)).toMatchObject({
      kind: "automation-command-failed",
      reason: "stale-version",
    });
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      armGeneration: 2,
      automaticStarts: 1,
    });
  });

  it("keeps paused held input reachable for an explicit current review without ordinary Resume dropping it", async () => {
    const host = await heldFixture();
    const definition = host.projection.getDefinition(host.definition.id);
    if (definition === undefined) throw new Error("Missing definition");
    host.store.appendDefinitionLifecycleChanged({
      automation: {
        ...definition,
        lifecycle: "paused",
        version: Schema.decodeUnknownSync(AggregateVersion)(definition.version + 1),
      },
      previousLifecycle: definition.lifecycle,
      expectedVersion: definition.version,
    });
    await host.sources.reconcile();
    const command = reviewCommand(host, "skip");
    expect(
      host.commands.execute(
        decodeAutomationCommand({
          kind: "resume-automation",
          automationId: command.automationId,
          expectedVersion: command.expectedVersion,
          principal: command.principal,
          origin: command.origin,
        }),
      ),
    ).toMatchObject({ kind: "automation-command-failed", reason: "blocked" });
    const proof = await host.sources.prepareRearm({
      command,
      current: () => true,
      signal: new AbortController().signal,
    });
    expect(host.commands.execute(command, undefined, proof).kind).toBe("automation-resumed");
    expect(host.projection.getDefinition(host.definition.id)?.lifecycle).toBe("enabled");
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      automaticStarts: 0,
      armGeneration: 2,
    });
  });

  it("cannot clear a changed batch or commit after the review's person authority is revoked", async () => {
    const host = await heldFixture();
    const command = reviewCommand(host, "run-once");
    await writeFile(join(host.directory, "Inbox/held.txt"), "changed again");
    await expect(
      host.sources.prepareRearm({
        command,
        current: () => true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("input changed");
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      phase: "held",
      armGeneration: 1,
      automaticStarts: 1,
    });
    await writeFile(
      join(host.directory, "Inbox/held.txt"),
      "changed through the retained busy window",
    );
    let current = true;
    const proof = await host.sources.prepareRearm({
      command,
      current: () => current,
      signal: new AbortController().signal,
    });
    current = false;
    expect(host.commands.execute(command, undefined, proof)).toMatchObject({
      kind: "automation-command-failed",
      reason: "stale-version",
    });
    expect(host.offers).toHaveLength(1);
  });

  it.each([false, true])(
    "repairs the run-first reviewed intent without duplicate dispatch; superseded=%s",
    async (superseded) => {
      const host = await heldFixture();
      const command = reviewCommand(host, "run-once");
      const proof = await host.sources.prepareRearm({
        command,
        current: () => true,
        signal: new AbortController().signal,
      });
      const crashing = new AutomationCommandService({
        projection: host.projection,
        hostId: "local",
        clock: () => host.definition.createdAt,
        store: {
          appendDefinitionCreated: (input) => host.store.appendDefinitionCreated(input),
          appendDefinitionUpdated: (input) => host.store.appendDefinitionUpdated(input),
          appendDefinitionLifecycleChanged: (input) =>
            host.store.appendDefinitionLifecycleChanged(input),
          appendRunCreated: (input) => host.store.appendRunCreated(input),
          appendRunCancellation: (input) => host.store.appendRunCancellation(input),
          appendOccurrenceLedger: () => {
            throw new Error("Injected re-arm ledger interruption");
          },
        },
      });
      expect(() => crashing.execute(command, undefined, proof)).toThrow(
        "Injected re-arm ledger interruption",
      );
      const queued = host.projection.latestRun(host.definition.id);
      expect(queued?.lifecycle).toBe("queued");
      await host.sources.reconcile();
      expect(host.projection.getFileSource(host.definition.id)?.observationRevision).toBe(
        command.observationRevision,
      );
      if (superseded) {
        const definition = host.projection.getDefinition(host.definition.id);
        if (definition === undefined) throw new Error("Missing definition");
        host.store.appendDefinitionLifecycleChanged({
          automation: {
            ...definition,
            lifecycle: "paused",
            version: Schema.decodeUnknownSync(AggregateVersion)(definition.version + 1),
          },
          previousLifecycle: definition.lifecycle,
          expectedVersion: definition.version,
        });
      }
      expect(host.scheduler.runPass().errors).toEqual([]);
      host.scheduler.runPass();
      expect(host.offers).toHaveLength(superseded ? 1 : 2);
      expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
        automaticStarts: 1,
        armGeneration: superseded ? 1 : 2,
      });
      if (queued !== undefined)
        expect(host.projection.getRun(queued.id)?.lifecycle).toBe(superseded ? "failed" : "queued");
      if (superseded)
        expect(host.projection.getDefinition(host.definition.id)?.lifecycle).toBe("paused");
    },
  );

  it("baselines an intentional paused interval on Resume without offline catch-up or resetting the allowance", async () => {
    const host = await fixture(liveWorkFilesystem, "run-once");
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    await writeFile(join(host.directory, "Inbox/first.txt"), "arrival");
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    const run = host.projection.latestRun(host.definition.id);
    if (run === undefined) throw new Error("Expected first claim");
    host.store.appendRunStatusChanged({
      automationId: run.automationId,
      runId: run.id,
      previousLifecycle: run.lifecycle,
      lifecycle: "failed",
      failure: { reason: "runtime-failed", message: "Controlled terminal result" },
      version: run.version + 1,
      expectedVersion: run.version,
      updatedAt: run.updatedAt,
    });
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    const lifecycle = (kind: "pause-automation" | "resume-automation") => {
      const definition = host.projection.getDefinition(host.definition.id);
      if (definition === undefined) throw new Error("Missing definition");
      return host.commands.execute(
        decodeAutomationCommand({
          kind,
          automationId: definition.id,
          expectedVersion: definition.version,
          principal: automationLocalWindowPrincipal(),
          origin: { kind: "interactive" },
        }),
      );
    };
    expect(lifecycle("pause-automation").kind).toBe("automation-paused");
    const replayed = new AutomationProjection();
    host.store.replayEach((frame) => replayed.applyEnvelope(frame));
    expect(replayed.getFileSource(host.definition.id)).toMatchObject({
      phase: "arming",
      baselineReady: true,
      automaticStarts: 1,
    });
    await host.sources.reconcile();
    await writeFile(join(host.directory, "Inbox/paused.txt"), "intentional non-observation");
    expect(lifecycle("resume-automation").kind).toBe("automation-resumed");
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    expect(host.offers).toHaveLength(1);
    expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
      phase: "watching",
      automaticStarts: 1,
      baseline: [{ path: "first.txt" }, { path: "paused.txt" }],
    });
  });

  it("keeps an unrelated source observing while another confined file read is held", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const host = await fixture({
      ...liveWorkFilesystem,
      openFile: async (path) => {
        const file = await liveWorkFilesystem.openFile(path);
        return {
          ...file,
          read: async (maximum) => {
            if (path.endsWith("/Inbox/held.txt")) {
              entered?.();
              await held;
            }
            return file.read(maximum);
          },
        };
      },
    });
    await writeFile(join(host.directory, "Inbox/held.txt"), "slow source");
    const original = host.sources.reconcile();
    await reading;
    await mkdir(join(host.directory, "Other"));
    const sibling = automationDefinitionFixture({
      id: decodeAutomationId(AUTOMATION_TEST_IDS.otherAutomation),
      trigger: {
        kind: "file-arrival",
        directory: "Other",
        includeExtensions: ["txt"],
        excludeDirectories: [],
        settleSeconds: 2,
        automaticStartLimit: 8,
      },
      nextDueAt: null,
    });
    if (sibling.trigger.kind !== "file-arrival") throw new Error("Expected file trigger");
    const root = await prepareAutomationFileSource({
      filesystem: liveWorkFilesystem,
      canonicalRoot: host.directory,
      bindingIdentity: "actual-host-project-binding",
      trigger: sibling.trigger,
      current: () => true,
      signal: new AbortController().signal,
    });
    host.store.appendDefinitionCreated({
      automation: sibling,
      fileSource: initialAutomationFileCheckpoint(root.sourceIdentity, sibling.createdAt),
    });
    await host.sources.reconcile();
    host.advance();
    await host.sources.reconcile();
    expect(host.projection.getFileSource(sibling.id)?.baselineReady).toBe(true);
    expect(host.projection.getFileSource(host.definition.id)?.baselineReady).toBe(false);
    release?.();
    await original;
  });

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
  it.each(["busy", "unknown"] as const)(
    "holds a late change through the first settled quiet scan after %s activity",
    async (activity) => {
      const host = await fixture();
      await host.sources.reconcile();
      host.advance();
      await host.sources.reconcile();
      host.activity(activity);
      await host.sources.reconcile();
      expect(host.projection.getFileSource(host.definition.id)?.reason).toBe(
        activity === "busy" ? "known-activity" : "activity-unknown",
      );
      host.activity("quiet");
      await writeFile(
        join(host.directory, "Inbox/late-output.txt"),
        "writer unknown after known activity",
      );
      await host.sources.reconcile();
      host.advance();
      await host.sources.reconcile();
      expect(host.offers).toHaveLength(0);
      expect(host.projection.getFileSource(host.definition.id)).toMatchObject({
        phase: "held",
        automaticStarts: 0,
        held: { files: ["late-output.txt"] },
      });
    },
  );

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

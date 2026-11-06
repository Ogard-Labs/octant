import { ConversationInputTransfer } from "../attachments/conversationInputTransfer";
import { randomUUID } from "node:crypto";
import { approvedWorkingFolderChoices } from "../approvedWorkingFolders";
import { workExternalInputReceipt } from "./workExternalInput";
import { createAutomationWorkDispatchPort } from "../automation/automationWorkDispatchPort";
import {
  buildAutomationRunForOccurrence,
  deterministicAutomationUuid,
} from "../automation/automationRunIdentity";
import {
  initialAutomationFileCheckpoint,
  automationSourceSnapshotDigest,
} from "../automation/automationFileSourceState";
import {
  automationFileContext,
  automationDispatchPromptText,
} from "../automation/automationFileContext";
import { automationPromptDigest } from "../automation/automationAuthorityRevalidation";

import {
  AutomationId,
  UtcTimestamp,
  WORK_TURN_CAPABILITIES,
  decodeProjectExtraFolder,
  decodeContextCompactionId,
  decodeContextSubjectRef,
  decodeProviderRuntimeEvent,
  decodeNativeHarnessSlotCandidate,
  EventActor,
  ReplayCursor,
  type ProviderContextBlock,
  type WorkAccess,
} from "@octant/contracts";
import { makeProviderCapacityScheduler } from "../context/contextRuntime";
import { SessionCompactionService } from "../context/sessionCompaction";
import { ContextHarnessError, ContextHarnessService } from "../context/contextHarnessService";
import { automaticCompactionId } from "../context/automaticCompaction";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { ProjectionRegistry } from "../persistence/projection";
import { leadApprovalFor } from "../harness/leadApprovalAttention";
import { NativeHarnessApprovalStore } from "../harness/nativeHarnessApprovals";
import { registerNativeHarnessEvents } from "../harness/nativeHarnessEvents";
import { NativeHarnessSessionStore } from "../harness/nativeHarnessSessionStore";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  decodeProviderInstanceId,
  decodeProviderModel,
  decodeProviderModelId,
} from "@octant/contracts";
import { unavailableProviderServiceLimits } from "@octant/provider-sdk/context-facts";
import { mkdtemp, rm, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decodeAgentRun,
  decodeMentionableThreadId,
  decodeWorkAttachmentId,
  decodeWorkThreadTranscript,
  decodeWorkTurnAccepted,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  decodeProjectId,
  decodeBindingRevisionId,
  decodeProviderInstance,
  decodeWindowId,
  type AgentRun,
  type Project,
  type WorkTurnStreamFrame,
} from "@octant/contracts";
import { Effect, Queue, Schema, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDriver, ProviderConnection } from "@octant/provider-sdk/driver";
import { BROWSER_TOOL_HOST_LINE, browserUseSelection } from "@octant/plugin-host/browser-use";
import { createWorkThreadMentionDirectory } from "../chat/threadMentionService";
import { createWorkTurnRouteHandler } from "../workTurnRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { WorkAttachmentStore } from "./workAttachmentStore";
import { admittedParentWorkContext } from "../agentRun/agentRunParentContext";
import { WorkTurnProjection, hydrateWorkTurnProjectionFromJournal } from "./workTurnProjection";
import {
  WORK_THREAD_MARKED_DONE_TURN_REFUSAL,
  type RunningWorkTurnAccess,
  WorkTurnService,
  WorkTurnServiceError,
  type WorkTurnServiceDependencies,
} from "./workTurnService";
import { WorkProjectStatusFiles } from "./workProjectStatusFiles";
import { WorkTurnRuntime, type WorkTurnRuntimePort } from "./workTurnRuntime";
import { prepareAutomationFileDefinition } from "../automation/automationFileSourceAuthority";
import {
  automationDefinitionFixture,
  automationDefinitionDraftFixture,
} from "../automation/automationTestFixtures";
import { liveWorkFilesystem } from "./workFilesystemPort";
import type { TurnEndSummary } from "../metrics/turnEnd";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { frameExternalContentForModel } from "../context/externalContentFraming";

const attachmentRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    attachmentRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const now = "2026-08-11T12:00:00.000Z" as UtcTimestamp;
const ids = {
  window: decodeWindowId("72000000-0000-4000-8000-000000000001"),
  project: decodeProjectId("72000000-0000-4000-8000-000000000002"),
  thread: decodeWorkThreadId("72000000-0000-4000-8000-000000000004"),
  provider: "72000000-0000-4000-8000-000000000005",
  binding: "72000000-0000-4000-8000-000000000008",
  request: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  turn: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  session: "11111111-1111-4111-8111-111111111111",
} as const;

describe("WorkTurnService", () => {
  it("launches in the selected approved folder and refuses revocation without falling back", async () => {
    const base = workProject();
    const project = workProject({
      extraFolders: [
        decodeProjectExtraFolder({
          canonicalRoot: "/approved/notes",
          addedAt: now,
          addedBy: base.bindingHistory[0]?.actor,
        }),
      ],
    });
    const choice = approvedWorkingFolderChoices(project).find((folder) => folder.kind === "extra");
    if (choice === undefined) throw new Error("Missing approved choice");
    const fixture = serviceFixture({ project });
    const thread = { ...(await fixture.threads.read()), workingFolderId: choice.id };
    fixture.threads.read.mockResolvedValue(thread);
    fixture.threads.bootstrap.mockResolvedValue({ threads: [thread] });
    const command = startCommand();
    await fixture.service.startFirstTurn(ids.window, {
      ...command,
      authority: { ...command.authority, workingFolderId: choice.id },
    });
    await fixture.waitForIdle();
    expect(fixture.acquireInputs[0]).toMatchObject({ projectRoot: "/approved/notes" });
    fixture.persistence.readProject.mockReturnValue(base);
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...command,
        requestId: randomUUID(),
        turnId: randomUUID(),
        authority: { ...command.authority, workingFolderId: choice.id },
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.acquireInputs).toHaveLength(1);
  });
  it("interrupts a running provider when its selected folder is withdrawn", async () => {
    const base = workProject();
    const project = workProject({
      extraFolders: [
        decodeProjectExtraFolder({
          canonicalRoot: "/approved/notes",
          addedAt: now,
          addedBy: base.bindingHistory[0]?.actor,
        }),
      ],
    });
    const choice = approvedWorkingFolderChoices(project).find((folder) => folder.kind === "extra");
    if (choice === undefined) throw Error("Missing folder");
    let runningSignal: AbortSignal | undefined;
    const fixture = serviceFixture({
      project,
      turnRuntime: {
        run: async (input) => {
          runningSignal = input.signal;
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { kind: "cancelled" };
        },
      },
    });
    const thread = { ...(await fixture.threads.read()), workingFolderId: choice.id };
    fixture.threads.read.mockResolvedValue(thread);
    fixture.threads.bootstrap.mockResolvedValue({ threads: [thread] });
    const command = startCommand();
    await fixture.service.startFirstTurn(ids.window, {
      ...command,
      authority: { ...command.authority, workingFolderId: choice.id },
    });
    await vi.waitFor(() => expect(runningSignal).toBeDefined());
    fixture.persistence.readProject.mockReturnValue(base);
    await vi.waitFor(() => expect(runningSignal?.aborted).toBe(true), { timeout: 2000 });
    await fixture.waitForIdle();
    expect(fixture.projection.lookup(ids.request)?.status).toBe("cancelled");
  });
  it("journals the exact accepted framed input and keeps it through projection replay and an identical retry", async () => {
    const run = vi.fn(async () => ({ kind: "completed" as const, response: "Done" }));
    const fixture = serviceFixture({ turnRuntime: { run } });
    const requests: Array<
      Parameters<WorkTurnServiceDependencies["persistence"]["journal"]["append"]>[0]
    > = [];
    fixture.persistence.journal.append.mockImplementation(
      (request: Parameters<WorkTurnServiceDependencies["persistence"]["journal"]["append"]>[0]) => {
        requests.push(request);
      },
    );
    const data = {
      referenceId: "owned-workflow:receipt-1",
      content: frameExternalContentForModel({
        origin: "external-content",
        sourceLabel: "controlled-workflow",
        body: "Observed metadata",
        section: "workspace-context",
      }),
    };
    const first = await fixture.service.startFirstTurn(ids.window, startCommand(), {
      externalData: data,
    });
    expect(first.kind).toBe("accepted");
    await fixture.waitForIdle();
    const accepted = requests
      .flatMap((request) => request.events)
      .find((event) => event.eventName === "work.turn-accepted@1");
    if (accepted === undefined) throw new Error("Expected accepted journal evidence");
    const decoded = decodeWorkTurnAccepted(JSON.parse(JSON.stringify(accepted.payload)));
    expect(decoded.externalInput).toEqual(workExternalInputReceipt(data));
    const restored = new WorkTurnProjection();
    restored.apply(decoded);
    expect(restored.lookup(ids.request)?.externalInput).toEqual(decoded.externalInput);
    const result = await fixture.service.startFirstTurn(ids.window, startCommand(), {
      externalData: data,
    });
    expect(result.kind).toBe("accepted");
    // An ordinary idempotent lookup still returns the existing turn; it asserts no new host input.
    expect((await fixture.service.startFirstTurn(ids.window, startCommand())).kind).toBe(
      "accepted",
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["missing", "reference", "body", "section"] as const)(
    "refuses %s input evidence on an existing Work request without running a provider again",
    async (change) => {
      const run = vi.fn(async () => ({ kind: "completed" as const, response: "Done" }));
      const fixture = serviceFixture({ turnRuntime: { run } });
      const data = {
        referenceId: "owned-workflow:receipt-1",
        content: frameExternalContentForModel({
          origin: "external-content",
          sourceLabel: "controlled-workflow",
          body: "Original",
          section: "workspace-context",
        }),
      };
      await fixture.service.startFirstTurn(
        ids.window,
        startCommand(),
        change === "missing" ? {} : { externalData: data },
      );
      await fixture.waitForIdle();
      const modified =
        change === "missing"
          ? data
          : {
              referenceId: change === "reference" ? "owned-workflow:receipt-2" : data.referenceId,
              content: {
                ...data.content,
                ...(change === "body" ? { text: `${data.content.text} changed` } : {}),
                ...(change === "section" ? { section: "conversation" as const } : {}),
              },
            };
      await expect(
        fixture.service.startFirstTurn(ids.window, startCommand(), { externalData: modified }),
      ).rejects.toMatchObject({
        failure: { category: "stale", message: expect.stringContaining("unconfirmed") },
      });
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("refuses required framed input that cannot fit before acceptance or provider execution", async () => {
    const run = vi.fn(async () => ({ kind: "completed" as const, response: "Done" }));
    const fixture = serviceFixture({ turnRuntime: { run }, safeInputBudgetTokens: 500 });
    const requests: Array<
      Parameters<WorkTurnServiceDependencies["persistence"]["journal"]["append"]>[0]
    > = [];
    fixture.persistence.journal.append.mockImplementation(
      (request: Parameters<WorkTurnServiceDependencies["persistence"]["journal"]["append"]>[0]) => {
        requests.push(request);
      },
    );
    const controlRun = vi.fn(async () => ({ kind: "completed" as const, response: "Done" }));
    const control = serviceFixture({
      turnRuntime: { run: controlRun },
      safeInputBudgetTokens: 500,
    });
    await control.service.startFirstTurn(ids.window, startCommand(), {
      externalData: {
        referenceId: "owned-workflow:small",
        content: frameExternalContentForModel({
          origin: "external-content",
          sourceLabel: "controlled-workflow",
          body: "Small metadata",
          section: "workspace-context",
        }),
      },
    });
    await control.waitForIdle();
    expect(controlRun).toHaveBeenCalledOnce();
    const data = {
      referenceId: "owned-workflow:oversized",
      content: frameExternalContentForModel({
        origin: "external-content",
        sourceLabel: "controlled-workflow",
        body: "required metadata ".repeat(4000),
        section: "workspace-context",
      }),
    };
    await expect(
      fixture.service.startFirstTurn(ids.window, startCommand(), { externalData: data }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.projection.lookup(ids.request)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(
      requests
        .flatMap((request) => request.events)
        .some((event) => event.eventName === "work.turn-accepted@1"),
    ).toBe(false);
  });

  it("captures the accepted frame before preparation awaits", async () => {
    const inputs: Array<Parameters<WorkTurnRuntimePort["run"]>[0]> = [];
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          inputs.push(input);
          return { kind: "completed", response: "Done" };
        },
      },
    });
    const content = {
      ...frameExternalContentForModel({
        origin: "external-content",
        sourceLabel: "controlled-workflow",
        body: "Original snapshot",
        section: "workspace-context",
      }),
    };
    const data = { referenceId: "owned-workflow:snapshot", content };
    const receipt = workExternalInputReceipt(data);
    const pending = fixture.service.startFirstTurn(ids.window, startCommand(), {
      externalData: data,
    });
    content.text = "changed after admission began";
    expect((await pending).kind).toBe("accepted");
    await fixture.waitForIdle();
    expect(fixture.projection.lookup(ids.request)?.externalInput).toEqual(receipt);
    expect(JSON.stringify(inputs[0]?.context)).toContain("Original snapshot");
    expect(JSON.stringify(inputs[0]?.context)).not.toContain("changed after admission began");
  });

  it.each(["same", "missing", "different"] as const)(
    "checks %s accepted input when a concurrent writer wins the actual journal append",
    async (variant) => {
      const run = vi.fn(async () => ({ kind: "completed" as const, response: "Done" }));
      const fixture = serviceFixture({ turnRuntime: { run } });
      const data = {
        referenceId: "owned-workflow:conflict",
        content: frameExternalContentForModel({
          origin: "external-content",
          sourceLabel: "controlled-workflow",
          body: "Exact frame",
          section: "workspace-context",
        }),
      };
      fixture.persistence.journal.append.mockImplementation(
        (
          request: Parameters<WorkTurnServiceDependencies["persistence"]["journal"]["append"]>[0],
        ) => {
          const accepted = request.events.find(
            (event) => event.eventName === "work.turn-accepted@1",
          );
          if (accepted === undefined) throw new Error("Expected only the attempted acceptance");
          const decoded = decodeWorkTurnAccepted(accepted.payload);
          const { externalInput: _input, ...legacy } = decoded;
          fixture.projection.apply(
            decodeWorkTurnAccepted(
              variant === "missing"
                ? legacy
                : {
                    ...decoded,
                    externalInput:
                      variant === "same"
                        ? decoded.externalInput
                        : { referenceId: data.referenceId, digest: "b".repeat(64) },
                  },
            ),
          );
          throw new ConcurrencyConflict({
            aggregateType: "work-turn",
            aggregateId: String(ids.request),
            expectedVersion: 0,
            actualVersion: 1,
          });
        },
      );
      const result = fixture.service.startFirstTurn(ids.window, startCommand(), {
        externalData: data,
      });
      if (variant === "same") expect((await result).kind).toBe("accepted");
      else
        await expect(result).rejects.toMatchObject({
          failure: { category: "stale", message: expect.stringContaining("unconfirmed") },
        });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("keeps stored input evidence isolated from returned and replay event objects", async () => {
    const fixture = serviceFixture();
    const data = {
      referenceId: "owned-workflow:immutable",
      content: frameExternalContentForModel({
        origin: "external-content",
        sourceLabel: "controlled-workflow",
        body: "Exact frame",
        section: "workspace-context",
      }),
    };
    const expected = workExternalInputReceipt(data);
    await fixture.service.startFirstTurn(ids.window, startCommand(), { externalData: data });
    await fixture.waitForIdle();
    const views = [
      fixture.projection.lookup(ids.request),
      fixture.projection.latestForThread(ids.thread),
      ...fixture.projection.listForThread(ids.thread),
      ...fixture.projection.listForProject(ids.project),
    ];
    for (const view of views) {
      if (view?.externalInput === undefined) throw new Error("Expected accepted input");
      expect(Reflect.set(view.externalInput, "digest", "b".repeat(64))).toBe(false);
      Reflect.set(view, "externalInput", { referenceId: "forged", digest: "b".repeat(64) });
      expect(fixture.projection.lookup(ids.request)?.externalInput).toEqual(expected);
    }
    const event = decodeWorkTurnAccepted({
      ...startCommand(),
      kind: "turn-accepted",
      projectId: ids.project,
      providerSessionId: ids.session,
      capabilities: WORK_TURN_CAPABILITIES,
      acceptedAt: now,
      externalInput: expected,
    });
    const replay = new WorkTurnProjection();
    replay.apply(event);
    if (event.externalInput === undefined) throw new Error("Expected event receipt");
    Reflect.set(event.externalInput, "digest", "b".repeat(64));
    replay.markInterruptedOnRestart(now);
    const restored = replay.lookup(ids.request);
    if (restored === undefined) throw new Error("Expected replayed owner");
    Reflect.set(restored, "externalInput", { referenceId: "forged", digest: "b".repeat(64) });
    expect(replay.lookup(ids.request)?.externalInput).toEqual(expected);
  });

  it.each(["legacy", "lost reply"] as const)(
    "recovers only exact retained file input after %s without a provider replay",
    async (scenario) => {
      const sent: Array<Parameters<ProviderConnection["send"]>[0]> = [];
      const original = summaryDriver("Done");
      const driver: ProviderDriver = {
        kind: "openai-compatible",
        probe: () => Effect.die("unused"),
        acquire: (input) =>
          original.acquire(input).pipe(
            Effect.map((connection) => ({
              ...connection,
              send: (turn: Parameters<ProviderConnection["send"]>[0]) => {
                sent.push(turn);
                return connection.send(turn);
              },
            })),
          ),
      };
      const fixture = serviceFixture({
        turnRuntime: new WorkTurnRuntime(),
        resolveDriver: () => driver,
      });
      const base = automationDefinitionFixture();
      if (base.binding.kind !== "work") throw new Error("Expected Work definition");
      const definition = automationDefinitionFixture({
        projectId: ids.project,
        taskPrompt: "Summarize observed file changes.",
        binding: {
          ...base.binding,
          kind: "work",
          projectId: ids.project,
          bindingRevisionId: decodeBindingRevisionId(ids.binding),
        },
        executionProfile: {
          ...base.executionProfile,
          projectId: ids.project,
          providerInstanceId: decodeProviderInstanceId(ids.provider),
          modelId: decodeProviderModelId("model-a"),
        },
        trigger: {
          kind: "file-arrival",
          directory: "Inbox",
          includeExtensions: [],
          excludeDirectories: [],
          settleSeconds: 2,
          automaticStartLimit: 8,
        },
        nextDueAt: null,
      });
      const files = ["report.txt"];
      const snapshot = files.map((path) => ({ path, digest: "b".repeat(64), size: 4 }));
      const checkpoint = {
        ...initialAutomationFileCheckpoint("a".repeat(64), now),
        baselineReady: true,
        automaticStarts: 1,
        phase: "watching" as const,
        baseline: snapshot,
        baselineDigest: automationSourceSnapshotDigest(snapshot),
      };
      const run = buildAutomationRunForOccurrence({
        definition,
        now,
        occurrence: {
          kind: "file-arrival",
          automationId: definition.id,
          definitionRevision: definition.definitionRevision,
          source: { checkpoint, files, automaticStartOrdinal: 1 },
        },
      });
      const command = {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId(run.firstTurnRequestId),
        turnId: decodeWorkTurnId(
          deterministicAutomationUuid(`automation-work-turn:${run.occurrenceKey}`),
        ),
        prompt: definition.taskPrompt,
      };
      const storageRoot = await mkdtemp(join(tmpdir(), "octant-work-file-receipt-"));
      attachmentRoots.push(storageRoot);
      const databasePath = join(storageRoot, "receipt.sqlite3");
      let storage = openSqlite(databasePath);
      applyMigrations(storage, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection: storage,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      fixture.persistence.journal.append.mockImplementation(
        (
          request: Parameters<WorkTurnServiceDependencies["persistence"]["journal"]["append"]>[0],
        ) => {
          journal.append(request);
        },
      );
      let readProjection = fixture.projection;
      try {
        if (scenario === "legacy") {
          expect((await fixture.service.startFirstTurn(ids.window, command)).kind).toBe("accepted");
          await fixture.waitForIdle(command.requestId);
          expect(sent).toHaveLength(1);
          expect(JSON.stringify(sent[0])).not.toContain("report.txt");
        }
        let current = true;
        let loseReply = true;
        const prepare = vi.fn(async () => () => current);
        const mark = vi.fn(() => true);
        const adapter = createAutomationWorkDispatchPort({
          threads: {
            bootstrap: async () => ({ threads: [{ id: ids.thread }] }),
            execute: async () => ({ kind: "unused" }),
          },
          turns: {
            startFirstTurn: async (scope, input, options) => {
              const result = await fixture.service.startFirstTurn(scope, input, options);
              if (scenario === "lost reply" && loseReply) {
                loseReply = false;
                throw new Error("Controlled lost accepted reply");
              }
              return result;
            },
          },
          readTurn: (requestId) => readProjection.lookup(requestId),
          clock: () => now,
          uuid: randomUUID,
          prepareFileInput: prepare,
          markFileInput: mark,
        });
        expect(automationFileContext(run)?.content.text).toContain("report.txt");
        const result = await adapter.startOrRecoverFirstTurn({
          run,
          threadId: ids.thread,
          firstTurnRequestId: run.firstTurnRequestId,
          promptDigest: automationPromptDigest(automationDispatchPromptText(run)),
          scopeId: ROUTINE_HOST_SCOPE_ID,
        });
        expect(result.kind).toBe("failed");
        if (scenario === "lost reply") {
          await fixture.waitForIdle(command.requestId);
          expect(JSON.stringify(sent[0])).toContain("report.txt");
          const retainedContext = automationFileContext(run);
          if (retainedContext === undefined) throw new Error("Expected file context");
          expect(fixture.projection.lookup(command.requestId)?.externalInput).toEqual(
            workExternalInputReceipt(retainedContext),
          );
          storage.close();
          storage = openSqlite(databasePath);
          const reopenedRegistries = createPhase1RuntimeRegistries();
          const replayJournal = new Journal({
            connection: storage,
            registry: reopenedRegistries.events,
            projections: reopenedRegistries.projections,
            clock: () => now,
          });
          readProjection = new WorkTurnProjection();
          expect(
            hydrateWorkTurnProjectionFromJournal({
              replay: (cursor) =>
                replayJournal.replayAggregateType({
                  ...Schema.decodeUnknownSync(ReplayCursor)({
                    afterSequence: cursor.afterSequence,
                    limit: cursor.limit,
                  }),
                  aggregateType: cursor.aggregateType ?? "work-turn",
                }),
              projection: readProjection,
            }),
          ).toBe("ok");
          expect(readProjection.lookup(command.requestId)?.externalInput).toEqual(
            workExternalInputReceipt(retainedContext),
          );
          current = false;
          const recovered = await adapter.startOrRecoverFirstTurn({
            run,
            threadId: ids.thread,
            firstTurnRequestId: run.firstTurnRequestId,
            promptDigest: automationPromptDigest(automationDispatchPromptText(run)),
            scopeId: ROUTINE_HOST_SCOPE_ID,
          });
          expect(recovered).toMatchObject({
            kind: "accepted",
            runtimeReceipt: `work-turn:${run.firstTurnRequestId}`,
          });
          expect(prepare).toHaveBeenCalledOnce();
          expect(mark).toHaveBeenCalledOnce();
        } else {
          expect(prepare).not.toHaveBeenCalled();
          expect(mark).not.toHaveBeenCalled();
        }
        expect(sent).toHaveLength(1);
      } finally {
        storage.close();
      }
    },
  );

  it.each(["unchanged", "input directory", "Project root"] as const)(
    "keeps the exact physical source admission through actual SDK startup (%s)",
    async (replaced) => {
      const root = await mkdtemp(join(tmpdir(), "octant-routine-sdk-fence-"));
      attachmentRoots.push(root, `${root}-old`);
      await mkdir(join(root, "Inbox"));
      const definition = automationDefinitionDraftFixture({
        trigger: {
          kind: "file-arrival",
          directory: "Inbox",
          includeExtensions: [],
          excludeDirectories: [],
          settleSeconds: 2,
          automaticStartLimit: 8,
        },
      });
      const proof = await prepareAutomationFileDefinition({
        automationId: Schema.decodeUnknownSync(AutomationId)(randomUUID()),
        expectedVersion: 0,
        filesystem: liveWorkFilesystem,
        authority: {
          canonicalRoot: root,
          bindingIdentity: "retained local binding",
          current: () => true,
        },
        definition,
        current: () => true,
        signal: new AbortController().signal,
        now: () => Schema.decodeUnknownSync(UtcTimestamp)(now),
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      const events = Effect.runSync(
        Queue.unbounded<ReturnType<typeof decodeProviderRuntimeEvent>>(),
      );
      let submitted = 0;
      const connection: ProviderConnection = {
        subscribe: Effect.succeed(Stream.fromQueue(events)),
        start: (input) =>
          Effect.promise(async () => {
            entered.resolve();
            await release.promise;
            return { sessionId: input.sessionId };
          }),
        resume: () => Effect.die("No retained SDK session in this fixture"),
        send: (input) =>
          Effect.gen(function* () {
            submitted++;
            yield* Queue.offer(
              events,
              decodeProviderRuntimeEvent({
                instanceId: ids.provider,
                sequence: 1,
                correlationId: randomUUID(),
                occurredAt: now,
                kind: "completed",
                sessionId: input.sessionId,
              }),
            );
          }),
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      };
      const fixture = serviceFixture({
        project: workProject({ binding: { canonicalRoot: root } }),
        turnRuntime: new WorkTurnRuntime({ timeoutMs: 1000 }),
        resolveDriver: (_id, fallback) => ({
          ...fallback,
          acquire: () => Effect.succeed(connection),
        }),
      });
      expect(proof.current()).toBe(true);
      await fixture.service.startFirstTurn(ids.window, startCommand(), {
        admissionCurrent: proof.current,
      });
      await entered.promise;
      if (replaced === "input directory") {
        await rename(join(root, "Inbox"), join(root, "old-input"));
        await mkdir(join(root, "Inbox"));
      } else if (replaced === "Project root") {
        await rename(root, `${root}-old`);
        await mkdir(root);
        await mkdir(join(root, "Inbox"));
      }
      release.resolve();
      await fixture.waitForIdle();
      expect(submitted).toBe(replaced === "unchanged" ? 1 : 0);
      expect(fixture.projection.lookup(ids.request)).toMatchObject(
        replaced === "unchanged"
          ? { status: "completed" }
          : { status: "failed", failure: { category: "unauthorized" } },
      );
    },
  );

  it("keeps owned host file data in required workspace context while the fixed task stays the current request", async () => {
    const seen: string[] = [];
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          seen.push(JSON.stringify(input.context));
          return { kind: "completed", response: "Controlled provider completed" };
        },
      },
    });
    const externalData = {
      referenceId: "automation-file-batch:fixture",
      content: frameExternalContentForModel({
        origin: "external-content",
        sourceLabel: "file-arrival-routine",
        section: "workspace-context",
        body: JSON.stringify({ directory: "Inbox", files: ["invoice.txt"] }),
      }),
    };
    await fixture.service.startFirstTurn(ids.window, startCommand(), {
      externalData,
      admissionCurrent: () => true,
    });
    await fixture.waitForIdle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("OCTANT_EXTERNAL_DATA");
    expect(seen[0]).toContain("invoice.txt");
    expect(fixture.projection.lookup(ids.request)?.prompt).toBe(startCommand().prompt);
  });
  it.each([false, true])(
    "refuses a host turn revoked while its file context is loading (native conversation: %s)",
    async (nativeConversation) => {
      const release = deferred<void>();
      const entered = deferred<void>();
      let current = true;
      const run = vi.fn<WorkTurnRuntimePort["run"]>().mockResolvedValue({
        kind: "completed",
        response: "Should not run",
      });
      const fixture = serviceFixture({
        nativeConversation,
        turnRuntime: { run },
        resolveFileMentionContext: async () => {
          entered.resolve();
          await release.promise;
          return [];
        },
      });
      const pending = fixture.service.startFirstTurn(
        ids.window,
        { ...startCommand(), fileMentionPaths: ["notes.md"] },
        { admissionCurrent: () => current },
      );
      const refused = expect(pending).rejects.toMatchObject({
        failure: { category: "unauthorized" },
      });
      await entered.promise;
      current = false;
      release.resolve();
      await refused;
      expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("counts a turn as starting while its context loads, so a compaction cannot slip in before it is accepted", async () => {
    const release = deferred<void>();
    const entered = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: vi.fn<WorkTurnRuntimePort["run"]>().mockResolvedValue({
          kind: "completed",
          response: "Done",
        }),
      },
      resolveFileMentionContext: async () => {
        entered.resolve();
        await release.promise;
        return [];
      },
    });
    expect(fixture.service.isTurnStarting(ids.thread)).toBe(false);
    const pending = fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      fileMentionPaths: ["notes.md"],
    });
    await entered.promise;
    expect(fixture.service.isTurnActive(ids.thread)).toBe(false);
    expect(fixture.service.isTurnStarting(ids.thread)).toBe(true);
    release.resolve();
    await expect(pending).resolves.toMatchObject({ kind: "accepted" });
    expect(fixture.service.isTurnStarting(ids.thread)).toBe(false);
  });

  it("fails an accepted host turn revoked during the model context probe without starting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-context-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        clock: () => now,
      });
      const release = deferred<void>();
      const entered = deferred<void>();
      let current = true;
      const run = vi.fn<WorkTurnRuntimePort["run"]>().mockResolvedValue({
        kind: "completed",
        response: "Should not run",
      });
      const close = vi.fn(async () => undefined);
      const fixture = serviceFixture({
        contextHarness,
        turnRuntime: { run },
        resolveAppManagedTools: () => ({
          definitions: [],
          execute: async () => ({ result: {} }),
          close,
        }),
        contextFacts: {
          observeModelLimits: () =>
            Effect.promise(async () => {
              entered.resolve();
              await release.promise;
              return [];
            }),
          observeServiceLimits: () =>
            Effect.succeed(
              unavailableProviderServiceLimits(
                decodeProviderInstanceId(ids.provider),
                now,
                "runtime-reported",
              ),
            ),
        },
      });
      await expect(
        fixture.service.startFirstTurn(ids.window, startCommand(), {
          admissionCurrent: () => current,
        }),
      ).resolves.toMatchObject({ kind: "accepted" });
      await entered.promise;
      current = false;
      release.resolve();
      await fixture.waitForIdle();
      expect(run).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(await fixture.service.lookupFirstTurn(ids.window, ids.request)).toMatchObject({
        kind: "accepted",
        turn: { status: "failed", failure: { category: "unauthorized" } },
      });
    } finally {
      connection.close();
    }
  });

  it("holds a goal-loop round ask-first on an auto-accept thread for as long as it runs", async () => {
    for (const accessCeiling of ["ask-first", "auto-accept-edits"] as const) {
      const release = deferred<void>();
      const seen: Array<string | undefined> = [];
      // The host hands the service the record the native harness reads.
      const runningAccess: RunningWorkTurnAccess = new Map();
      const fixture = serviceFixture({
        threadAccess: "auto-accept-edits",
        runningAccess,
        turnRuntime: {
          run: async (input) => {
            seen.push(
              input.access,
              fixture.service.runningTurnAccess(String(ids.thread)),
              runningAccess.get(String(ids.thread))?.access,
            );
            await release.promise;
            return { kind: "completed", response: "Done" };
          },
        },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand(), { accessCeiling });
      await vi.waitFor(() => expect(seen).toHaveLength(3));
      release.resolve();
      await fixture.waitForIdle();

      const expected = accessCeiling;
      // The provider session and the native harness's edit check both answer
      // to the round, not the thread.
      expect(seen).toEqual([expected, expected, expected]);
      expect(fixture.service.runningTurnAccess(String(ids.thread))).toBeUndefined();
      expect(runningAccess.has(String(ids.thread))).toBe(false);
    }
  });

  it("offers the runtime's artifact tool only to a thread that chose it, and keeps Canvas for the rest", async () => {
    const seen: Array<{ readonly nativeArtifacts: boolean; readonly context: string }> = [];
    for (const documentDelivery of [undefined, "canvas", "native-artifacts"] as const) {
      const fixture = serviceFixture({
        ...(documentDelivery === undefined ? {} : { documentDelivery }),
        resolveDriver: (_id, fallback) => ({ ...fallback, nativeArtifactTool: () => "Artifact" }),
        turnRuntime: {
          run: async (input) => {
            seen.push({
              nativeArtifacts: input.nativeArtifacts === true,
              context: JSON.stringify(input.context ?? []),
            });
            return { kind: "completed", response: "Done" };
          },
        },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
    }
    expect(seen.map((turn) => turn.nativeArtifacts)).toEqual([false, false, true]);
    expect(seen.map((turn) => turn.context.includes("publish that file with Artifact"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("does not announce a host-dispatched limit recovery as a person's turn request", async () => {
    const onTurnRequested = vi.fn();
    const fixture = serviceFixture({ onTurnRequested });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    expect(onTurnRequested).toHaveBeenCalledTimes(1);
    onTurnRequested.mockClear();
    await fixture.waitForIdle();

    await fixture.service.startFirstTurn(
      ids.window,
      {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"),
        turnId: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"),
      },
      { limitRecovery: true },
    );
    expect(onTurnRequested).not.toHaveBeenCalled();
    await fixture.waitForIdle(decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"));
  });

  it("journals a turn the host resumes as the system's, not an open window's", async () => {
    const fixture = serviceFixture();

    await fixture.service.startFirstTurn(ROUTINE_HOST_SCOPE_ID, startCommand(), {
      limitRecovery: true,
    });
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            eventName: "work.turn-accepted@1",
            actor: expect.objectContaining({ kind: "system" }),
          }),
        ],
      }),
    );
    await fixture.waitForIdle();
  });

  it("refuses a Work request that exceeds the provider-reported context window", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-context-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        clock: () => now,
      });
      const run = vi.fn(async () => ({ kind: "completed" as const, response: "Should not run" }));
      const close = vi.fn(async () => undefined);
      const fixture = serviceFixture({
        contextHarness,
        turnRuntime: { run },
        resolveAppManagedTools: () => ({
          definitions: [],
          execute: async () => ({ result: {} }),
          close,
        }),
        contextFacts: {
          observeModelLimits: () =>
            Effect.succeed([
              {
                providerInstanceId: decodeProviderInstanceId(ids.provider),
                modelId: decodeProviderModelId("model-a"),
                contextWindow: 60,
                maxOutput: 20,
                source: "runtime-reported",
                confidence: "high",
                observedAt: now,
              },
            ]),
          observeServiceLimits: () =>
            Effect.succeed(
              unavailableProviderServiceLimits(
                decodeProviderInstanceId(ids.provider),
                now,
                "runtime-reported",
              ),
            ),
        },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(run).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(await fixture.service.lookupFirstTurn(ids.window, ids.request)).toMatchObject({
        kind: "accepted",
        turn: { status: "failed", failure: { category: "invalid" } },
      });
    } finally {
      connection.close();
    }
  });

  it("publishes reported usage for a Work request that fits the model window", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-context-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        clock: () => now,
      });
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        const usage = decodeProviderRuntimeEvent({
          instanceId: ids.provider,
          sessionId: input.providerSessionId,
          sequence: 1,
          correlationId: ids.request,
          occurredAt: now,
          kind: "usage",
          inputTokens: 180,
          outputTokens: 8,
          contextTokens: 188,
          contextWindow: 1000,
        });
        if (usage.kind !== "usage") throw new Error("Expected usage fixture");
        input.onUsage?.(usage);
        return { kind: "completed" as const, response: "Ready" };
      });
      const close = vi.fn(async () => undefined);
      const fixture = serviceFixture({
        contextHarness,
        turnRuntime: { run },
        resolveAppManagedTools: () => ({
          definitions: [],
          execute: async () => ({ result: {} }),
          close,
        }),
        contextFacts: {
          observeModelLimits: () =>
            Effect.succeed([
              {
                providerInstanceId: decodeProviderInstanceId(ids.provider),
                modelId: decodeProviderModelId("model-a"),
                contextWindow: 1000,
                maxOutput: 20,
                source: "runtime-reported",
                confidence: "high",
                observedAt: now,
              },
            ]),
          observeServiceLimits: () =>
            Effect.succeed(
              unavailableProviderServiceLimits(
                decodeProviderInstanceId(ids.provider),
                now,
                "runtime-reported",
              ),
            ),
        },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(run).toHaveBeenCalledOnce();
      expect(
        contextHarness.inspect(
          decodeContextSubjectRef({
            aggregateType: "work-thread",
            aggregateId: String(ids.thread),
          }),
        ).latestUsage,
      ).toMatchObject({
        actualInputTokens: 180,
        actualOutputTokens: 8,
        contextTokens: 188,
        contextWindow: 1000,
      });
    } finally {
      connection.close();
    }
  });

  it("journals a compaction the runtime made by itself on the thread's context ledger, once per turn and place", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-context-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        clock: () => now,
      });
      const sighting = {
        position: 1,
        tokensBefore: { kind: "known", tokens: 900, accuracy: "provider-reported" },
      } as const;
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        input.onAutomaticCompaction?.(sighting);
        // The same compaction seen again, as a recovered stream would show it.
        input.onAutomaticCompaction?.(sighting);
        return { kind: "completed" as const, response: "Ready" };
      });
      const fixture = serviceFixture({ contextHarness, turnRuntime: { run } });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(run).toHaveBeenCalledOnce();
      const subject = decodeContextSubjectRef({
        aggregateType: "work-thread",
        aggregateId: String(ids.thread),
      });
      const runInput = run.mock.calls[0]?.[0];
      expect(contextHarness.latestCompaction(subject)).toMatchObject({
        status: "completed",
        receipt: {
          compactionId: automaticCompactionId(subject, String(runInput?.command.turnId), 1),
          trigger: "automatic",
          executor: {
            kind: "runtime",
            driverKind: runInput?.driver.kind,
            providerInstanceId: runInput?.command.authority.providerInstanceId,
            modelId: runInput?.command.authority.modelId,
          },
          tokensBefore: sighting.tokensBefore,
          summary: { visibility: "runtime-only" },
        },
      });
      expect(
        connection
          .prepare(
            `SELECT COUNT(*) AS count FROM event_journal
             WHERE aggregate_type = 'context-ledger' AND event_name LIKE 'context.compaction-%'`,
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      connection.close();
    }
  });

  it("records a Work turn once, at its latest usage report and the provider's cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-context-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        clock: () => now,
      });
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        const report = (sequence: number, fields: Record<string, number>) => {
          const usage = decodeProviderRuntimeEvent({
            instanceId: ids.provider,
            sessionId: input.providerSessionId,
            sequence,
            correlationId: ids.request,
            occurredAt: now,
            kind: "usage",
            contextWindow: 1000,
            ...fields,
          });
          if (usage.kind !== "usage") throw new Error("Expected usage fixture");
          input.onUsage?.(usage);
        };
        // One step's report, then the whole turn's, as a Claude turn reports.
        report(1, { inputTokens: 100, outputTokens: 4, contextTokens: 104 });
        report(2, { inputTokens: 180, outputTokens: 8, contextTokens: 188, costUsd: 0.0123 });
        return { kind: "completed" as const, response: "Ready" };
      });
      const close = vi.fn(async () => undefined);
      const fixture = serviceFixture({
        contextHarness,
        turnRuntime: { run },
        resolveAppManagedTools: () => ({
          definitions: [],
          execute: async () => ({ result: {} }),
          close,
        }),
        contextFacts: {
          observeModelLimits: () =>
            Effect.succeed([
              {
                providerInstanceId: decodeProviderInstanceId(ids.provider),
                modelId: decodeProviderModelId("model-a"),
                contextWindow: 1000,
                maxOutput: 20,
                source: "runtime-reported",
                confidence: "high",
                observedAt: now,
              },
            ]),
          observeServiceLimits: () =>
            Effect.succeed(
              unavailableProviderServiceLimits(
                decodeProviderInstanceId(ids.provider),
                now,
                "runtime-reported",
              ),
            ),
        },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(run).toHaveBeenCalledOnce();
      expect(
        connection
          .prepare(
            `SELECT input_tokens, output_tokens, cost_usd_micros, cost_kind
            FROM usage_record_projection WHERE subject_type = 'work-thread' AND subject_id = ?`,
          )
          .all(String(ids.thread)),
      ).toEqual([
        {
          input_tokens: 180,
          output_tokens: 8,
          cost_usd_micros: 12_300,
          cost_kind: "provider-recorded",
        },
      ]);
    } finally {
      connection.close();
    }
  });

  it("holds a Work turn while the session compacts, streams the receipt, and sends the summary next turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-compaction-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const uuid = () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid,
        clock: () => now,
      });
      const sent: Array<ReadonlyArray<{ readonly kind: string; readonly text: string }>> = [];
      const fixture = serviceFixture({
        contextHarness,
        turnRuntime: {
          run: async (input) => {
            sent.push(input.context ?? []);
            return { kind: "completed", response: "Provider reply" };
          },
        },
        contextFacts: {
          observeModelLimits: () =>
            Effect.succeed([
              {
                providerInstanceId: decodeProviderInstanceId(ids.provider),
                modelId: decodeProviderModelId("model-a"),
                contextWindow: 8_000,
                maxOutput: 200,
                source: "runtime-reported",
                confidence: "high",
                observedAt: now,
              },
            ]),
          observeServiceLimits: () =>
            Effect.succeed(
              unavailableProviderServiceLimits(
                decodeProviderInstanceId(ids.provider),
                now,
                "runtime-reported",
              ),
            ),
        },
      });
      // Each prompt is long enough that only the most recent turns fit the
      // tail, so the first exchange is what a compaction summarizes.
      const prompt = (n: number) => `Turn ${n}:${" brief detail".repeat(160)}`;
      const runTurn = async (n: number) => {
        const suffix = n.toString(16).padStart(12, "0");
        const requestId = decodeWorkTurnRequestId(`aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`);
        await fixture.service.startFirstTurn(ids.window, {
          ...startCommand(),
          requestId,
          turnId: decodeWorkTurnId(`bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`),
          prompt: prompt(n),
        });
        await fixture.waitForIdle(requestId);
      };
      for (let n = 1; n <= 4; n += 1) await runTurn(n);
      expect(sent.at(-1)?.some((block) => block.text === prompt(1))).toBe(true);

      const subject = decodeContextSubjectRef({
        aggregateType: "work-thread",
        aggregateId: String(ids.thread),
      });
      // A turn is not accepted while a compaction runs: its plan would fail the
      // compaction after the summary was paid for.
      const held = decodeContextCompactionId("83000000-0000-4000-8000-00000000c0d0");
      contextHarness.requestCompaction({
        subject,
        compactionId: held,
        executor: {
          kind: "host",
          providerInstanceId: decodeProviderInstanceId(ids.provider),
          modelId: decodeProviderModelId("model-a"),
        },
      });
      const sentBeforeHold = sent.length;
      await expect(
        fixture.service.startFirstTurn(ids.window, {
          ...startCommand(),
          requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff"),
          turnId: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-0000000000ff"),
          prompt: "Held while compacting",
        }),
      ).rejects.toMatchObject({
        failure: {
          category: "stale",
          message: "This session is being compacted. Send again when it finishes.",
        },
      });
      expect(sent).toHaveLength(sentBeforeHold);
      expect(fixture.service.isTurnActive(ids.thread)).toBe(false);
      contextHarness.failCompaction(subject, held, "summary-failed");
      const compaction = new SessionCompactionService({
        harness: contextHarness,
        threads: {
          // The same Work service calls the host wires for a Work thread.
          "work-thread": {
            read: () => ({
              mode: "work",
              projectId: String(ids.project),
              providerInstanceId: decodeProviderInstanceId(ids.provider),
              modelId: decodeProviderModelId("model-a"),
            }),
            turnRunning: (threadId) => fixture.service.isTurnActive(decodeWorkThreadId(threadId)),
            conversation: (threadId) =>
              fixture.service.sessionCompactionConversation(decodeWorkThreadId(threadId)),
            scratchRoot: async () => root,
            settled: (threadId, settled) =>
              fixture.service.compactionSettled(decodeWorkThreadId(threadId), settled),
          },
        },
        modeEnabled: () => true,
        conversationOwner: () => "host",
        providerFacts: () => ({
          provider: fixture.persistence.readProviderInstance(),
        }),
        availableDriver: () => summaryDriver("The brief's first turn set the launch scope."),
        capacity: makeProviderCapacityScheduler({
          now: () => Date.parse(now),
          random: () => 0,
          maxRetryJitterMs: 1_000,
          ambiguousReservationTtlMs: 60_000,
        }),
        uuid,
        summaryTimeoutMs: 1_000,
        summaryShutdownTimeoutMs: 50,
      });
      expect(compaction.inspect(subject, undefined, "local-window").compaction).toEqual({
        status: "available",
      });
      const listening = new AbortController();
      const frames: Array<WorkTurnStreamFrame> = [];
      const stream = (async () => {
        for await (const frame of fixture.service.subscribe(
          ids.window,
          ids.thread,
          fixture.service.liveCursor(ids.thread),
          listening.signal,
        )) {
          frames.push(frame);
        }
      })();
      compaction.start(
        {
          kind: "compact-session",
          subject,
          compactionId: decodeContextCompactionId("83000000-0000-4000-8000-00000000c0de"),
        },
        "local-window",
      );
      await compaction.settled();
      const completed = contextHarness.latestCompaction(subject);
      expect(completed).toMatchObject({
        status: "completed",
        receipt: { trigger: "requested", summary: { visibility: "stored" } },
      });
      // The receipt reaches the thread's live stream as the compaction ends.
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      listening.abort();
      await stream;
      expect(frames).toEqual([
        expect.objectContaining({
          kind: "compaction-settled",
          threadId: ids.thread,
          compaction: completed,
        }),
      ]);

      await runTurn(5);
      const next = sent.at(-1) ?? [];
      expect(next).toContainEqual({
        kind: "conversation-summary",
        text: expect.stringContaining("The brief's first turn set the launch scope."),
      });
      expect(next.some((block) => block.text === prompt(1))).toBe(false);
      expect(next.some((block) => block.text === prompt(4))).toBe(true);
    } finally {
      connection.close();
    }
  });

  describe("what a Work turn that did not complete leaves in the usage ledger", () => {
    type Run = Parameters<WorkTurnRuntimePort["run"]>[0];
    type Outcome = Awaited<ReturnType<WorkTurnRuntimePort["run"]>>;
    type Report = (fields: Record<string, number | string>) => void;

    /**
     * Runs one Work turn whose provider `script` reports usage, and returns the
     * ledger rows it left. `cancel` is resolved once the person has cancelled.
     */
    async function ledgerAfterTurn(
      script: (input: Run, report: Report, cancelled: Promise<void>) => Promise<Outcome>,
      options: { readonly cancel?: boolean } = {},
    ) {
      const root = await mkdtemp(join(tmpdir(), "octant-work-ledger-"));
      attachmentRoots.push(root);
      const connection = openSqlite(join(root, "context.sqlite3"));
      try {
        applyMigrations(connection, MIGRATIONS, () => now);
        const registries = createPhase1RuntimeRegistries();
        const journal = new Journal({
          connection,
          registry: registries.events,
          projections: registries.projections,
          clock: () => now,
        });
        let sequence = 0;
        const contextHarness = new ContextHarnessService({
          persistence: {
            connection,
            journal,
            status: () => ({ state: "current", integrity: "ok" }),
          },
          uuid: () => `84000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
          clock: () => now,
        });
        const cancelled = deferred<void>();
        const reachedScript = deferred<void>();
        const run = vi.fn(async (input: Run) => {
          let reportSequence = 0;
          const report: Report = (fields) => {
            const usage = decodeProviderRuntimeEvent({
              instanceId: ids.provider,
              sessionId: input.providerSessionId,
              sequence: ++reportSequence,
              correlationId: ids.request,
              occurredAt: now,
              kind: "usage",
              ...fields,
            });
            if (usage.kind !== "usage") throw new Error("Expected usage fixture");
            input.onUsage?.(usage);
          };
          reachedScript.resolve();
          return script(input, report, cancelled.promise);
        });
        const fixture = serviceFixture({
          contextHarness,
          turnRuntime: { run },
          contextFacts: {
            observeModelLimits: () =>
              Effect.succeed([
                {
                  providerInstanceId: decodeProviderInstanceId(ids.provider),
                  modelId: decodeProviderModelId("model-a"),
                  contextWindow: 1000,
                  maxOutput: 20,
                  source: "runtime-reported",
                  confidence: "high",
                  observedAt: now,
                },
              ]),
            observeServiceLimits: () =>
              Effect.succeed(
                unavailableProviderServiceLimits(
                  decodeProviderInstanceId(ids.provider),
                  now,
                  "runtime-reported",
                ),
              ),
          },
        });
        await fixture.service.startFirstTurn(ids.window, startCommand());
        if (options.cancel === true) {
          await reachedScript.promise;
          await fixture.service.cancelFirstTurn(ids.window, {
            kind: "cancel-work-turn",
            requestId: ids.request,
            threadId: ids.thread,
            turnId: ids.turn,
          });
          cancelled.resolve();
        }
        await fixture.waitForIdle();
        const rows = () =>
          connection
            .prepare(
              `SELECT input_tokens, output_tokens, quality, cost_usd_micros, cost_kind
              FROM usage_record_projection WHERE subject_type = 'work-thread' AND subject_id = ?`,
            )
            .all(String(ids.thread));
        // A cancel settles the turn before its provider run has unwound, so
        // the run's own end is what records the row.
        if (options.cancel === true) await vi.waitFor(() => expect(rows()).not.toEqual([]));
        return rows();
      } finally {
        connection.close();
      }
    }

    const priced = {
      input_tokens: 280,
      output_tokens: 12,
      cost_usd_micros: 30_000,
      cost_kind: "provider-recorded",
    };
    const failed = {
      kind: "failed" as const,
      failure: { category: "failed" as const, message: "Provider failed." },
    };

    it("records one row with the summed request estimates after a failure", async () => {
      const rows = await ledgerAfterTurn(async (input, report) => {
        input.onPromptSent?.();
        report({
          requestStartedAt: now,
          inputTokens: 148099,
          outputTokens: 165,
          estimatedCostUsd: 0.0298178,
        });
        report({
          requestStartedAt: now,
          inputTokens: 159911,
          outputTokens: 6,
          estimatedCostUsd: 0.0319894,
        });
        return failed;
      });
      expect(rows).toEqual([
        expect.objectContaining({
          input_tokens: 308010,
          output_tokens: 171,
          cost_usd_micros: 61807,
          cost_kind: "api-estimate",
        }),
      ]);
    });

    it("counts every request of a harness turn that failed before its total", async () => {
      const rows = await ledgerAfterTurn(async (input, report) => {
        input.onPromptSent?.();
        report({ requestStartedAt: now, inputTokens: 100, outputTokens: 4, costUsd: 0.01 });
        report({ requestStartedAt: now, inputTokens: 180, outputTokens: 8, costUsd: 0.02 });
        return failed;
      });
      expect(rows).toEqual([expect.objectContaining(priced)]);
    });

    it("counts every request of a harness turn that was cancelled", async () => {
      const rows = await ledgerAfterTurn(
        async (input, report, cancelled) => {
          input.onPromptSent?.();
          report({ requestStartedAt: now, inputTokens: 100, outputTokens: 4, costUsd: 0.01 });
          report({ requestStartedAt: now, inputTokens: 180, outputTokens: 8, costUsd: 0.02 });
          await cancelled;
          return { kind: "cancelled" };
        },
        { cancel: true },
      );
      expect(rows).toEqual([expect.objectContaining(priced)]);
    });

    it("charges a failed Claude turn its result's total", async () => {
      const rows = await ledgerAfterTurn(async (input, report) => {
        input.onPromptSent?.();
        // Claude reports the turn so far after each call, then its result.
        report({ inputTokens: 100, outputTokens: 4 });
        report({ inputTokens: 280, outputTokens: 12 });
        report({ inputTokens: 280, outputTokens: 12, costUsd: 0.03 });
        return failed;
      });
      expect(rows).toEqual([expect.objectContaining(priced)]);
    });

    it("charges a cancelled Claude turn the total its result reports after the abort", async () => {
      const rows = await ledgerAfterTurn(
        async (input, report, cancelled) => {
          input.onPromptSent?.();
          report({ inputTokens: 100, outputTokens: 4 });
          report({ inputTokens: 280, outputTokens: 12 });
          await cancelled;
          expect(input.signal.aborted).toBe(true);
          report({ inputTokens: 280, outputTokens: 12, costUsd: 0.03 });
          return { kind: "cancelled" };
        },
        { cancel: true },
      );
      expect(rows).toEqual([expect.objectContaining(priced)]);
    });

    it("records a turn that reached the provider and reported nothing as unreported and unpriced", async () => {
      const rows = await ledgerAfterTurn(async (input) => {
        input.onPromptSent?.();
        return failed;
      });
      expect(rows).toEqual([
        {
          input_tokens: 0,
          output_tokens: 0,
          quality: "unavailable",
          cost_usd_micros: null,
          cost_kind: null,
        },
      ]);
    });

    it("leaves no row for a turn that failed before it reached the provider", async () => {
      expect(await ledgerAfterTurn(async () => failed)).toEqual([]);
    });
  });

  it("keeps a Work turn completed when usage reconciliation refuses the report", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-context-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        clock: () => now,
      });
      vi.spyOn(contextHarness, "reconcileUsage").mockImplementation(() => {
        throw new ContextHarnessError("stale", "Usage must reconcile the current context plan.");
      });
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        const usage = decodeProviderRuntimeEvent({
          instanceId: ids.provider,
          sessionId: input.providerSessionId,
          sequence: 1,
          correlationId: ids.request,
          occurredAt: now,
          kind: "usage",
          inputTokens: 180,
          outputTokens: 8,
          contextTokens: 188,
          contextWindow: 1000,
        });
        if (usage.kind !== "usage") throw new Error("Expected usage fixture");
        input.onUsage?.(usage);
        return { kind: "completed" as const, response: "Ready" };
      });
      const fixture = serviceFixture({
        contextHarness,
        turnRuntime: { run },
        contextFacts: {
          observeModelLimits: () =>
            Effect.succeed([
              {
                providerInstanceId: decodeProviderInstanceId(ids.provider),
                modelId: decodeProviderModelId("model-a"),
                contextWindow: 1000,
                maxOutput: 20,
                source: "runtime-reported",
                confidence: "high",
                observedAt: now,
              },
            ]),
          observeServiceLimits: () =>
            Effect.succeed(
              unavailableProviderServiceLimits(
                decodeProviderInstanceId(ids.provider),
                now,
                "runtime-reported",
              ),
            ),
        },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(run).toHaveBeenCalledOnce();
      expect(await fixture.service.lookupFirstTurn(ids.window, ids.request)).toMatchObject({
        kind: "accepted",
        turn: { status: "completed" },
      });
    } finally {
      connection.close();
    }
  });

  it("records a completed Work turn with no provider usage as unreported", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-work-context-"));
    attachmentRoots.push(root);
    const connection = openSqlite(join(root, "context.sqlite3"));
    try {
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      let sequence = 0;
      const contextHarness = new ContextHarnessService({
        persistence: { connection, journal, status: () => ({ state: "current", integrity: "ok" }) },
        uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
        clock: () => now,
      });
      const reconcile = vi.spyOn(contextHarness, "reconcileUsage");
      const run = vi.fn(async () => ({ kind: "completed" as const, response: "Ready" }));
      const fixture = serviceFixture({
        contextHarness,
        turnRuntime: { run },
        contextFacts: {
          observeModelLimits: () =>
            Effect.succeed([
              {
                providerInstanceId: decodeProviderInstanceId(ids.provider),
                modelId: decodeProviderModelId("model-a"),
                contextWindow: 1000,
                maxOutput: 20,
                source: "runtime-reported",
                confidence: "high",
                observedAt: now,
              },
            ]),
          observeServiceLimits: () =>
            Effect.succeed(
              unavailableProviderServiceLimits(
                decodeProviderInstanceId(ids.provider),
                now,
                "runtime-reported",
              ),
            ),
        },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(run).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          actualInputTokens: 0,
          actualOutputTokens: 0,
          providerReported: false,
        }),
      );
      expect(await fixture.service.lookupFirstTurn(ids.window, ids.request)).toMatchObject({
        kind: "accepted",
        turn: { status: "completed" },
      });
    } finally {
      connection.close();
    }
  });

  it.each([false, true])(
    "refuses oversized tools even when cleanup fails: %s",
    async (cleanupFails) => {
      const run = vi.fn(async () => ({ kind: "completed" as const, response: "Should not run" }));
      const close = vi.fn(async () => {
        if (cleanupFails) throw new Error("Tool cleanup failed");
      });
      const fixture = serviceFixture({
        safeInputBudgetTokens: 500,
        turnRuntime: { run },
        resolveAppManagedTools: () => ({
          definitions: [
            { name: "large_tool", description: "x".repeat(8000), inputSchema: { type: "object" } },
          ],
          execute: async () => ({ result: {} }),
          close,
        }),
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(run).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
      expect(await fixture.service.lookupFirstTurn(ids.window, ids.request)).toMatchObject({
        kind: "accepted",
        turn: { status: "failed", failure: { category: "invalid" } },
      });
    },
  );

  it("refuses oversized native instructions before accepting or starting the Work turn", async () => {
    const run = vi.fn(async () => ({ kind: "completed" as const, response: "Should not run" }));
    const turnStarted = vi.fn();
    const fixture = serviceFixture({
      safeInputBudgetTokens: 500,
      turnRuntime: { run },
      nativeHarness: {
        contextFor: () => [{ kind: "instructions", text: "x".repeat(8000) }],
        turnStarted,
        turnCompleted: vi.fn(async () => undefined),
      },
    });
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toMatchObject({
      failure: { category: "invalid" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(turnStarted).not.toHaveBeenCalled();
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("hands what a Work turn cost and how it ran to the harness when it completes and when it ends", async () => {
    const summary: TurnEndSummary = {
      stopReason: "end-of-turn",
      startedAt: "2026-07-29T11:59:00.000Z",
      endedAt: "2026-07-29T11:59:30.000Z",
      usage: { inputTokens: 900, outputTokens: 50, cacheReadInputTokens: 700 },
      metrics: {
        precision: "approximate",
        wallMs: 30_000,
        timeToFirstTokenMs: 2_000,
        decodeOutputTokens: 50,
        decodeMs: 5_000,
        toolMs: 5_000,
        modelCalls: 1,
      },
    };
    const run = vi.fn<WorkTurnRuntimePort["run"]>(async (input) => {
      input.onTurnEnded?.(summary);
      return { kind: "completed", response: "Provider reply" };
    });
    const turnCompleted = vi.fn(async () => undefined);
    const turnEnded = vi.fn();
    const fixture = serviceFixture({
      turnRuntime: { run },
      nativeHarness: { contextFor: () => [], turnStarted: vi.fn(), turnCompleted, turnEnded },
    });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();

    expect(turnCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "work", text: "Provider reply", turn: summary }),
    );
    expect(turnEnded).toHaveBeenCalledWith(expect.objectContaining({ mode: "work" }), summary);
  });

  it.each(["provider", "completion"] as const)(
    "keeps cancellation and usage when it wins during %s settlement",
    async (stage) => {
      const ready = deferred<void>();
      const release = deferred<void>();
      const summary: TurnEndSummary = {
        stopReason: "end-of-turn",
        startedAt: "2026-07-29T11:59:00.000Z",
        endedAt: "2026-07-29T11:59:30.000Z",
        usage: { inputTokens: 900, outputTokens: 50 },
        metrics: { precision: "approximate", wallMs: 30_000, modelCalls: 1 },
      };
      const run = vi.fn<WorkTurnRuntimePort["run"]>(async (input) => {
        input.onTurnEnded?.(summary);
        if (stage === "provider") {
          ready.resolve();
          await release.promise;
        }
        return { kind: "completed", response: "Provider reply" };
      });
      const turnCompleted = vi.fn(async () => {
        if (stage === "completion") {
          ready.resolve();
          await release.promise;
        }
      });
      const turnEnded = vi.fn();
      const fixture = serviceFixture({
        turnRuntime: { run },
        nativeHarness: { contextFor: () => [], turnStarted: vi.fn(), turnCompleted, turnEnded },
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await ready.promise;
      expect(
        await fixture.service.cancelFirstTurn(ids.window, {
          kind: "cancel-work-turn",
          requestId: ids.request,
          threadId: ids.thread,
          turnId: ids.turn,
        }),
      ).toMatchObject({ kind: "turn-cancelled" });
      release.resolve();
      await fixture.waitForIdle();
      expect((await fixture.service.transcript(ids.window, ids.thread)).turns[0]?.status).toBe(
        "cancelled",
      );
      await vi.waitFor(() =>
        expect(turnEnded).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ mode: "work" }),
          {
            ...summary,
            stopReason: "cancelled",
          },
        ),
      );
      expect(turnCompleted).toHaveBeenCalledTimes(stage === "provider" ? 0 : 1);
    },
  );

  it("refuses a saved reasoning level that the model no longer declares before launching", async () => {
    const model = decodeProviderModel({
      id: "model-a",
      displayName: "Model",
      source: "discovered",
      verification: "verified",
      reasoning: "supported",
      inputModalities: ["text"],
      options: [{ kind: "selection", id: "effort", displayName: "Effort", values: ["low"] }],
    });
    const run = vi
      .fn<WorkTurnRuntimePort["run"]>()
      .mockResolvedValue({ kind: "completed", response: "unused" });
    const fixture = serviceFixture({ readProviderModel: () => model, turnRuntime: { run } });
    const current = await fixture.threads.read();
    fixture.threads.read.mockResolvedValue({ ...current, modelOptionValues: { effort: "high" } });
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toMatchObject({
      failure: { category: "invalid" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("runs a Work turn at its thread's level and records shell and Git at that level", async () => {
    const levels: Array<{
      readonly access: WorkAccess;
      readonly shell: string;
      readonly confinement: string;
    }> = [
      { access: "ask-first", shell: "guarded", confinement: "project-root-confined" },
      { access: "auto-accept-edits", shell: "guarded", confinement: "project-root-confined" },
      { access: "auto", shell: "provider-review", confinement: "project-root-confined" },
      { access: "full-access", shell: "full-access", confinement: "unconfined" },
    ];
    for (const level of levels) {
      const seen: Array<WorkAccess | undefined> = [];
      const fixture = serviceFixture({
        threadAccess: level.access,
        turnRuntime: {
          run: async (input) => {
            seen.push(input.access);
            return { kind: "completed", response: "Done" };
          },
        },
      });
      const result = await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") continue;
      expect(seen).toEqual([level.access]);
      expect(result.turn.capabilities).toMatchObject({
        shell: level.shell,
        git: level.shell,
        confinement: level.confinement,
        worktree: "denied",
        pullRequest: "denied",
        code: "denied",
      });
    }
  });

  it("never runs a turn above its caller's ceiling, a Full access thread included", async () => {
    const seen: Array<WorkAccess | undefined> = [];
    const fixture = serviceFixture({
      threadAccess: "full-access",
      turnRuntime: {
        run: async (input) => {
          seen.push(input.access);
          return { kind: "completed", response: "Done" };
        },
      },
    });
    const result = await fixture.service.startFirstTurn(ids.window, startCommand(), {
      accessCeiling: "auto-accept-edits",
    });
    await fixture.waitForIdle();
    expect(seen).toEqual(["auto-accept-edits"]);
    expect(result.kind === "accepted" && result.turn.capabilities.confinement).toBe(
      "project-root-confined",
    );
  });

  it("validates host, Project, binding, working directory, and confinement before launching", async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.startFirstTurn(ids.window, startCommand());
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.turn.capabilities.code).toBe("denied");
    expect(result.turn.transcript[0]).toEqual({
      role: "user",
      text: "Summarize the brief",
    });
    await fixture.waitForIdle();
    expect(fixture.acquireInputs[0]).toMatchObject({
      mode: "work",
      workRequest: {
        projectId: ids.project,
        threadId: ids.thread,
      },
    });
    const lookup = await fixture.service.lookupFirstTurn(ids.window, ids.request);
    expect(lookup).toMatchObject({
      kind: "accepted",
      turn: expect.objectContaining({
        status: "completed",
        response: "Provider reply",
      }),
    });
  });

  it("refuses a Work follow-up before native admission when its Project policy no longer accepts it", async () => {
    const admitTurn = vi.fn(() => ({
      kind: "paused" as const,
      status: "paused-by-advisor" as const,
      detail: "Policy should win before this admission.",
    }));
    const fixture = serviceFixture({
      project: {
        ...workProject(),
        providerPolicy: { mode: "eu-zdr", providerInstanceIds: [] },
      },
      nativeHarness: {
        admitTurn,
        contextFor: () => [],
        turnStarted: vi.fn(),
        turnCompleted: vi.fn(async () => undefined),
      },
    });

    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toEqual(
      new WorkTurnServiceError({
        category: "unauthorized",
        message:
          "This provider or model is not tagged EU or ZDR, so it is not allowed by this Project's provider policy.",
      }),
    );
    expect(admitTurn).not.toHaveBeenCalled();
    expect(fixture.acquireInputs).toHaveLength(0);
  });

  it("sends approved selected skill instructions to the Work provider", async () => {
    const contexts: Array<ReadonlyArray<{ readonly kind: string; readonly text: string }>> = [];
    const fixture = serviceFixture({
      resolveSelectedExtensions: async () => ({
        kind: "resolved",
        context: [{ kind: "instructions", text: "Use the synthetic Work checklist." }],
      }),
      turnRuntime: {
        run: async (input) => {
          contexts.push(input.context ?? []);
          return { kind: "completed", response: "Ready" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      extensionSelections: [
        {
          kind: "skill",
          skillId: `agents-skills-directory:project:review:sha256:${"a".repeat(64)}`,
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "review" },
        },
      ],
    });
    await fixture.waitForIdle();
    expect(contexts.flat()).toContainEqual({
      kind: "instructions",
      text: "Use the synthetic Work checklist.",
    });
  });

  it("refuses changed skill selections when a Work request is retried", async () => {
    const fixture = serviceFixture({
      resolveSelectedExtensions: async () => ({
        kind: "resolved",
        context: [{ kind: "instructions", text: "Synthetic review instructions." }],
      }),
    });
    const command = {
      ...startCommand(),
      extensionSelections: [
        {
          kind: "skill",
          skillId: `agents-skills-directory:project:review:sha256:${"a".repeat(64)}`,
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "review" },
        },
      ],
    };
    await fixture.service.startFirstTurn(ids.window, command);
    await fixture.waitForIdle();
    const replayed = new WorkTurnProjection();
    const accepted = fixture.persistence.journal.append.mock.calls[0]?.[0]?.events[0]?.payload;
    replayed.apply(decodeWorkTurnAccepted(accepted));
    expect(replayed.lookup(ids.request)?.extensionSelections).toEqual(command.extensionSelections);

    await expect(fixture.service.startFirstTurn(ids.window, command)).resolves.toMatchObject({
      kind: "accepted",
    });
    await expect(
      fixture.service.startFirstTurn(ids.window, { ...command, extensionSelections: [] }),
    ).rejects.toMatchObject({ failure: { category: "stale" } });
  });

  it("offers a selected MCP server's tools to the Work provider beside the host's own", async () => {
    const offered: Array<ReadonlyArray<string>> = [];
    const answers: Array<unknown> = [];
    const resolveSelectedExtensions = vi.fn<
      NonNullable<WorkTurnServiceDependencies["resolveSelectedExtensions"]>
    >(async () => ({
      kind: "resolved",
      context: [],
      tools: {
        definitions: [{ name: "notes_search", inputSchema: { type: "object" } }],
        execute: async () => ({ result: "framed notes" }),
      },
    }));
    const fixture = serviceFixture({
      resolveSelectedExtensions,
      resolveAppManagedTools: () => ({
        definitions: [{ name: "octant_browser", inputSchema: { type: "object" } }],
        execute: async () => ({ result: "browser" }),
      }),
      turnRuntime: {
        run: async (input) => {
          offered.push(input.appManagedTools?.definitions.map(({ name }) => name) ?? []);
          answers.push(
            await input.appManagedTools?.execute({ name: "notes_search", inputJson: "{}" }),
          );
          return { kind: "completed", response: "Ready" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      extensionSelections: [
        {
          kind: "plugin",
          extensionId: "94000000-0000-4000-8000-000000000011",
          packageId: "94000000-0000-4000-8000-000000000012",
          componentId: "notes-server",
          packageVersion: "1.0.0",
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "notes" },
        },
      ],
    });
    await fixture.waitForIdle();
    expect(resolveSelectedExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "work", windowId: ids.window }),
    );
    expect(offered).toEqual([["octant_browser", "notes_search"]]);
    expect(answers).toEqual([{ result: "framed notes" }]);
  });

  it("refuses selected skill instructions that exceed the Work input budget", async () => {
    const fixture = serviceFixture({
      safeInputBudgetTokens: 500,
      resolveSelectedExtensions: async () => ({
        kind: "resolved",
        context: [{ kind: "instructions", text: "Synthetic required instructions. ".repeat(1000) }],
      }),
    });
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        extensionSelections: [
          {
            kind: "skill",
            skillId: `agents-skills-directory:project:review:sha256:${"a".repeat(64)}`,
            packageDigest: `sha256:${"a".repeat(64)}`,
            catalogEpoch: `sha256:${"b".repeat(64)}`,
            origin: { kind: "draft", reference: "review" },
          },
        ],
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.acquireInputs).toHaveLength(0);
  });

  it("refuses an explicit skill before acceptance when no material resolver exists", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        extensionSelections: [
          {
            kind: "skill",
            skillId: `agents-skills-directory:project:review:sha256:${"a".repeat(64)}`,
            packageDigest: `sha256:${"a".repeat(64)}`,
            catalogEpoch: `sha256:${"b".repeat(64)}`,
            origin: { kind: "draft", reference: "review" },
          },
        ],
      }),
    ).rejects.toMatchObject({
      failure: {
        category: "unavailable",
        message: "Selected extension is unavailable for Work on this host.",
      },
    });
    expect(fixture.acquireInputs).toHaveLength(0);
  });

  it("ignores a Browser selection from an older draft and runs the Work turn", async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      extensionSelections: [browserUseSelection("work-test")],
    });
    expect(result.kind).toBe("accepted");
    await fixture.waitForIdle();
    const lookup = await fixture.service.lookupFirstTurn(ids.window, ids.request);
    expect(lookup).toMatchObject({ kind: "accepted", turn: { status: "completed" } });
  });
  it("settles the live stream when a refusal ends the turn before the provider runs", async () => {
    // A tool set too large for the input limit is refused after acceptance.
    const fixture = serviceFixture({
      safeInputBudgetTokens: 200,
      resolveAppManagedTools: () => ({
        definitions: [
          {
            name: "octant_browser",
            description: "x".repeat(4000),
            inputSchema: { type: "object" },
          },
        ],
        execute: async () => ({ result: {} }),
      }),
    });
    // A reader attached the way the view attaches: from the start of the thread,
    // before the refusal is written.
    const controller = new AbortController();
    const frames: string[] = [];
    const reader = (async () => {
      for await (const frame of fixture.service.subscribe(
        ids.window,
        ids.thread,
        0,
        controller.signal,
      )) {
        frames.push(frame.kind);
      }
    })();

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    await vi.waitFor(() => expect(frames).toContain("turn-settled"));
    controller.abort();
    await reader;
  });

  it("counts the Browser tool and its host line against a Work turn's input limit", async () => {
    const run = vi.fn(async () => ({ kind: "completed" as const, response: "Should not run" }));
    const browser = serviceFixture({
      safeInputBudgetTokens: 200,
      turnRuntime: { run },
      resolveAppManagedTools: () => ({
        definitions: [
          {
            name: "octant_browser",
            description: "x".repeat(4000),
            inputSchema: { type: "object" },
          },
        ],
        execute: async () => ({ result: {} }),
      }),
    });
    await expect(browser.service.startFirstTurn(ids.window, startCommand())).resolves.toMatchObject(
      { kind: "accepted" },
    );
    await browser.waitForIdle();
    await expect(browser.service.lookupFirstTurn(ids.window, ids.request)).resolves.toMatchObject({
      turn: { status: "failed", failure: { category: "invalid" } },
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("tells the agent about Browser in one host line whenever Work offers it, with no selection", async () => {
    const contexts: Array<ReadonlyArray<{ readonly kind: string; readonly text: string }>> = [];
    const fixture = serviceFixture({
      resolveAppManagedTools: () => ({
        definitions: [{ name: "octant_browser", inputSchema: { type: "object" } }],
        execute: async () => ({ result: {} }),
      }),
      turnRuntime: {
        run: async (input) => {
          contexts.push(input.context ?? []);
          return { kind: "completed", response: "Provider reply" };
        },
      },
    });
    const result = await fixture.service.startFirstTurn(ids.window, startCommand());
    expect(result.kind).toBe("accepted");
    await fixture.waitForIdle();
    expect(contexts.flat().filter((block) => block.text === BROWSER_TOOL_HOST_LINE)).toHaveLength(
      1,
    );
  });

  it("leaves Browser out of a Work turn's context when the turn does not offer it", async () => {
    const contexts: Array<ReadonlyArray<{ readonly kind: string; readonly text: string }>> = [];
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          contexts.push(input.context ?? []);
          return { kind: "completed", response: "Provider reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      extensionSelections: [browserUseSelection("work-without-browser")],
    });
    await fixture.waitForIdle();
    expect(JSON.stringify(contexts.flat())).not.toContain("octant_browser");
  });
  it("opens every task with the Project's status, and takes stock when the status is stale unless the request is unrelated", async () => {
    const contexts: Array<ReadonlyArray<ProviderContextBlock>> = [];
    const disk = new Map<string, string>([
      [
        "/private/tmp/knowledge/STATUS.md",
        "Last updated: 2026-07-01\n## Deadlines\n- 2026-08-01 Signed offer due\n",
      ],
    ]);
    const fixture = serviceFixture({
      project: workProject({ statusFile: "enabled" }),
      projectStatusFiles: inMemoryStatusFiles(disk),
      turnRuntime: {
        run: async (input) => {
          contexts.push(input.context ?? []);
          return { kind: "completed", response: "Provider reply" };
        },
      },
    });

    const result = await fixture.service.startFirstTurn(ids.window, startCommand());
    expect(result.kind).toBe("accepted");
    await fixture.waitForIdle();

    const sent = contexts.flat();
    expect(sent).toContainEqual({
      kind: "project-memory",
      key: "work-status-file",
      text: expect.stringContaining("Signed offer due"),
    });
    const standing = sent.find(
      (block) => block.kind === "instructions" && block.text.includes("STATUS.md"),
    );
    expect(standing?.text).toContain("When this turn changes where the work stands");
    expect(standing?.text).not.toContain("Take stock");
    const nudge = sent.find((block) => block.kind === "turn-instructions");
    expect(nudge?.text).toMatch(/not been updated for a while.*date has passed/);
    expect(nudge?.text).toContain("answer it first");
    expect(JSON.stringify(sent)).not.toContain("AGENTS.md");
  });

  it("takes stock only when a task opens, so later turns keep the same standing context", async () => {
    const contexts: Array<ReadonlyArray<ProviderContextBlock>> = [];
    const disk = new Map<string, string>([
      ["/private/tmp/knowledge/STATUS.md", "Last updated: 2026-07-01\n"],
    ]);
    const fixture = serviceFixture({
      project: workProject({ statusFile: "enabled" }),
      projectStatusFiles: inMemoryStatusFiles(disk),
      turnRuntime: {
        run: async (input) => {
          contexts.push(input.context ?? []);
          return { kind: "completed", response: "Provider reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac"),
      turnId: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc"),
      prompt: "Revise that",
    });
    await fixture.waitForIdle(decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac"));

    expect(contexts).toHaveLength(2);
    const [opening = [], later = []] = contexts;
    expect(opening.some((block) => block.kind === "turn-instructions")).toBe(true);
    expect(later.some((block) => block.kind === "turn-instructions")).toBe(false);
    expect(later.filter((block) => block.kind === "instructions")).toEqual(
      opening.filter((block) => block.kind === "instructions"),
    );
  });

  it("hands the runtime the Project's extra folders and names them to the agent", async () => {
    const seen: Array<{
      readonly extraFolders: ReadonlyArray<string> | undefined;
      readonly context: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
    }> = [];
    const fixture = serviceFixture({
      project: workProject({
        extraFolders: [
          {
            canonicalRoot: "/private/tmp/research",
            addedBy: {
              kind: "local-user",
              actorId: "72000000-0000-4000-8000-000000000009" as never,
            },
            addedAt: now as never,
          },
        ],
      }),
      turnRuntime: {
        run: async (input) => {
          seen.push({ extraFolders: input.extraFolders, context: input.context ?? [] });
          return { kind: "completed", response: "Provider reply" };
        },
      },
    });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();

    expect(seen[0]?.extraFolders).toEqual(["/private/tmp/research"]);
    const instruction = seen[0]?.context.find(
      (block) => block.kind === "instructions" && block.text.includes("extra folders"),
    );
    expect(instruction?.text).toContain("- /private/tmp/research");
    expect(instruction?.text).toContain("Commands, Git and checkouts start in the main folder");
  });

  it("carries no status instruction and writes no file in a Project that has not opted in", async () => {
    const contexts: Array<ReadonlyArray<{ readonly kind: string; readonly text: string }>> = [];
    // A STATUS.md left over from before the setting existed is not a signal to keep it.
    const leftover = "Last updated: 2026-07-01\n## Deadlines\n- 2026-08-01 Signed offer due\n";
    const disk = new Map<string, string>([["/private/tmp/knowledge/STATUS.md", leftover]]);
    const fixture = serviceFixture({
      projectStatusFiles: inMemoryStatusFiles(disk),
      turnFileObserver: {
        observe: () => ({ finish: () => ({ paths: ["offer.docx"], truncated: false }) }),
      } as never,
      turnRuntime: {
        run: async (input) => {
          contexts.push(input.context ?? []);
          return { kind: "completed", response: "Provider reply" };
        },
      },
    });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sent = contexts.flat();
    expect(sent.some((block) => block.text.includes("STATUS.md"))).toBe(false);
    expect(sent.some((block) => block.text.includes("Signed offer due"))).toBe(false);
    expect([...disk.entries()]).toEqual([["/private/tmp/knowledge/STATUS.md", leftover]]);
  });

  it("seeds STATUS.md and never AGENTS.md in a Project that opted in", async () => {
    const disk = new Map<string, string>();
    const fixture = serviceFixture({
      project: workProject({ statusFile: "enabled" }),
      projectStatusFiles: inMemoryStatusFiles(disk),
    });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();

    expect([...disk.keys()]).toEqual(["/private/tmp/knowledge/STATUS.md"]);
    expect(disk.get("/private/tmp/knowledge/STATUS.md")).toContain("Last updated: 2026-08-11");
  });

  it("records what a turn changed in STATUS.md when the turn left it untouched", async () => {
    const disk = new Map<string, string>([
      ["/private/tmp/knowledge/STATUS.md", "Last updated: 2026-08-11\n## Recent changes\n"],
    ]);
    const observer = {
      observe: () => ({
        finish: () => ({ paths: ["offer-v2.docx", "notes/call.md"], truncated: false }),
      }),
    };
    const fixture = serviceFixture({
      project: workProject({ statusFile: "enabled" }),
      projectStatusFiles: inMemoryStatusFiles(disk),
      turnFileObserver: observer as never,
    });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    // The backfill runs after the outcome is persisted; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(disk.get("/private/tmp/knowledge/STATUS.md")).toContain(
      "- 2026-08-11 Draft brief: `offer-v2.docx`, `notes/call.md`",
    );
  });

  it("leaves STATUS.md alone when the turn itself updated it", async () => {
    const written = "Last updated: 2026-08-11\n## Current status\nAgent wrote this.\n";
    const disk = new Map<string, string>([["/private/tmp/knowledge/STATUS.md", written]]);
    const fixture = serviceFixture({
      project: workProject({ statusFile: "enabled" }),
      projectStatusFiles: inMemoryStatusFiles(disk),
      turnFileObserver: {
        observe: () => ({
          finish: () => ({ paths: ["STATUS.md", "offer.docx"], truncated: false }),
        }),
      } as never,
    });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(disk.get("/private/tmp/knowledge/STATUS.md")).toBe(written);
  });

  it("tells a compaction when the thread's next turn would be refused for its Project or binding", async () => {
    const fixture = serviceFixture();
    const thread = decodeWorkThread({
      id: ids.thread,
      projectId: ids.project,
      title: "Draft brief",
      lifecycle: "active",
      providerInstanceId: ids.provider,
      modelId: "model-a",
      bindingRevisionId: ids.binding,
      workingDirectory: ".",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    // A thread that never took a turn has nothing a compaction could carry on.
    expect(fixture.service.turnStandingRefusal(thread)).toBeUndefined();

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    expect(fixture.service.turnStandingRefusal(thread)).toBeUndefined();

    fixture.persistence.readProject.mockReturnValue(workProject({ lifecycle: "archived" }));
    expect(fixture.service.turnStandingRefusal(thread)).toBe("project-unavailable");

    fixture.persistence.readProject.mockReturnValue(
      workProject({
        bindingHistory: [
          ...workProject().bindingHistory,
          {
            revisionId: "99999999-9999-4999-8999-999999999999" as never,
            revision: 2,
            currentBinding: { canonicalRoot: "/private/tmp/elsewhere" },
            actor: {
              kind: "local-user",
              actorId: "72000000-0000-4000-8000-000000000009" as never,
            },
            changedAt: now as never,
          },
        ],
      }),
    );
    expect(fixture.service.turnStandingRefusal(thread)).toBe("binding-changed");
    expect(fixture.service.turnStandingRefusal({ ...thread, lifecycle: "archived" })).toBe(
      "project-unavailable",
    );
  });

  it("preserves draft semantics by rejecting a stale binding without creating a turn", async () => {
    const fixture = serviceFixture({
      project: {
        ...workProject(),
        bindingHistory: [
          {
            revisionId: "99999999-9999-4999-8999-999999999999" as never,
            revision: 2,
            currentBinding: { canonicalRoot: "/private/tmp/knowledge" },
            actor: {
              kind: "local-user",
              actorId: "72000000-0000-4000-8000-000000000009" as never,
            },
            changedAt: now as never,
          },
        ],
      } as Project,
    });
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toEqual(
      new WorkTurnServiceError({
        category: "stale",
        message: "Work Project binding changed; reload and retry.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("keeps a supported stopped Work attempt addressable and force-stops only its exact identity", async () => {
    const gate = deferred<void>();
    const forced = vi.fn(async () => true);
    const runtime = {
      run: vi.fn(async () => {
        await gate.promise;
        return { kind: "cancelled" as const };
      }),
      canForceStop: (requestId: string) => requestId === String(ids.request),
      forceStop: forced,
    };
    const fixture = serviceFixture({ turnRuntime: runtime });
    const command = {
      kind: "force-stop-work-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
    };
    try {
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());
      await expect(fixture.service.cancelFirstTurn(ids.window, command)).rejects.toMatchObject({
        failure: { category: "invalid" },
      });
      expect(forced).not.toHaveBeenCalled();
      expect(
        await fixture.service.cancelFirstTurn(ids.window, { ...command, kind: "cancel-work-turn" }),
      ).toMatchObject({ kind: "stop-requested" });
      await expect(
        fixture.service.cancelFirstTurn(ids.window, {
          ...command,
          turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
        }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
      expect(await fixture.service.cancelFirstTurn(ids.window, command)).toMatchObject({
        kind: "turn-cancelled",
      });
      expect(forced).toHaveBeenCalledWith(String(ids.request));
    } finally {
      gate.resolve();
      await fixture.waitForIdle();
    }
  });

  it("releases the spend reservation when a Work turn is cancelled", async () => {
    const gate = deferred<void>();
    const settle = vi.fn();
    const admit = vi.fn().mockReturnValue({
      status: "admitted",
      reservedTokens: 100,
      reservations: [{ scopeKind: "thread", scopeId: String(ids.thread), reservedTokens: 100 }],
    });
    const fixture = serviceFixture({
      spendCeiling: { admit, settle },
      turnRuntime: {
        run: async (input) => {
          await gate.promise;
          if (input.signal.aborted) return { kind: "cancelled" };
          return { kind: "completed", response: "Provider reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    expect(admit).toHaveBeenCalledOnce();
    const cancelled = await fixture.service.cancelFirstTurn(ids.window, {
      kind: "cancel-work-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
    });
    expect(cancelled.kind).toBe("turn-cancelled");
    expect(settle).toHaveBeenCalledOnce();
    gate.resolve();
    await fixture.waitForIdle();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("releases the spend reservation when a Work turn fails at runtime", async () => {
    const settle = vi.fn();
    const admit = vi.fn().mockReturnValue({
      status: "admitted",
      reservedTokens: 100,
      reservations: [{ scopeKind: "thread", scopeId: String(ids.thread), reservedTokens: 100 }],
    });
    const fixture = serviceFixture({
      spendCeiling: { admit, settle },
      turnRuntime: {
        run: async () => ({
          kind: "failed",
          failure: { category: "unavailable", message: "provider died" },
        }),
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
    expect(admit).toHaveBeenCalledOnce();
  });

  it("releases the spend reservation when a Work turn fails to persist", async () => {
    const settle = vi.fn();
    const admit = vi.fn().mockReturnValue({
      status: "admitted",
      reservedTokens: 100,
      reservations: [{ scopeKind: "thread", scopeId: String(ids.thread), reservedTokens: 100 }],
    });
    const fixture = serviceFixture({
      spendCeiling: { admit, settle },
    });
    fixture.persistence.journal.append.mockImplementation(() => {
      throw new ConcurrencyConflict({
        aggregateType: "work-turn",
        aggregateId: String(ids.request),
        expectedVersion: 0,
        actualVersion: 1,
      });
    });
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toEqual(
      new WorkTurnServiceError({
        category: "stale",
        message: "Work turn already exists.",
      }),
    );
    expect(admit).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight turn and keeps the durable transcript recoverable", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onDelta?.("Partial reply");
          await gate.promise;
          input.onDelta?.("Late reply");
          if (input.signal.aborted) return { kind: "cancelled" };
          return { kind: "completed", response: "Partial reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const cancelled = await fixture.service.cancelFirstTurn(ids.window, {
      kind: "cancel-work-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
    });
    expect(cancelled.kind).toBe("turn-cancelled");
    gate.resolve();
    await fixture.waitForIdle();
    const transcript = await fixture.service.transcript(ids.window, ids.thread);
    expect(transcript.turns[0]?.status).toBe("cancelled");
    expect(transcript.liveCursor).toBe(2);
  });

  it("tells the host which thread a person stopped, once, and not for a turn that already ended", async () => {
    const gate = deferred<void>();
    const onTurnCancelled = vi.fn();
    const fixture = serviceFixture({
      onTurnCancelled,
      turnRuntime: {
        run: async (input) => {
          await gate.promise;
          return input.signal.aborted
            ? { kind: "cancelled" }
            : { kind: "completed", response: "Provider reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const cancel = {
      kind: "cancel-work-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
    };

    await fixture.service.cancelFirstTurn(ids.window, cancel);
    expect(onTurnCancelled).toHaveBeenCalledExactlyOnceWith(ids.thread);

    const again = await fixture.service.cancelFirstTurn(ids.window, cancel);
    expect(again.kind).toBe("turn-already-terminal");
    expect(onTurnCancelled).toHaveBeenCalledTimes(1);
    gate.resolve();
    await fixture.waitForIdle();
  });

  it("still cancels the turn when the host's cancellation listener throws", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      onTurnCancelled: () => {
        throw new Error("listener failed");
      },
      turnRuntime: {
        run: async () => {
          await gate.promise;
          return { kind: "cancelled" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());

    const cancelled = await fixture.service.cancelFirstTurn(ids.window, {
      kind: "cancel-work-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
    });

    expect(cancelled.kind).toBe("turn-cancelled");
    gate.resolve();
    await fixture.waitForIdle();
  });

  it("keeps the tool calls of a cancelled turn that wrote no file", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onDelta?.("Partial reply");
          input.onToolSteps?.({
            truncated: false,
            steps: [{ toolCallId: "call-1", toolName: "Read", state: "started" }],
          });
          await gate.promise;
          return { kind: "cancelled" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.service.cancelFirstTurn(ids.window, {
      kind: "cancel-work-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
    });
    gate.resolve();
    await fixture.waitForIdle();
    const turn = (await fixture.service.transcript(ids.window, ids.thread)).turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(turn?.toolSteps).toEqual([{ toolCallId: "call-1", toolName: "Read", state: "started" }]);
  });

  it("shows a window that opens mid-turn the tool calls already made", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onDelta?.("Partial");
          input.onToolSteps?.({
            truncated: false,
            steps: [{ toolCallId: "call-1", toolName: "Read", state: "running" }],
          });
          await gate.promise;
          return { kind: "completed", response: "Done" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const midTurn = (await fixture.service.transcript(ids.window, ids.thread)).turns[0];
    expect(midTurn?.toolSteps).toEqual([
      { toolCallId: "call-1", toolName: "Read", state: "running" },
    ]);
    gate.resolve();
    await fixture.waitForIdle();
  });

  it("does not publish a provider delta after a turn settled", async () => {
    let publishLateDelta: ((response: string) => void) | undefined;
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          publishLateDelta = input.onDelta;
          return { kind: "completed", response: "Complete" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    const settled = await fixture.service.transcript(ids.window, ids.thread);

    publishLateDelta?.("Late reply");
    const afterLateDelta = await fixture.service.transcript(ids.window, ids.thread);

    expect(afterLateDelta.liveCursor).toBe(settled.liveCursor);
  });

  it("sends a staged image to the provider and refuses a text-only model", async () => {
    const store = await attachmentStore();
    const attachmentId = decodeWorkAttachmentId("30000000-0000-4000-8000-000000000001");
    const bytes = new Uint8Array([137, 80, 78]);
    const sent: Array<ReadonlyArray<{ readonly attachmentId: string }>> = [];
    const fixture = serviceFixture({
      attachments: store,
      supportsAttachments: () => true,
      turnRuntime: {
        run: async (input) => {
          sent.push(input.attachments ?? []);
          return { kind: "completed", response: "Saw the mockup" };
        },
      },
    });
    await fixture.service.stageAttachment(ids.window, {
      threadId: ids.thread,
      attachmentId,
      displayName: "mockup.png",
      mediaType: "image/png",
      bytes,
    });

    const result = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      prompt: "Match this mockup",
      attachmentIds: [attachmentId],
    });
    expect(result.kind).toBe("accepted");
    await fixture.waitForIdle();
    expect(sent[0]?.[0]?.attachmentId).toBe(String(attachmentId));
    expect(sent[0]?.[0]).toMatchObject({ displayName: "mockup.png", mediaType: "image/png" });

    const refusedStore = await attachmentStore();
    const refusedId = decodeWorkAttachmentId("30000000-0000-4000-8000-000000000002");
    const refused = serviceFixture({
      attachments: refusedStore,
      supportsAttachments: () => false,
    });
    await refused.service.stageAttachment(ids.window, {
      threadId: ids.thread,
      attachmentId: refusedId,
      displayName: "mockup.png",
      mediaType: "image/png",
      bytes,
    });
    await expect(
      refused.service.startFirstTurn(ids.window, {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"),
        prompt: "Match this mockup",
        attachmentIds: [refusedId],
      }),
    ).rejects.toEqual(
      new WorkTurnServiceError({
        category: "unsupported",
        message:
          "The selected model does not support images. Choose a vision model, or remove the attachments.",
      }),
    );
    expect(refused.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("does not send a discarded image on a later turn", async () => {
    const store = await attachmentStore();
    const attachmentId = decodeWorkAttachmentId("30000000-0000-4000-8000-000000000003");
    const fixture = serviceFixture({
      attachments: store,
      supportsAttachments: () => true,
    });
    await fixture.service.stageAttachment(ids.window, {
      threadId: ids.thread,
      attachmentId,
      displayName: "mockup.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await fixture.service.discardAttachment(ids.window, ids.thread, attachmentId);
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        prompt: "Never mind the picture",
        attachmentIds: [attachmentId],
      }),
    ).rejects.toEqual(
      new WorkTurnServiceError({
        category: "invalid",
        message: "An image attached to this turn is no longer staged.",
      }),
    );
  });

  it("carries the prior transcript on a follow-up turn", async () => {
    const sent: Array<ReadonlyArray<{ readonly kind: string; readonly text: string }>> = [];
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          sent.push(input.context ?? []);
          return { kind: "completed", response: "Revised summary" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    const followUp = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac"),
      turnId: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc"),
      prompt: "Revise that",
    });
    expect(followUp.kind).toBe("accepted");
    await fixture.waitForIdle(decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac"));
    expect(sent[1]).toEqual([
      { kind: "instructions", text: expect.stringContaining("this task's folder") },
      { kind: "user-message", text: "Summarize the brief" },
      { kind: "assistant-message", text: "Revised summary" },
    ]);
  });

  it("refuses a turn whose mentioned files cannot fit the context budget", async () => {
    const fixture = serviceFixture({
      safeInputBudgetTokens: 500,
      resolveFileMentionContext: async () => [
        { kind: "user-message" as const, text: "a".repeat(8_000) },
      ],
    });
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        fileMentionPaths: ["notes.md"],
      }),
    ).rejects.toEqual(
      new WorkTurnServiceError({
        category: "invalid",
        message:
          "Work instructions, mentioned files, and prior context exceed the model's input budget. Remove a file mention or start a new thread.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("resumes durable transcript after reconnect through lookup and thread bootstrap", async () => {
    const fixture = serviceFixture();
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    const lookup = await fixture.service.lookupFirstTurn(ids.window, ids.request);
    const transcript = await fixture.service.transcript(ids.window, ids.thread);
    expect(lookup).toMatchObject({ kind: "accepted", turn: { status: "completed" } });
    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]?.transcript).toEqual([
      { role: "user", text: "Summarize the brief" },
      { role: "assistant", text: "Provider reply", status: "completed" },
    ]);
  });

  it("reads one authorized transcript without repeating the full Work bootstrap", async () => {
    const fixture = serviceFixture();
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    fixture.threads.bootstrap.mockClear();

    const transcript = await fixture.service.transcript(ids.window, ids.thread);

    expect(transcript.turns).toHaveLength(1);
    expect(fixture.threads.read).toHaveBeenCalledWith(ids.window, ids.thread);
    expect(fixture.threads.bootstrap).not.toHaveBeenCalled();
  });

  describe("a turn a host restart cut off", () => {
    const restartedAt = "2026-08-11T12:05:00.000Z";

    /** Replays what the first host journaled into a fresh host, as a start does. */
    function restart(
      before: ReturnType<typeof serviceFixture>,
      options: Parameters<typeof serviceFixture>[0] = {},
    ) {
      const after = serviceFixture(options);
      for (const [call] of before.persistence.journal.append.mock.calls) {
        const event = call?.events[0];
        if (event === undefined) continue;
        after.projection.apply(event.payload as never);
      }
      after.projection.markInterruptedOnRestart(restartedAt);
      return after;
    }

    async function streamingTurn(options: { readonly nativeConversation?: boolean } = {}) {
      const gate = deferred<void>();
      const before = serviceFixture({
        ...options,
        turnRuntime: {
          run: async (input) => {
            input.onDelta?.("Half a sent");
            await gate.promise;
            return { kind: "completed", response: "never" };
          },
        },
      });
      await before.service.startFirstTurn(ids.window, startCommand());
      return { before, release: gate.resolve };
    }

    it("settles as interrupted, not as a wait on the person", async () => {
      const { before, release } = await streamingTurn();
      const after = restart(before);
      release();

      expect(after.projection.lookup(ids.request)).toMatchObject({
        status: "failed",
        failure: {
          category: "interrupted",
          message: expect.stringContaining("Octant restarted"),
        },
        transcript: [{ role: "user" }, { role: "assistant", status: "interrupted" }],
      });
    });

    it("leaves the thread free to take the next message", async () => {
      const { before, release } = await streamingTurn();
      const run = vi.fn<WorkTurnRuntimePort["run"]>().mockResolvedValue({
        kind: "completed",
        response: "Picked up again",
      });
      const after = restart(before, { turnRuntime: { run } });
      release();
      expect(after.service.isTurnActive(ids.thread)).toBe(false);

      const next = decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
      await expect(
        after.service.startFirstTurn(ids.window, {
          ...startCommand(),
          requestId: next,
          turnId: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"),
          prompt: "Carry on",
        }),
      ).resolves.toMatchObject({ kind: "accepted" });
      await after.waitForIdle(next);

      expect(run).toHaveBeenCalledTimes(1);
      expect(after.projection.lookup(next)).toMatchObject({
        status: "completed",
        response: "Picked up again",
      });
    });

    it("starts a fresh session with the conversation when a native session never recorded a cursor", async () => {
      const { before, release } = await streamingTurn({ nativeConversation: true });
      const run = vi.fn<WorkTurnRuntimePort["run"]>().mockResolvedValue({
        kind: "completed",
        response: "Picked up in a new session",
      });
      const after = restart(before, { nativeConversation: true, turnRuntime: { run } });
      release();
      expect(after.projection.lookup(ids.request)?.resumeCursor).toBeUndefined();

      const next = decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3");
      await expect(
        after.service.startFirstTurn(ids.window, {
          ...startCommand(),
          requestId: next,
          turnId: decodeWorkTurnId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3"),
          prompt: "Carry on",
        }),
      ).resolves.toMatchObject({ kind: "accepted" });
      await after.waitForIdle(next);

      expect(run).toHaveBeenCalledTimes(1);
      expect(after.projection.lookup(next)).toMatchObject({
        status: "completed",
        handoff: { reason: "provider-switch", nativeSessionTransferred: false },
      });
    });

    it("reads the same after every rebuild", async () => {
      const { before, release } = await streamingTurn();
      const first = restart(before);
      const second = restart(before);
      release();
      first.projection.markInterruptedOnRestart("2026-08-11T12:09:00.000Z");

      expect(first.projection.lookup(ids.request)).toEqual(second.projection.lookup(ids.request));
    });

    it("keeps a stop at a usage limit waiting for its reset", async () => {
      const resetsAt = "2026-08-11T18:00:00.000Z" as UtcTimestamp;
      const before = serviceFixture({
        turnRuntime: {
          run: async () => ({
            kind: "waiting",
            failure: {
              category: "interrupted",
              message: "Usage limit reached.",
              usageLimit: { kind: "temporary", resetsAt },
            },
          }),
        },
      });
      await before.service.startFirstTurn(ids.window, startCommand());
      await before.waitForIdle();
      const after = restart(before);

      expect(after.projection.lookup(ids.request)).toMatchObject({
        status: "waiting",
        failure: { usageLimit: { resetsAt } },
      });
    });

    it("still offers only a resume for an approval it was parked on, and never runs the old call", async () => {
      const { before, release } = await streamingTurn();
      const directory = await mkdtemp(join(tmpdir(), "octant-work-restart-approval-"));
      attachmentRoots.push(directory);
      const connection = openSqlite(join(directory, "events.sqlite3"));
      try {
        applyMigrations(connection, MIGRATIONS, () => now);
        const open = () => {
          const sessions = new NativeHarnessSessionStore({
            journal: new Journal({
              connection,
              registry: registerNativeHarnessEvents(new EventRegistry()),
              projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
              clock: () => now,
            }),
            uuid: () => randomUUID(),
            actor: Schema.decodeUnknownSync(EventActor)({
              kind: "local-user",
              actorId: "77777777-7777-4777-8777-777777777777",
            }),
            clock: () => now,
          });
          return {
            sessions,
            approvals: new NativeHarnessApprovalStore({
              sessions,
              uuid: () => randomUUID(),
              clock: () => now,
            }),
          };
        };
        const parked = open();
        const outcome = parked.approvals.ask({
          threadId: String(ids.thread),
          mode: "work",
          lead: decodeNativeHarnessSlotCandidate({
            hostId: "00000000-0000-4000-8000-0000000000aa",
            providerInstanceId: ids.provider,
            modelId: "model-a",
          }),
          toolName: "write",
          summary: "write: notes.md",
          approvalClass: "file-writes",
        });
        const pendingId = String(parked.sessions.read(String(ids.thread))?.approvals?.[0]?.id);

        const after = restart(before);
        const stores = open();

        expect(after.service.isTurnActive(ids.thread)).toBe(false);
        expect(leadApprovalFor(stores, String(ids.thread))).toMatchObject({ lostInRestart: true });
        expect(stores.approvals.decide(String(ids.thread), pendingId, "approve")).toBe(
          "lost-in-restart",
        );
        expect(stores.sessions.read(String(ids.thread))?.approvals?.[0]?.status).toBe("cancelled");
        void outcome;
        release();
      } finally {
        connection.close();
      }
    });
  });

  describe("a thread with more turns than one transcript carries", () => {
    it("serves the newest 64 turns of a 65-turn thread, oldest first", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 65);

      const transcript = await fixture.service.transcript(ids.window, ids.thread);

      expect(transcript.turns).toHaveLength(64);
      expect(transcript.turns.map((turn) => turn.prompt)).toEqual(
        Array.from({ length: 64 }, (_, index) => `Prompt ${index + 2}`),
      );
      expect(transcript.turns.at(-1)?.prompt).toBe("Prompt 65");
    });

    it("answers the transcript route for a 65-turn thread with a body the unchanged decoder reads", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 65);
      const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const store = new WindowAuthorityStore();
      store.register({ windowId: ids.window, capability, now: 0 });
      const route = createWorkTurnRouteHandler({
        service: fixture.service,
        windowAuthorityStore: store,
        now: () => 1,
      });

      const response = await route(
        new Request(`http://127.0.0.1/api/work/turns/transcript/${ids.thread}`, {
          headers: { "x-octant-window-capability": capability },
        }),
      );

      expect(response?.status).toBe(200);
      const body = decodeWorkThreadTranscript(await response!.json());
      expect(body.turns).toHaveLength(64);
      expect(body.turns.at(-1)?.prompt).toBe("Prompt 65");
    });

    it("lets the host read every turn of the thread, oldest first", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 65);

      const turns = await fixture.service.turns(ids.window, ids.thread);

      expect(turns.map((turn) => turn.prompt)).toEqual(
        Array.from({ length: 65 }, (_, index) => `Prompt ${index + 1}`),
      );
    });

    it("resolves a #thread mention of the thread from the host-wide read", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 65);
      const directory = createWorkThreadMentionDirectory({
        bootstrap: async () => ({ threads: [] }),
        transcript: async (windowId, threadId) => ({
          turns: await fixture.service.turns(windowId, threadId),
        }),
      });

      const entries = await directory.readTranscript(
        ids.window,
        decodeMentionableThreadId(String(ids.thread)),
      );

      expect(entries).toHaveLength(130);
      expect(entries?.at(-2)).toMatchObject({ role: "user", text: "Prompt 65" });
    });

    it("refuses both reads for a window that cannot read the thread", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 2);
      fixture.threads.read.mockResolvedValue(undefined as never);

      await expect(fixture.service.transcript(ids.window, ids.thread)).rejects.toMatchObject({
        failure: { category: "unauthorized" },
      });
      await expect(fixture.service.turns(ids.window, ids.thread)).rejects.toMatchObject({
        failure: { category: "unauthorized" },
      });
    });

    it("opens a long Work thread on its newest turns", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 65);

      const window = await fixture.service.transcriptWindow(ids.window, ids.thread, { limit: 30 });

      expect(window.version).toBe(1);
      expect(window.turns.map((turn) => turn.prompt)).toEqual(
        Array.from({ length: 30 }, (_, index) => `Prompt ${index + 36}`),
      );
      expect(window.hasEarlier).toBe(true);
      expect(window.hasLater).toBe(false);
    });

    it("returns the turns before a named turn and says whether more remain", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 65);
      const newest = await fixture.service.transcriptWindow(ids.window, ids.thread, { limit: 30 });

      const middle = await fixture.service.transcriptWindow(ids.window, ids.thread, {
        limit: 30,
        before: newest.turns[0]!.requestId,
      });
      expect(middle.turns.map((turn) => turn.prompt)).toEqual(
        Array.from({ length: 30 }, (_, index) => `Prompt ${index + 6}`),
      );
      expect(middle.hasEarlier).toBe(true);
      expect(middle.hasLater).toBe(true);

      const oldest = await fixture.service.transcriptWindow(ids.window, ids.thread, {
        limit: 30,
        before: middle.turns[0]!.requestId,
      });
      expect(oldest.turns.map((turn) => turn.prompt)).toEqual([
        "Prompt 1",
        "Prompt 2",
        "Prompt 3",
        "Prompt 4",
        "Prompt 5",
      ]);
      expect(oldest.hasEarlier).toBe(false);
      expect(oldest.hasLater).toBe(true);
    });

    it("refuses a window anchored on a turn the thread does not hold", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 3);

      await expect(
        fixture.service.transcriptWindow(ids.window, ids.thread, {
          limit: 30,
          before: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-ffffffffffff"),
        }),
      ).rejects.toMatchObject({ failure: { category: "stale" } });
    });

    it("refuses a Work window for a window that cannot read the thread", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 2);
      fixture.threads.read.mockResolvedValue(undefined as never);

      await expect(
        fixture.service.transcriptWindow(ids.window, ids.thread, { limit: 30 }),
      ).rejects.toMatchObject({ failure: { category: "unauthorized" } });
    });

    it("stops a window short of its limit once its encoded turns pass the page budget", async () => {
      const fixture = serviceFixture();
      // Projected directly: a provider turn this size would not pass the
      // input budget, but a thread can still hold many large turns.
      const long = "x".repeat(60_000);
      const command = startCommand();
      for (let n = 1; n <= 40; n += 1) {
        const suffix = n.toString(16).padStart(12, "0");
        fixture.projection.apply(
          decodeWorkTurnAccepted({
            kind: "turn-accepted",
            requestId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
            threadId: ids.thread,
            turnId: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
            projectId: command.authority.projectId,
            authority: command.authority,
            providerSessionId: `cccccccc-cccc-4ccc-8ccc-${suffix}`,
            prompt: `${String(n)} ${long}`,
            capabilities: {
              workspace: "project-backed",
              confinement: "project-root-confined",
              shell: "denied",
              git: "denied",
              worktree: "denied",
              pullRequest: "denied",
              code: "denied",
            },
            acceptedAt: "2026-10-14T08:00:00.000Z",
          }),
        );
      }

      const window = await fixture.service.transcriptWindow(ids.window, ids.thread, { limit: 64 });

      expect(window.turns.length).toBeGreaterThan(0);
      expect(window.turns.length).toBeLessThan(40);
      expect(window.turns.at(-1)?.prompt.startsWith("40 ")).toBe(true);
      expect(window.hasEarlier).toBe(true);
      const bytes = window.turns.reduce(
        (total, turn) => total + new TextEncoder().encode(JSON.stringify(turn)).byteLength,
        0,
      );
      expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    });

    it("serves a 64-turn thread whole from both reads", async () => {
      const fixture = serviceFixture();
      await settleTurns(fixture, 64);

      const transcript = await fixture.service.transcript(ids.window, ids.thread);
      const turns = await fixture.service.turns(ids.window, ids.thread);

      expect(transcript.turns).toHaveLength(64);
      expect(transcript.turns.at(0)?.prompt).toBe("Prompt 1");
      expect(turns).toEqual(transcript.turns);
    });
  });

  it("streams response deltas immediately and settles through a cursor-safe frame", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onDelta?.("Partial");
          input.onDelta?.("Partial reply");
          await gate.promise;
          return { kind: "completed", response: "Partial reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const controller = new AbortController();
    const stream = fixture.service.subscribe(ids.window, ids.thread, 0, controller.signal);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "response-delta", sequence: 1, text: "Partial" },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "response-delta", sequence: 2, text: " reply" },
    });

    gate.resolve();
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "turn-settled", sequence: 3, turn: { status: "completed" } },
    });
    const transcript = await fixture.service.transcript(ids.window, ids.thread);
    expect(transcript.liveCursor).toBe(3);
    controller.abort();
  });

  it("tells live subscribers once when a retried response arrives without text", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          const retrying = decodeProviderRuntimeEvent({
            kind: "retrying",
            instanceId: ids.provider,
            sessionId: input.providerSessionId,
            sequence: 1,
            correlationId: String(ids.request),
            occurredAt: now,
            attempt: 2,
            maxAttempts: 5,
            delayMs: 500,
            reason: "unavailable",
          });
          if (retrying.kind === "retrying") input.onRetrying?.(retrying);
          // A tool call, then the text after it, both end the same wait.
          input.onRetryCleared?.();
          input.onRetryCleared?.();
          await gate.promise;
          return { kind: "completed", response: "Done" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const controller = new AbortController();
    const stream = fixture.service.subscribe(ids.window, ids.thread, 0, controller.signal);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "provider-retry", sequence: 1, requestId: ids.request, attempt: 2 },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "provider-retry-cleared", sequence: 2, requestId: ids.request },
    });
    gate.resolve();
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "turn-settled", sequence: 3 },
    });
    controller.abort();
  });

  it("publishes the provider's task list live and journals it with the settled turn", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onDelta?.("Partial");
          const report = decodeProviderRuntimeEvent({
            kind: "child-agent-activity",
            instanceId: ids.provider,
            sessionId: input.providerSessionId,
            sequence: 1,
            correlationId: String(ids.request),
            occurredAt: now,
            childAgentId: "observed-child",
            status: "running",
            summary: "Reading",
          });
          if (report.kind === "child-agent-activity") input.onChildActivity?.(report);
          input.onTasks?.([{ taskId: "task-1", state: "running", summary: "Watch CI" }]);
          await gate.promise;
          input.onTasks?.([
            { taskId: "task-1", state: "completed", summary: "Watch CI" },
            { taskId: "task-2", state: "pending", summary: "Commit the evidence" },
          ]);
          return { kind: "completed", response: "Partial reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const controller = new AbortController();
    const stream = fixture.service.subscribe(ids.window, ids.thread, 0, controller.signal);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "response-delta", sequence: 1, text: "Partial" },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "turn-tasks", sequence: 2, requestId: ids.request },
    });
    gate.resolve();
    // The settled turn carries the newest list, so a subscriber that re-reads
    // the transcript after reconnect sees the same plan the live feed showed.
    let settled: { readonly kind: string; readonly turn?: { readonly tasks?: unknown } };
    for (;;) {
      const next = await stream.next();
      const frame = next.value as {
        readonly kind: string;
        readonly turn?: { readonly tasks?: unknown };
      };
      if (frame.kind === "turn-settled") {
        settled = frame;
        break;
      }
    }
    expect(settled.turn?.tasks).toEqual([
      { taskId: "task-1", state: "completed", summary: "Watch CI" },
      { taskId: "task-2", state: "pending", summary: "Commit the evidence" },
    ]);
    const transcript = await fixture.service.transcript(ids.window, ids.thread);
    expect(transcript.turns[0]?.childObservations?.children).toMatchObject([
      { childAgentId: "observed-child", historyStatus: "partial" },
    ]);
    const settledTurn = transcript.turns.at(-1);
    expect(settledTurn?.tasks).toEqual([
      { taskId: "task-1", state: "completed", summary: "Watch CI" },
      { taskId: "task-2", state: "pending", summary: "Commit the evidence" },
    ]);
    controller.abort();
  });

  it("publishes the turn's tool calls live and journals them with the settled turn", async () => {
    const gate = deferred<void>();
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onDelta?.("Partial");
          input.onToolSteps?.({
            truncated: false,
            steps: [{ toolCallId: "call-1", toolName: "Read", state: "started" }],
          });
          await gate.promise;
          input.onToolSteps?.({
            truncated: false,
            steps: [
              { toolCallId: "call-1", toolName: "Read", state: "completed", summary: "notes.md" },
            ],
          });
          return { kind: "completed", response: "Partial reply" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const controller = new AbortController();
    const stream = fixture.service.subscribe(ids.window, ids.thread, 0, controller.signal);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "response-delta", sequence: 1 },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "turn-tools", sequence: 2, requestId: ids.request },
    });
    gate.resolve();
    for (;;) {
      const next = await stream.next();
      if ((next.value as { readonly kind: string }).kind === "turn-settled") break;
    }
    // A reconnecting client re-reads the transcript and sees the same steps.
    const settledTurn = (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1);
    expect(settledTurn?.toolSteps).toEqual([
      { toolCallId: "call-1", toolName: "Read", state: "completed", summary: "notes.md" },
    ]);
    controller.abort();
  });

  it("streams a published page's link live and keeps its snapshot for the settled turn", async () => {
    const gate = deferred<void>();
    const published = {
      url: "https://claude.ai/artifact/0f1e2d3c",
      title: "Notes",
      snapshot: { format: "markdown" as const, content: "# Notes" },
    };
    const publish = {
      toolCallId: "call-1",
      toolName: "Artifact",
      state: "completed" as const,
      published,
    };
    const fixture = serviceFixture({
      turnRuntime: {
        run: async (input) => {
          input.onToolSteps?.({ truncated: false, steps: [publish] });
          input.onToolSteps?.({
            truncated: false,
            steps: [publish, { toolCallId: "call-2", toolName: "Read", state: "started" }],
          });
          await gate.promise;
          return { kind: "completed", response: "Published" };
        },
      },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    const controller = new AbortController();
    const stream = fixture.service.subscribe(ids.window, ids.thread, 0, controller.signal);
    const live: unknown[] = [];
    for (;;) {
      const frame = (await stream.next()).value as {
        readonly kind: string;
        readonly toolSteps?: unknown;
      };
      if (frame.kind !== "turn-tools") continue;
      live.push(frame.toolSteps);
      if (live.length === 2) break;
    }
    // Every step change restates the whole list, so a snapshot carried live
    // would be resent, and held in the feed, once per later tool event.
    expect(JSON.stringify(live)).not.toContain("# Notes");
    expect(JSON.stringify(live)).toContain(published.url);
    const running = (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1);
    expect(JSON.stringify(running?.toolSteps)).not.toContain("# Notes");
    gate.resolve();
    await fixture.waitForIdle();
    const settledTurn = (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1);
    expect(settledTurn?.toolSteps?.[0]?.published).toEqual(published);
    controller.abort();
  });

  it.each([true, false])(
    "keeps native Work follow-ups without replay when the provider repeats its cursor: %s",
    async (repeatsCursor) => {
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        input.onSessionReady?.({
          sessionId: input.providerSessionId,
          ...(input.resumeCursor === undefined || repeatsCursor
            ? { resumeCursor: { driverKind: "pi" as const, value: "native-work" } }
            : {}),
        });
        return { kind: "completed" as const, response: "Private earlier response" };
      });
      const fixture = serviceFixture({ nativeConversation: true, turnRuntime: { run } });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      const first = run.mock.calls[0]?.[0];
      await fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
        prompt: "Continue",
      });
      await fixture.waitForIdle();
      const transcript = await fixture.service.transcript(ids.window, ids.thread);
      expect(transcript.turns.at(-1)?.status).toBe("completed");
      expect(run.mock.calls[1]?.[0]).toMatchObject({
        providerSessionId: first?.providerSessionId,
        resumeCursor: { driverKind: "pi", value: "native-work" },
      });
      expect(JSON.stringify(run.mock.calls[1]?.[0].context)).not.toContain(
        "Private earlier response",
      );
      expect(JSON.stringify(run.mock.calls[1]?.[0].context)).not.toContain("Summarize the brief");
      const third = await fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
        turnId: decodeWorkTurnId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
        prompt: "Continue again",
      });
      expect(third.kind).toBe("accepted");
      await fixture.waitForIdle();
      expect(run.mock.calls[2]?.[0]).toMatchObject({
        providerSessionId: first?.providerSessionId,
        resumeCursor: { driverKind: "pi", value: "native-work" },
      });
    },
  );

  it.each([
    ["completed", true],
    ["cancelled", true],
    ["failed", false],
  ] as const)(
    "continues a host-resumable Work session after a %s turn only when it ended cleanly or was cancelled",
    async (ending, continues) => {
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        input.onSessionReady?.({
          sessionId: input.providerSessionId,
          resumeCursor: {
            driverKind: "openai-compatible" as const,
            value: String(input.providerSessionId),
          },
        });
        if (run.mock.calls.length === 1 && ending === "cancelled") {
          return { kind: "cancelled" as const };
        }
        if (run.mock.calls.length === 1 && ending === "failed") {
          return {
            kind: "failed" as const,
            failure: { category: "unavailable" as const, message: "The endpoint stopped." },
          };
        }
        return { kind: "completed" as const, response: "Earlier harness reply" };
      });
      const fixture = serviceFixture({
        turnRuntime: { run },
        resolveDriver: (_id, fallback) => ({
          ...fallback,
          conversationOwnership: "host-resumable",
        }),
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      await fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
        prompt: "Continue",
      });
      await fixture.waitForIdle();
      const first = run.mock.calls[0]?.[0];
      const second = run.mock.calls[1]?.[0];
      if (continues) {
        expect(second).toMatchObject({
          providerSessionId: first?.providerSessionId,
          resumeCursor: {
            driverKind: "openai-compatible",
            value: String(first?.providerSessionId),
          },
        });
        expect(JSON.stringify(second?.context)).not.toContain("Summarize the brief");
      } else {
        expect(second?.providerSessionId).not.toBe(first?.providerSessionId);
        expect(second?.resumeCursor).toBeUndefined();
        expect(JSON.stringify(second?.context)).toContain("Summarize the brief");
      }
    },
  );

  describe("a host-resumable Work session", () => {
    /** Reports a durable session the next turn can resume, as Octant Harness does. */
    const resumableRun = (sent: Array<Parameters<WorkTurnRuntimePort["run"]>[0]>) =>
      vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        sent.push(input);
        input.onSessionReady?.({
          sessionId: input.providerSessionId,
          resumeCursor: {
            driverKind: "openai-compatible" as const,
            value: String(input.providerSessionId),
          },
        });
        return { kind: "completed" as const, response: "Provider reply" };
      });
    const resumable = (_id: unknown, fallback: ProviderDriver): ProviderDriver => ({
      ...fallback,
      conversationOwnership: "host-resumable",
    });
    const prompt = (n: number, words: number) => `Turn ${n}:${" brief detail".repeat(words)}`;
    async function runTurns(
      fixture: ReturnType<typeof serviceFixture>,
      count: number,
      words: number,
    ): Promise<void> {
      for (let n = 1; n <= count; n += 1) {
        const suffix = n.toString(16).padStart(12, "0");
        const requestId = decodeWorkTurnRequestId(`aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`);
        await fixture.service.startFirstTurn(ids.window, {
          ...startCommand(),
          requestId,
          turnId: decodeWorkTurnId(`bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`),
          prompt: prompt(n, words),
        });
        await fixture.waitForIdle(requestId);
      }
    }

    it("lets a person compact a long conversation the session continued", async () => {
      const root = await mkdtemp(join(tmpdir(), "octant-work-resumable-"));
      attachmentRoots.push(root);
      const connection = openSqlite(join(root, "context.sqlite3"));
      try {
        applyMigrations(connection, MIGRATIONS, () => now);
        const registries = createPhase1RuntimeRegistries();
        const journal = new Journal({
          connection,
          registry: registries.events,
          projections: registries.projections,
          clock: () => now,
        });
        let sequence = 0;
        const contextHarness = new ContextHarnessService({
          persistence: {
            connection,
            journal,
            status: () => ({ state: "current", integrity: "ok" }),
          },
          uuid: () => `83000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
          clock: () => now,
        });
        const sent: Array<Parameters<WorkTurnRuntimePort["run"]>[0]> = [];
        const fixture = serviceFixture({
          contextHarness,
          turnRuntime: { run: resumableRun(sent) },
          resolveDriver: resumable,
          contextFacts: {
            observeModelLimits: () =>
              Effect.succeed([
                {
                  providerInstanceId: decodeProviderInstanceId(ids.provider),
                  modelId: decodeProviderModelId("model-a"),
                  contextWindow: 8_000,
                  maxOutput: 200,
                  source: "runtime-reported",
                  confidence: "high",
                  observedAt: now,
                },
              ]),
            observeServiceLimits: () =>
              Effect.succeed(
                unavailableProviderServiceLimits(
                  decodeProviderInstanceId(ids.provider),
                  now,
                  "runtime-reported",
                ),
              ),
          },
        });
        await runTurns(fixture, 4, 160);
        // The premise: every turn continued the one session, which was never
        // sent the earlier turns again.
        expect(new Set(sent.map((input) => String(input.providerSessionId))).size).toBe(1);
        expect(sent.at(-1)?.context?.some((block) => block.text === prompt(1, 160))).toBe(false);
        expect(
          contextHarness.previewSessionCompaction({
            subject: decodeContextSubjectRef({
              aggregateType: "work-thread",
              aggregateId: String(ids.thread),
            }),
            providerInstanceId: decodeProviderInstanceId(ids.provider),
            modelId: decodeProviderModelId("model-a"),
            conversation: fixture.service.sessionCompactionConversation(ids.thread),
          }),
        ).toMatchObject({ kind: "summarize" });
      } finally {
        connection.close();
      }
    });

    it("rebuilds the history in a fresh session once the earlier turns no longer fit", async () => {
      const sent: Array<Parameters<WorkTurnRuntimePort["run"]>[0]> = [];
      const fixture = serviceFixture({
        safeInputBudgetTokens: 1_000,
        turnRuntime: { run: resumableRun(sent) },
        resolveDriver: resumable,
      });
      await runTurns(fixture, 3, 100);
      const [first, second, third] = sent;
      // Two turns fit and the second continues the first one's session.
      expect(String(second?.providerSessionId)).toBe(String(first?.providerSessionId));
      // The third does not fit with every earlier turn, so the host plans what
      // fits and sends it to a fresh session rather than the continued one.
      expect(String(third?.providerSessionId)).not.toBe(String(first?.providerSessionId));
      expect(third?.resumeCursor).toBeUndefined();
      expect(third?.context?.some((block) => block.kind === "assistant-message")).toBe(true);
    });
  });

  it.each([true, false])(
    "keeps a native Work conversation after a switch to another model of the same provider only when it can: %s",
    async (canSwitch) => {
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        input.onSessionReady?.({
          sessionId: input.providerSessionId,
          resumeCursor: { driverKind: "pi" as const, value: "native-work" },
        });
        return { kind: "completed" as const, response: "Earlier response" };
      });
      const fixture = serviceFixture({
        nativeConversation: true,
        turnRuntime: { run },
        supportsModelSwitch: () => canSwitch,
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      const switchedModel = decodeProviderModelId("model-b");
      const previousThread = await fixture.threads.read();
      fixture.threads.read.mockResolvedValue({ ...previousThread, modelId: switchedModel });
      const followUp = fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
        authority: { ...startCommand().authority, modelId: switchedModel },
        prompt: "Continue",
      });
      if (!canSwitch) {
        // The provider cannot carry the session on to another of its models,
        // so the turn starts a fresh session with a handoff instead of
        // refusing: no resume, a new session, and the handoff on the turn.
        await expect(followUp).resolves.toMatchObject({ kind: "accepted" });
        await fixture.waitForIdle();
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]?.[0].providerSessionId).not.toBe(
          run.mock.calls[0]?.[0].providerSessionId,
        );
        expect(run.mock.calls[1]?.[0].resumeCursor).toBeUndefined();
        expect(
          (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1)?.handoff,
        ).toMatchObject({ reason: "provider-switch" });
        return;
      }
      await expect(followUp).resolves.toMatchObject({ kind: "accepted" });
      await fixture.waitForIdle();
      expect(run.mock.calls[1]?.[0]).toMatchObject({
        providerSessionId: run.mock.calls[0]?.[0].providerSessionId,
        resumeCursor: { driverKind: "pi", value: "native-work" },
      });
    },
  );

  describe("rewinding a Work thread in place", () => {
    const secondRequest = decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const thirdRequest = decodeWorkTurnRequestId("99999999-9999-4999-8999-999999999999");
    const secondCommand = () => ({
      ...startCommand(),
      requestId: secondRequest,
      turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      prompt: "Make it longer",
    });
    const thirdCommand = () => ({
      ...startCommand(),
      requestId: thirdRequest,
      turnId: decodeWorkTurnId("88888888-8888-4888-8888-888888888888"),
      prompt: "Make it shorter instead",
    });
    const rewindFrom = (fromRequestId: typeof ids.request) => ({
      kind: "rewind-work-thread",
      rewindId: decodeWorkTurnRequestId("77777777-7777-4777-8777-777777777777"),
      threadId: ids.thread,
      fromRequestId,
    });

    /** Two finished turns, each with a reply of its own. */
    async function twoTurns(keepsSession: boolean) {
      let runs = 0;
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        input.onSessionReady?.({
          sessionId: input.providerSessionId,
          resumeCursor: { driverKind: "pi", value: `native-${String(input.providerSessionId)}` },
        });
        runs += 1;
        return { kind: "completed" as const, response: `Reply number ${runs}` };
      });
      const fixture = serviceFixture({
        turnRuntime: { run },
        resolveDriver: (_id, fallback) => ({
          ...fallback,
          conversationOwnership: keepsSession ? "provider" : "host",
        }),
      });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await fixture.waitForIdle();
      await fixture.service.startFirstTurn(ids.window, secondCommand());
      await fixture.waitForIdle(secondRequest);
      return { fixture, run };
    }

    const journaledPayloads = (fixture: ReturnType<typeof serviceFixture>) =>
      fixture.persistence.journal.append.mock.calls
        .flatMap(([request]) => request.events)
        .map((event: { readonly payload: unknown }) => event.payload);

    it("removes the turns, returns the removed prompt, and hands only the kept turns to a fresh session", async () => {
      const { fixture, run } = await twoTurns(true);

      await expect(
        fixture.service.rewindThread(ids.window, rewindFrom(secondRequest)),
      ).resolves.toEqual({
        kind: "thread-rewound",
        threadId: ids.thread,
        fromRequestId: secondRequest,
        removedTurns: 1,
        prompt: "Make it longer",
      });
      expect(
        (await fixture.service.transcript(ids.window, ids.thread)).turns.map(
          (turn) => turn.requestId,
        ),
      ).toEqual([ids.request]);

      await fixture.service.startFirstTurn(ids.window, thirdCommand());
      await fixture.waitForIdle(thirdRequest);
      const third = run.mock.calls[2]?.[0];
      // The session the removed turn ran on is never resumed.
      expect(third?.resumeCursor).toBeUndefined();
      expect(third?.providerSessionId).not.toBe(run.mock.calls[1]?.[0].providerSessionId);
      const context = JSON.stringify(third?.context);
      expect(context).toContain("the person rewound the thread");
      expect(context).toContain("Summarize the brief");
      expect(context).toContain("Reply number 1");
      expect(context).not.toContain("Make it longer");
      expect(context).not.toContain("Reply number 2");
      expect(
        (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1)?.handoff,
      ).toMatchObject({ reason: "rewind", messages: 2 });
    });

    it("tells every open view of the thread to read the transcript again", async () => {
      const { fixture } = await twoTurns(true);
      const { liveCursor } = await fixture.service.transcript(ids.window, ids.thread);
      const controller = new AbortController();
      const stream = fixture.service.subscribe(
        ids.window,
        ids.thread,
        liveCursor,
        controller.signal,
      );
      const next = stream.next();

      await fixture.service.rewindThread(ids.window, rewindFrom(secondRequest));
      await expect(next).resolves.toMatchObject({
        value: { kind: "snapshot-required", threadId: ids.thread },
      });
      controller.abort();
    });

    it("rebuilds from the kept turns alone on a provider that keeps no session", async () => {
      const { fixture, run } = await twoTurns(false);
      await fixture.service.rewindThread(ids.window, rewindFrom(secondRequest));

      await fixture.service.startFirstTurn(ids.window, thirdCommand());
      await fixture.waitForIdle(thirdRequest);
      const context = JSON.stringify(run.mock.calls[2]?.[0].context);
      expect(context).toContain("Reply number 1");
      expect(context).not.toContain("Make it longer");
      expect(context).not.toContain("Reply number 2");
    });

    it("keeps the removal after a restart replays the journal, and answers a retried rewind from it", async () => {
      const { fixture } = await twoTurns(true);
      await fixture.service.rewindThread(ids.window, rewindFrom(secondRequest));

      const rebuilt = new WorkTurnProjection();
      for (const payload of journaledPayloads(fixture)) rebuilt.apply(payload as never);
      expect(rebuilt.listForThread(ids.thread).map((turn) => turn.requestId)).toEqual([
        ids.request,
      ]);
      expect(rebuilt.rewoundSinceLatest(ids.thread)).toBe(true);

      const appends = fixture.persistence.journal.append.mock.calls.length;
      await expect(
        fixture.service.rewindThread(ids.window, rewindFrom(secondRequest)),
      ).resolves.toMatchObject({ removedTurns: 1, prompt: "Make it longer" });
      expect(fixture.persistence.journal.append.mock.calls).toHaveLength(appends);
    });

    it("refuses to rewind while a turn of the thread runs, and keeps every turn", async () => {
      let release: () => void = () => undefined;
      const run = vi.fn(
        (input: Parameters<WorkTurnRuntimePort["run"]>[0]) =>
          new Promise<{ readonly kind: "completed"; readonly response: string }>((resolve) => {
            input.onSessionReady?.({ sessionId: input.providerSessionId });
            release = () => resolve({ kind: "completed", response: "Done" });
          }),
      );
      const fixture = serviceFixture({ turnRuntime: { run } });
      await fixture.service.startFirstTurn(ids.window, startCommand());
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

      await expect(
        fixture.service.rewindThread(ids.window, rewindFrom(ids.request)),
      ).rejects.toThrow("A turn is running in this thread");
      expect((await fixture.service.transcript(ids.window, ids.thread)).turns).toHaveLength(1);
      release();
      await fixture.waitForIdle();
    });
  });

  it("starts a fork's first own turn in a new session with its carried turns as text", async () => {
    const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
      input.onSessionReady?.({
        sessionId: input.providerSessionId,
        resumeCursor: { driverKind: "pi", value: "fork-session" },
      });
      return { kind: "completed" as const, response: "Fork reply" };
    });
    const fixture = serviceFixture({
      turnRuntime: { run },
      resolveDriver: (_id, fallback) => ({ ...fallback, conversationOwnership: "provider" }),
    });
    const carried = decodeWorkTurnRequestId("66666666-6666-4666-8666-666666666666");
    const carriedTurn = decodeWorkTurnId("55555555-5555-4555-8555-555555555555");
    fixture.projection.apply({
      kind: "turn-accepted",
      requestId: carried,
      threadId: ids.thread,
      turnId: carriedTurn,
      projectId: ids.project,
      authority: startCommand().authority as never,
      providerSessionId: ids.session as never,
      carriedFrom: {
        threadId: decodeWorkThreadId("72000000-0000-4000-8000-000000000044"),
        requestId: decodeWorkTurnRequestId("44444444-4444-4444-8444-444444444444"),
      },
      prompt: "Draft the source brief",
      capabilities: WORK_TURN_CAPABILITIES,
      acceptedAt: "2026-07-01T00:00:00.000Z" as never,
    });
    fixture.projection.apply({
      kind: "turn-updated",
      requestId: carried,
      threadId: ids.thread,
      turnId: carriedTurn,
      status: "completed",
      response: "The source's draft",
      updatedAt: "2026-07-01T00:00:00.000Z" as never,
    });

    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();
    const first = run.mock.calls[0]?.[0];
    // The carried turn ran in the source; its session is never the fork's.
    expect(first?.resumeCursor).toBeUndefined();
    const context = JSON.stringify(first?.context);
    expect(context).toContain("this thread was forked from");
    expect(context).toContain("Draft the source brief");
    expect(context).toContain("The source's draft");
    expect(
      (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1)?.handoff,
    ).toMatchObject({ reason: "fork", messages: 2 });
  });

  it("refuses a changed tool catalogue before acceptance and preserves the conversation on explicit continuation", async () => {
    const base = workProject();
    const project = workProject({
      extraFolders: [
        decodeProjectExtraFolder({
          canonicalRoot: "/approved/notes",
          addedAt: now,
          addedBy: base.bindingHistory[0]?.actor,
        }),
        decodeProjectExtraFolder({
          canonicalRoot: "/approved/assets",
          addedAt: now,
          addedBy: base.bindingHistory[0]?.actor,
        }),
      ],
    });
    const choice = approvedWorkingFolderChoices(project).find((folder) => folder.kind === "extra");
    if (choice === undefined) throw new Error("Missing approved folder");
    let physicalCurrent = true;
    let keepRunning = false;
    let continuationSignal: AbortSignal | undefined;
    const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
      input.onSessionReady?.({
        sessionId: input.providerSessionId,
        resumeCursor: { driverKind: "codex", value: "saved-session" },
      });
      if (keepRunning) {
        continuationSignal = input.signal;
        expect(input.admissionCurrent?.()).toBe(true);
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { kind: "cancelled" as const };
      }
      return { kind: "completed" as const, response: "A saved answer" };
    });
    const resolveAppManagedTools = vi.fn(() => undefined);
    const fixture = serviceFixture({
      project,
      resolveAppManagedTools,
      workingDirectoriesCurrent: () => () => physicalCurrent,
      turnRuntime: { run },
      resolveDriver: (_id, fallback) => ({
        ...fallback,
        conversationOwnership: "provider",
        toolCatalogContinuation: () => "handoff-required",
      }),
    });
    const thread = { ...(await fixture.threads.read()), workingFolderId: choice.id };
    fixture.threads.read.mockResolvedValue(thread);
    const command = {
      ...startCommand(),
      authority: { ...startCommand().authority, workingFolderId: choice.id },
    };
    await fixture.service.startFirstTurn(ids.window, command);
    await fixture.waitForIdle();
    const next = {
      ...command,
      requestId: decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      prompt: "Use the updated tools",
    };
    await expect(fixture.service.startFirstTurn(ids.window, next)).rejects.toThrow(
      "different tools",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect((await fixture.service.transcript(ids.window, ids.thread)).turns).toHaveLength(1);
    keepRunning = true;
    await fixture.service.startFirstTurn(ids.window, { ...next, toolCatalogHandoff: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    physicalCurrent = false;
    expect(resolveAppManagedTools).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectRoot: "/approved/notes",
        extraFolders: [project.binding.canonicalRoot, "/approved/assets"],
      }),
    );
    expect(run.mock.calls[1]?.[0].projectRoot).toBe("/approved/notes");
    expect(run.mock.calls[1]?.[0].extraFolders).toContain(project.binding.canonicalRoot);
    await vi.waitFor(() => expect(continuationSignal?.aborted).toBe(true));
    await fixture.waitForIdle(next.requestId);
    expect(run).toHaveBeenCalledTimes(2);
    await expect(fixture.service.startFirstTurn(ids.window, next)).rejects.toThrow(
      "identity conflict",
    );
    expect(run).toHaveBeenCalledTimes(2);
    const restored = new WorkTurnProjection();
    for (const [request] of fixture.persistence.journal.append.mock.calls) {
      for (const event of request.events) {
        if (event.eventName === "work.turn-accepted@1")
          restored.apply(decodeWorkTurnAccepted(event.payload));
      }
    }
    expect(restored.lookup(next.requestId)?.toolCatalogHandoff).toBe(true);
    expect(run.mock.calls[1]?.[0].resumeCursor).toBeUndefined();
    expect(JSON.stringify(run.mock.calls[1]?.[0].context)).toContain("A saved answer");
    expect(
      (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1)?.handoff,
    ).toMatchObject({ reason: "provider-switch", messages: 2 });
    fixture.persistence.readProject.mockReturnValue(base);
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...next,
        requestId: randomUUID(),
        turnId: randomUUID(),
        toolCatalogHandoff: true,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  describe("moving a Work conversation to another provider", () => {
    const nextProvider = decodeProviderInstanceId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const followUpCommand = () => ({
      ...startCommand(),
      requestId: decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      authority: { ...startCommand().authority, providerInstanceId: nextProvider },
      prompt: "Continue",
    });

    /** A first turn on the first provider, then the thread moved to another one. */
    async function movedFixture(options: {
      readonly firstKeepsSession: boolean;
      readonly nextKeepsSession: boolean;
      readonly firstProviderRetired?: boolean;
      readonly firstCommand?: ReturnType<typeof startCommand> & {
        readonly attachmentIds?: ReadonlyArray<ReturnType<typeof decodeWorkAttachmentId>>;
      };
      readonly fixture?: Parameters<typeof serviceFixture>[0];
      /** How the n-th provider run ends once its session is ready; completes by default. */
      readonly endsWith?: (runIndex: number) => "completed" | "failed" | "waiting" | "cancelled";
    }) {
      let retired = false;
      let runs = 0;
      const run = vi.fn(async (input: Parameters<WorkTurnRuntimePort["run"]>[0]) => {
        input.onSessionReady?.({
          sessionId: input.providerSessionId,
          resumeCursor: { driverKind: "pi", value: `native-${String(input.providerSessionId)}` },
        });
        const ending = options.endsWith?.(runs++) ?? "completed";
        const failure = { category: "unavailable" as const, message: "The provider stopped." };
        if (ending === "cancelled") return { kind: "cancelled" as const };
        if (ending === "failed") return { kind: "failed" as const, failure };
        if (ending === "waiting") return { kind: "waiting" as const, failure };
        return { kind: "completed" as const, response: "Existing conversation" };
      });
      const fixture = serviceFixture({
        ...options.fixture,
        turnRuntime: { run },
        resolveDriver: (id, fallback) =>
          retired && id === ids.provider
            ? undefined
            : {
                ...fallback,
                conversationOwnership: (
                  id === ids.provider ? options.firstKeepsSession : options.nextKeepsSession
                )
                  ? "provider"
                  : "host",
              },
      });
      await fixture.service.startFirstTurn(ids.window, options.firstCommand ?? startCommand());
      await fixture.waitForIdle();
      retired = options.firstProviderRetired === true;
      const previousThread = await fixture.threads.read();
      fixture.threads.read.mockResolvedValue({
        ...previousThread,
        providerInstanceId: nextProvider,
      });
      const previousProvider = fixture.persistence.readProviderInstance();
      fixture.persistence.readProviderInstance.mockReturnValue({
        ...previousProvider,
        id: nextProvider,
      });
      return { fixture, run };
    }

    const acceptedEvents = (fixture: ReturnType<typeof serviceFixture>) =>
      fixture.persistence.journal.append.mock.calls
        .flatMap(([request]) => request.events)
        .filter(
          (event: { readonly eventName: string }) => event.eventName === "work.turn-accepted@1",
        )
        .map((event: { readonly payload: unknown }) => event.payload as Record<string, unknown>);

    const noOmissions = {
      earlierMessages: 0,
      unfinishedReplies: 0,
      missingBodies: 0,
      oversizedBodies: 0,
      emptyBodies: 0,
      attachments: 0,
      truncatedMessages: 0,
      truncatedCharacters: 0,
      sourceTruncatedMessages: 0,
    };

    it.each([true, false])(
      "preserves the original screenshot when switching to a provider with native history %s",
      async (nextKeepsSession) => {
        const root = await mkdtemp(join(tmpdir(), "octant-work-handoff-input-"));
        attachmentRoots.push(root);
        const store = new WorkAttachmentStore(root);
        const attachmentId = decodeWorkAttachmentId("30000000-0000-4000-8000-000000000001");
        const bytes = new Uint8Array([137, 80, 78]);
        await store.stage({
          threadId: ids.thread,
          attachmentId,
          displayName: "Original.png",
          mediaType: "image/png",
          bytes,
        });
        let supports = false;
        const transfer = new ConversationInputTransfer({
          ownerCurrent: () => true,
          dataDirectory: root,
          sourceCurrent: (reference) => reference.source.threadId === String(ids.thread),
          read: (reference) =>
            store.read(decodeWorkThreadId(reference.source.threadId), {
              attachmentId: decodeWorkAttachmentId(reference.source.attachmentId),
              byteLength: reference.byteLength,
              digest: reference.digest,
            }),
          supports: () => supports,
        });
        const { fixture, run } = await movedFixture({
          firstKeepsSession: false,
          nextKeepsSession,
          firstCommand: { ...startCommand(), attachmentIds: [attachmentId] },
          fixture: {
            attachments: store,
            supportsAttachments: () => true,
            conversationInputTransfer: transfer,
          },
        });
        await expect(fixture.service.startFirstTurn(ids.window, followUpCommand())).rejects.toThrow(
          "Original.png (unsupported)",
        );
        expect(run).toHaveBeenCalledTimes(1);
        expect(acceptedEvents(fixture)).toHaveLength(1);
        supports = true;
        await fixture.service.startFirstTurn(ids.window, followUpCommand());
        await fixture.waitForIdle();
        expect(run.mock.calls[1]?.[0].attachments).toEqual([
          expect.objectContaining({ displayName: "Original.png", bytes }),
        ]);
        expect(acceptedEvents(fixture).at(-1)).toMatchObject({
          inputReceipt: { included: 1, omitted: 0, purpose: "provider-switch" },
        });
        expect(JSON.stringify(run.mock.calls[1]?.[0].context)).toContain(
          "original person's inputs",
        );
      },
    );

    it("starts a new session with the earlier conversation when a provider that keeps its own session takes over", async () => {
      const { fixture, run } = await movedFixture({
        firstKeepsSession: false,
        nextKeepsSession: true,
      });

      await expect(
        fixture.service.startFirstTurn(ids.window, followUpCommand()),
      ).resolves.toMatchObject({ kind: "accepted" });
      await fixture.waitForIdle();

      const second = run.mock.calls[1]?.[0];
      expect(second?.providerSessionId).not.toBe(run.mock.calls[0]?.[0].providerSessionId);
      expect(second?.resumeCursor).toBeUndefined();
      const context = JSON.stringify(second?.context);
      expect(context).toContain("handed over because the thread moved to a different provider");
      expect(context).toContain("Summarize the brief");
      expect(context).toContain("Existing conversation");
      const expected = {
        reason: "provider-switch",
        previousProviderInstanceId: ids.provider,
        previousModelId: "model-a",
        messages: 2,
        omissions: noOmissions,
        externalContentIngested: false,
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      };
      // Journaled with the acceptance, before the provider is sent anything.
      expect(acceptedEvents(fixture).at(-1)).toMatchObject({ handoff: expected });
      expect(
        (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1)?.handoff,
      ).toEqual(expected);
      expect(
        (await fixture.service.transcript(ids.window, ids.thread)).turns[0]?.handoff,
      ).toBeUndefined();
      // A replay of the journaled acceptances rebuilds the same turn.
      const rebuilt = new WorkTurnProjection();
      for (const payload of acceptedEvents(fixture)) rebuilt.apply(payload as never);
      expect(rebuilt.latestForThread(ids.thread)?.handoff).toEqual(expected);
    });

    it("hands the conversation over even when the first provider is gone", async () => {
      const { fixture, run } = await movedFixture({
        firstKeepsSession: true,
        nextKeepsSession: true,
        firstProviderRetired: true,
      });

      await fixture.service.startFirstTurn(ids.window, followUpCommand());
      await fixture.waitForIdle();

      expect(run.mock.calls[1]?.[0].resumeCursor).toBeUndefined();
      expect(acceptedEvents(fixture).at(-1)).toMatchObject({
        handoff: { reason: "provider-switch", previousProviderInstanceId: ids.provider },
      });
    });

    describe("a handoff turn that may never have reached the new session", () => {
      const thirdCommand = () => ({
        ...startCommand(),
        requestId: decodeWorkTurnRequestId("99999999-9999-4999-8999-999999999999"),
        turnId: decodeWorkTurnId("88888888-8888-4888-8888-888888888888"),
        authority: { ...startCommand().authority, providerInstanceId: nextProvider },
        prompt: "Continue again",
      });

      it.each(["failed", "waiting", "cancelled"] as const)(
        "hands the conversation over again, in a fresh session, after a %s handoff turn",
        async (ending) => {
          const { fixture, run } = await movedFixture({
            firstKeepsSession: true,
            nextKeepsSession: true,
            endsWith: (index) => (index === 1 ? ending : "completed"),
          });
          await fixture.service.startFirstTurn(ids.window, followUpCommand());
          await fixture.waitForIdle();
          const stopped = (await fixture.service.transcript(ids.window, ids.thread)).turns.at(-1);
          // The session started and its cursor was recorded; only the status
          // says whether the provider ever received the handoff.
          expect(stopped?.status).toBe(ending);
          expect(stopped?.resumeCursor).toBeDefined();
          expect(stopped?.handoff).toBeDefined();

          await fixture.service.startFirstTurn(ids.window, thirdCommand());
          await fixture.waitForIdle();

          const third = run.mock.calls[2]?.[0];
          expect(third?.resumeCursor).toBeUndefined();
          expect(third?.providerSessionId).not.toBe(run.mock.calls[1]?.[0].providerSessionId);
          expect(acceptedEvents(fixture).at(-1)).toMatchObject({
            handoff: {
              reason: "provider-switch",
              // Still the provider the conversation came from.
              previousProviderInstanceId: ids.provider,
            },
          });
          expect(JSON.stringify(third?.context)).toContain("Summarize the brief");
          expect(JSON.stringify(third?.context)).toContain("Continue");
        },
      );

      it("keeps resuming the new session once a handoff turn completed", async () => {
        const { fixture, run } = await movedFixture({
          firstKeepsSession: true,
          nextKeepsSession: true,
        });
        await fixture.service.startFirstTurn(ids.window, followUpCommand());
        await fixture.waitForIdle();

        await fixture.service.startFirstTurn(ids.window, thirdCommand());
        await fixture.waitForIdle();

        expect(run.mock.calls[2]?.[0].providerSessionId).toBe(
          run.mock.calls[1]?.[0].providerSessionId,
        );
        expect(run.mock.calls[2]?.[0].resumeCursor).toBeDefined();
        expect(acceptedEvents(fixture).at(-1)?.handoff).toBeUndefined();
      });
    });

    it("refuses, and starts no session, when the thread cannot be read for the handoff", async () => {
      const { fixture, run } = await movedFixture({
        firstKeepsSession: false,
        nextKeepsSession: true,
      });
      fixture.threads.read.mockResolvedValue(undefined as never);

      await expect(fixture.service.startFirstTurn(ids.window, followUpCommand())).rejects.toThrow();

      expect(run).toHaveBeenCalledTimes(1);
    });

    it("sends a host-held provider the history it already holds, with no handoff", async () => {
      const { fixture, run } = await movedFixture({
        firstKeepsSession: true,
        nextKeepsSession: false,
      });

      await expect(
        fixture.service.startFirstTurn(ids.window, followUpCommand()),
      ).resolves.toMatchObject({ kind: "accepted" });
      await fixture.waitForIdle();

      expect(acceptedEvents(fixture).at(-1)?.handoff).toBeUndefined();
      expect(JSON.stringify(run.mock.calls[1]?.[0].context)).toContain("Existing conversation");
    });

    it("says in the record when the thread had taken in outside content", async () => {
      const { fixture } = await movedFixture({
        firstKeepsSession: false,
        nextKeepsSession: true,
        fixture: { externalContentIngested: true },
      });

      await fixture.service.startFirstTurn(ids.window, followUpCommand());
      await fixture.waitForIdle();

      expect(acceptedEvents(fixture).at(-1)).toMatchObject({
        handoff: { externalContentIngested: true },
      });
    });

    it("refuses, and journals nothing, when the host cannot hand a conversation over", async () => {
      const { fixture, run } = await movedFixture({
        firstKeepsSession: false,
        nextKeepsSession: true,
        fixture: { withoutConversationHandoff: true },
      });
      const journalCalls = fixture.persistence.journal.append.mock.calls.length;

      await expect(fixture.service.startFirstTurn(ids.window, followUpCommand())).rejects.toThrow(
        "cannot hand a conversation",
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(fixture.persistence.journal.append.mock.calls).toHaveLength(journalCalls);
    });

    it("refuses with the reason when the conversation cannot be read for the handoff", async () => {
      const { fixture, run } = await movedFixture({
        firstKeepsSession: false,
        nextKeepsSession: true,
        fixture: {
          selectConversationHandoff: () => ({ status: "unavailable", reason: "source-empty" }),
        },
      });
      const journalCalls = fixture.persistence.journal.append.mock.calls.length;

      await expect(fixture.service.startFirstTurn(ids.window, followUpCommand())).rejects.toThrow(
        "no readable messages",
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(fixture.persistence.journal.append.mock.calls).toHaveLength(journalCalls);
    });

    it("refuses a handoff that was read from another thread", async () => {
      const { fixture, run } = await movedFixture({
        firstKeepsSession: false,
        nextKeepsSession: true,
        fixture: {
          selectConversationHandoff: (thread) => {
            const own = admittedParentWorkContext({
              threadId: thread.id,
              purpose: "provider-switch",
              externalContentIngested: false,
              readThread: () => thread,
              readTurns: () => [],
            });
            return own.status === "available"
              ? { ...own, source: { ...own.source, threadId: "another-thread" } }
              : {
                  status: "available",
                  blocks: [
                    { kind: "conversation-summary", text: "summary" },
                    { kind: "user-message", text: "another thread's question" },
                  ],
                  omissions: noOmissions,
                  source: {
                    mode: "work",
                    threadId: "another-thread",
                    projectId: String(ids.project),
                    threadVersion: 1,
                    externalContentIngested: false,
                    point: {},
                  },
                };
          },
        },
      });

      await expect(fixture.service.startFirstTurn(ids.window, followUpCommand())).rejects.toThrow(
        "does not belong to this work task",
      );
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  it("hands a follow-up turn the prior transcript as provider context", async () => {
    const run = vi.fn();
    run.mockImplementationOnce(async () => ({
      kind: "completed" as const,
      response: "Provider reply",
    }));
    run.mockImplementation(async () => ({ kind: "completed" as const, response: "Shorter." }));
    const fixture = serviceFixture({ turnRuntime: { run } });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    await fixture.waitForIdle();

    const followUp = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      requestId: decodeWorkTurnRequestId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      turnId: decodeWorkTurnId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      prompt: "Make that summary shorter",
    });
    expect(followUp.kind).toBe("accepted");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({
      command: expect.objectContaining({ prompt: "Make that summary shorter" }),
      context: [
        { kind: "instructions", text: expect.stringContaining("this task's folder") },
        { kind: "user-message", text: "Summarize the brief" },
        { kind: "assistant-message", text: "Provider reply" },
      ],
    });
  });

  it("validates every batch member and replays only the prior group before delivering a new generation", async () => {
    const first = workRunFor(ids.thread);
    const second = workRunFor(ids.thread, { id: "d4a1b000-0000-4000-8000-000000000005" });
    const third = workRunFor(ids.thread, { id: "d4a1b000-0000-4000-8000-000000000006" });
    const runs = new Map([first, second, third].map((run) => [run.id, run]));
    const fixture = serviceFixture({ agentRuns: { getById: (id) => runs.get(id) } });
    const delivery = { kind: "agent-result", runId: first.id, runIds: [first.id, second.id] };
    for (const invalid of [
      workRunFor(String(third.id), { id: second.id }),
      { ...second, lifecycleStatus: "running" as const },
    ]) {
      runs.set(second.id, invalid);
      await expect(
        fixture.service.startFirstTurn(ids.window, { ...startCommand(), delivery }),
      ).rejects.toMatchObject({ failure: { category: "invalid" } });
    }
    runs.set(second.id, second);
    const original = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      delivery,
    });
    expect(original).toMatchObject({ kind: "accepted", turn: { delivery } });
    await fixture.waitForIdle();
    runs.set(first.id, {
      ...first,
      resultDelivery: { outcome: "delivered", settledAt: first.updatedAt },
    });
    const next = {
      ...startCommand(),
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      turnId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    const replay = await fixture.service.startFirstTurn(ids.window, {
      ...next,
      delivery: { kind: "agent-result", runId: second.id, runIds: [second.id, third.id] },
    });
    expect(replay).toMatchObject({ kind: "accepted", turn: { turnId: ids.turn, delivery } });
    expect(fixture.projection.listForThread(ids.thread)).toHaveLength(1);
    const resumed = { ...first, generation: 2 };
    runs.set(first.id, resumed);
    const newDelivery = {
      kind: "agent-result",
      runId: first.id,
      runGenerations: [{ runId: first.id, generation: 2 }],
    };
    await expect(
      fixture.service.startFirstTurn(ids.window, { ...next, delivery: newDelivery }),
    ).resolves.toMatchObject({ kind: "accepted", turn: { delivery: newDelivery } });
    expect(fixture.projection.listForThread(ids.thread)).toHaveLength(2);
    await expect(
      fixture.service.startFirstTurn(ids.window, { ...startCommand(), delivery }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("defers fresh child results while the Work parent has an active turn", async () => {
    const run = workRunFor(ids.thread);
    const pending = deferred<{ readonly kind: "completed"; readonly response: string }>();
    const fixture = serviceFixture({
      agentRuns: { getById: () => run },
      turnRuntime: { run: () => pending.promise },
    });
    await fixture.service.startFirstTurn(ids.window, startCommand());
    try {
      await expect(
        fixture.service.startFirstTurn(ids.window, {
          ...startCommand(),
          requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          turnId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          delivery: { kind: "agent-result", runId: run.id },
        }),
      ).rejects.toMatchObject({ failure: { category: "stale" } });
    } finally {
      pending.resolve({ kind: "completed", response: "done" });
    }
  });

  it("refuses a turn that claims to deliver a subagent result the journal does not back", async () => {
    const delivery = { kind: "agent-result", runId: "d4a1b000-0000-4000-8000-000000000099" };
    // No agentRuns dependency: an unbacked mark is refused.
    const bare = serviceFixture();
    await expect(
      bare.service.startFirstTurn(ids.window, { ...startCommand(), delivery }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    // A run that belongs to another thread or has not finished is refused too.
    const stranger = workRunFor("d4a1b000-0000-4000-8000-0000000000aa");
    const running = workRunFor(ids.thread, { lifecycleStatus: "running" });
    const fixture = serviceFixture({
      agentRuns: {
        getById: (runId) => {
          if (String(runId) === String(stranger.id)) return stranger;
          if (String(runId) === String(running.id)) return running;
          return undefined;
        },
      },
    });
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        delivery: { kind: "agent-result", runId: stranger.id },
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    await expect(
      fixture.service.startFirstTurn(ids.window, {
        ...startCommand(),
        delivery: { kind: "agent-result", runId: running.id },
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("refuses every turn on a thread a person marked Done, and admits one after reactivation", async () => {
    let markedDone = true;
    const onTurnRequested = vi.fn();
    const run = workRunFor(ids.thread);
    const fixture = serviceFixture({
      completionConfirmed: () => markedDone,
      onTurnRequested,
      agentRuns: { getById: (runId) => (String(runId) === String(run.id) ? run : undefined) },
    });
    const refusal = {
      failure: { category: "invalid", message: WORK_THREAD_MARKED_DONE_TURN_REFUSAL },
    };

    // A window's turn (also how the queue dispatches), the host's
    // usage-limit continuation, and a child's result delivery.
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toMatchObject(
      refusal,
    );
    await expect(
      fixture.service.startFirstTurn(ROUTINE_HOST_SCOPE_ID, startCommand(), {
        limitRecovery: true,
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      fixture.service.startFirstTurn(ROUTINE_HOST_SCOPE_ID, {
        ...startCommand(),
        delivery: { kind: "agent-result", runId: run.id },
      }),
    ).rejects.toMatchObject(refusal);
    expect(onTurnRequested).not.toHaveBeenCalled();
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
    expect(fixture.projection.lookup(ids.request)).toBeUndefined();

    markedDone = false;
    const result = await fixture.service.startFirstTurn(ids.window, startCommand());
    expect(result.kind).toBe("accepted");
    await fixture.waitForIdle();
  });

  it("refuses a turn when a person marks the thread Done while the turn is prepared", async () => {
    let reads = 0;
    const fixture = serviceFixture({ completionConfirmed: () => reads++ > 0 });

    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toMatchObject({
      failure: { category: "invalid", message: WORK_THREAD_MARKED_DONE_TURN_REFUSAL },
    });
    expect(reads).toBeGreaterThan(1);
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
    expect(fixture.projection.lookup(ids.request)).toBeUndefined();
  });

  it("admits a delivery turn the journaled run backs and carries its mark", async () => {
    const run = workRunFor(ids.thread);
    const fixture = serviceFixture({
      agentRuns: { getById: (runId) => (String(runId) === String(run.id) ? run : undefined) },
    });
    const result = await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      delivery: { kind: "agent-result", runId: run.id },
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.turn.delivery).toEqual({ kind: "agent-result", runId: run.id });
  });
});

/** Run `count` turns on the one thread, each settled before the next starts. */
describe("a Work turn in a Project on a server", () => {
  // The Project is in its own catalog: the local one names nothing, and no
  // local Work Project is open to the window.
  function onServer(
    bind: ReturnType<NonNullable<WorkTurnServiceDependencies["serverProjects"]>["bind"]>,
  ) {
    const observe = vi.fn(() => undefined);
    const resolveAppManagedTools = vi.fn(() => undefined);
    const run = vi.fn<WorkTurnRuntimePort["run"]>(async () => ({
      kind: "completed",
      response: "Done there",
    }));
    const fixture = serviceFixture({
      serverProjects: { holds: () => true, bind: () => bind },
      turnRuntime: { run },
      resolveAppManagedTools,
      turnFileObserver: { observe } as never,
    });
    fixture.persistence.readProject.mockReturnValue(undefined as never);
    fixture.projects.bootstrap.mockResolvedValue({ active: [] });
    return { fixture, run, observe, resolveAppManagedTools };
  }

  it("runs with the server's tools in its folder there, watching and resolving nothing here", async () => {
    const tools = {
      definitions: [],
      execute: async () => ({ result: {} }),
      close: async () => undefined,
    };
    const { fixture, run, observe, resolveAppManagedTools } = onServer({
      status: "bound",
      folder: "/srv/notes",
      tools,
    });
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).resolves.toMatchObject(
      { kind: "accepted" },
    );
    await fixture.waitForIdle();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: "/srv/notes",
      appManagedTools: tools,
    });
    expect(resolveAppManagedTools).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(fixture.workingDirectories.resolve).not.toHaveBeenCalled();
  });

  it("refuses before anything starts when its turn cannot bind there", async () => {
    const { fixture, run } = onServer({ status: "refused", message: "Not on the harness." });
    await expect(fixture.service.startFirstTurn(ids.window, startCommand())).rejects.toMatchObject({
      failure: { category: "unavailable", message: "Not on the harness." },
    });
    expect(run).not.toHaveBeenCalled();
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });
});

async function settleTurns(
  fixture: ReturnType<typeof serviceFixture>,
  count: number,
): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    const suffix = n.toString(16).padStart(12, "0");
    const requestId = decodeWorkTurnRequestId(`aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`);
    await fixture.service.startFirstTurn(ids.window, {
      ...startCommand(),
      requestId,
      turnId: decodeWorkTurnId(`bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`),
      prompt: `Prompt ${n}`,
    });
    await fixture.waitForIdle(requestId);
  }
}

function startCommand() {
  return {
    kind: "start-work-thread-turn",
    requestId: ids.request,
    threadId: ids.thread,
    turnId: ids.turn,
    prompt: "Summarize the brief",
    authority: {
      hostId: "local",
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId: ids.provider,
      modelId: "model-a",
    },
  };
}

async function attachmentStore(): Promise<WorkAttachmentStore> {
  const root = await mkdtemp(join(tmpdir(), "octant-work-turn-attachment-"));
  attachmentRoots.push(root);
  return new WorkAttachmentStore(root);
}

function serviceFixture(
  options: {
    readonly project?: Project;
    readonly workingDirectoriesCurrent?: NonNullable<
      WorkTurnServiceDependencies["workingDirectories"]["current"]
    >;
    readonly nativeConversation?: boolean;
    readonly resolveDriver?: (
      id: Parameters<WorkTurnServiceDependencies["resolveDriver"]>[0],
      fallback: ProviderDriver,
    ) => ProviderDriver | undefined;
    readonly turnRuntime?: WorkTurnRuntimePort;
    readonly attachments?: WorkAttachmentStore;
    readonly supportsAttachments?: () => boolean;
    readonly supportsModelSwitch?: () => boolean;
    readonly conversationInputTransfer?: WorkTurnServiceDependencies["conversationInputTransfer"];
    readonly contextHarness?: ContextHarnessService;
    readonly contextFacts?: ProviderDriver["contextFacts"];
    readonly safeInputBudgetTokens?: number;
    readonly resolveSelectedExtensions?: WorkTurnServiceDependencies["resolveSelectedExtensions"];
    readonly resolveSideChatReturns?: WorkTurnServiceDependencies["resolveSideChatReturns"];
    readonly resolveFileMentionContext?: WorkTurnServiceDependencies["resolveFileMentionContext"];
    readonly resolveAppManagedTools?: WorkTurnServiceDependencies["resolveAppManagedTools"];
    readonly spendCeiling?: WorkTurnServiceDependencies["spendCeiling"];
    readonly nativeHarness?: WorkTurnServiceDependencies["nativeHarness"];
    readonly projectStatusFiles?: WorkProjectStatusFiles;
    readonly turnFileObserver?: WorkTurnServiceDependencies["turnFileObserver"];
    readonly readProviderModel?: WorkTurnServiceDependencies["persistence"]["readProviderModel"];
    readonly threadAccess?: WorkAccess;
    readonly documentDelivery?: "canvas" | "native-artifacts";
    readonly onTurnRequested?: WorkTurnServiceDependencies["onTurnRequested"];
    readonly onTurnCancelled?: WorkTurnServiceDependencies["onTurnCancelled"];
    readonly agentRuns?: WorkTurnServiceDependencies["agentRuns"];
    readonly runningAccess?: RunningWorkTurnAccess;
    /** Read on every thread read, so a test can mark and reactivate between turns. */
    readonly completionConfirmed?: () => boolean;
    /** Replaces the host's selection of a conversation to hand to a new provider session. */
    readonly selectConversationHandoff?: WorkTurnServiceDependencies["selectConversationHandoff"];
    /** Leaves the host unable to hand a conversation over at all. */
    readonly withoutConversationHandoff?: boolean;
    /** Whether the thread had taken in outside content when a handoff is read. */
    readonly externalContentIngested?: boolean;
    readonly serverProjects?: WorkTurnServiceDependencies["serverProjects"];
  } = {},
) {
  const projection = new WorkTurnProjection();
  const acquireInputs: unknown[] = [];
  const defaultDriver: ProviderDriver = {
    kind: "openai-compatible",
    ...(options.nativeConversation ? { conversationOwnership: "provider" as const } : {}),
    ...(options.contextFacts === undefined ? {} : { contextFacts: options.contextFacts }),
    probe: () => Effect.die("unused"),
    acquire: (input) => {
      acquireInputs.push(input);
      return Effect.succeed({
        subscribe: Effect.succeed(Stream.empty),
        start: () => Effect.void,
        send: () => Effect.void,
        resume: () => Effect.void,
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      } as never);
    },
  };
  const defaultRuntime: WorkTurnRuntimePort = {
    run: async (input) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* input.driver.acquire({
              instanceId: input.command.authority.providerInstanceId,
              projectRoot: input.projectRoot,
              mode: "work",
              workRequest: {
                projectId: input.command.authority.projectId,
                threadId: input.command.threadId,
                sessionId: input.providerSessionId,
              },
            });
            yield* connection.start({
              sessionId: input.providerSessionId,
              modelId: input.command.authority.modelId,
              executionPolicy: "approval-gated",
            });
          }),
        ),
      );
      if (input.signal.aborted) return { kind: "cancelled" };
      input.onDelta?.("Provider reply");
      if (input.signal.aborted) return { kind: "cancelled" };
      return { kind: "completed", response: "Provider reply" };
    },
  };
  const persistence = {
    status: () => ({ state: "current", integrity: "ok" }),
    readProject: vi.fn(() => options.project ?? workProject()),
    ...(options.readProviderModel === undefined
      ? {}
      : { readProviderModel: options.readProviderModel }),
    readProviderInstance: vi.fn(() =>
      decodeProviderInstance({
        id: ids.provider,
        displayName: "Test",
        driverKind: "openai-compatible",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: "https://example.invalid/v1/",
          authentication: "bearer",
          protocol: "responses",
          manualModelIds: ["model-a"],
        },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ),
    journal: {
      append: vi.fn(),
    },
  };
  const threads = {
    bootstrap: vi.fn(async () => ({
      threads: [
        decodeWorkThread({
          id: ids.thread,
          projectId: ids.project,
          title: "Draft brief",
          lifecycle: "active",
          providerInstanceId: ids.provider,
          modelId: "model-a",
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          version: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ],
    })),
    read: vi.fn(async () =>
      decodeWorkThread({
        id: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        lifecycle: "active",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        bindingRevisionId: ids.binding,
        workingDirectory: ".",
        ...(options.threadAccess === undefined ? {} : { access: options.threadAccess }),
        ...(options.completionConfirmed?.() === true ? { completionConfirmed: true } : {}),
        ...(options.documentDelivery === undefined
          ? {}
          : { documentDelivery: options.documentDelivery }),
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ),
  };
  const projects = {
    bootstrap: vi.fn(async () => ({
      active: [{ id: ids.project, type: "work", lifecycle: "active" }],
    })),
  };
  const workingDirectories = {
    resolve: vi.fn(async (root: string) => root),
    ...(options.workingDirectoriesCurrent === undefined
      ? {}
      : { current: options.workingDirectoriesCurrent }),
  };
  const service = new WorkTurnService({
    ...(options.conversationInputTransfer === undefined
      ? {}
      : { conversationInputTransfer: options.conversationInputTransfer }),
    ...(options.resolveSideChatReturns === undefined
      ? {}
      : { resolveSideChatReturns: options.resolveSideChatReturns }),
    ...(options.serverProjects === undefined ? {} : { serverProjects: options.serverProjects }),
    ...(options.contextHarness === undefined ? {} : { contextHarness: options.contextHarness }),
    persistence: persistence as never,
    threads: threads as never,
    projects: projects as never,
    projection,
    workingDirectories,
    resolveDriver: (id) =>
      options.resolveDriver === undefined
        ? defaultDriver
        : options.resolveDriver(id, defaultDriver),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.supportsAttachments === undefined
      ? {}
      : { supportsAttachments: options.supportsAttachments }),
    ...(options.supportsModelSwitch === undefined
      ? {}
      : { supportsModelSwitch: options.supportsModelSwitch }),
    ...(options.withoutConversationHandoff === true
      ? {}
      : {
          selectConversationHandoff:
            options.selectConversationHandoff ??
            ((thread, purpose) =>
              admittedParentWorkContext({
                threadId: thread.id,
                purpose,
                externalContentIngested: options.externalContentIngested === true,
                readThread: () => thread,
                readTurns: (id) => projection.listForThread(id),
              })),
        }),
    turnRuntime: options.turnRuntime ?? defaultRuntime,
    ...(options.safeInputBudgetTokens === undefined
      ? {}
      : { safeInputBudgetTokens: options.safeInputBudgetTokens }),
    ...(options.resolveSelectedExtensions === undefined
      ? {}
      : { resolveSelectedExtensions: options.resolveSelectedExtensions }),
    ...(options.resolveFileMentionContext === undefined
      ? {}
      : { resolveFileMentionContext: options.resolveFileMentionContext }),
    ...(options.resolveAppManagedTools === undefined
      ? {}
      : { resolveAppManagedTools: options.resolveAppManagedTools }),
    ...(options.nativeHarness === undefined ? {} : { nativeHarness: options.nativeHarness }),
    ...(options.spendCeiling === undefined ? {} : { spendCeiling: options.spendCeiling }),
    ...(options.projectStatusFiles === undefined
      ? {}
      : { projectStatusFiles: options.projectStatusFiles }),
    ...(options.turnFileObserver === undefined
      ? {}
      : { turnFileObserver: options.turnFileObserver }),
    ...(options.onTurnRequested === undefined ? {} : { onTurnRequested: options.onTurnRequested }),
    ...(options.onTurnCancelled === undefined ? {} : { onTurnCancelled: options.onTurnCancelled }),
    ...(options.agentRuns === undefined ? {} : { agentRuns: options.agentRuns }),
    ...(options.runningAccess === undefined ? {} : { runningAccess: options.runningAccess }),
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n === 1 ? ids.session : `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      };
    })(),
    clock: () => now,
  });

  const waitForIdle = async (requestId = ids.request) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const turn = projection.lookup(requestId);
      if (
        turn !== undefined &&
        (turn.status === "completed" ||
          turn.status === "cancelled" ||
          turn.status === "failed" ||
          turn.status === "waiting")
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  return {
    service,
    persistence,
    projection,
    threads,
    projects,
    workingDirectories,
    acquireInputs,
    waitForIdle,
  };
}

/** The status file on a pretend disk keyed by absolute path. */
function inMemoryStatusFiles(disk: Map<string, string>): WorkProjectStatusFiles {
  return new WorkProjectStatusFiles({
    realpath: async (path) => path,
    lstat: async (path) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return { isFile: true, isSymbolicLink: false, size: text.length, mtimeMs: 0 };
    },
    readFile: async (path) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    createFile: async (path, text) => {
      if (disk.has(path)) throw new Error("EEXIST");
      disk.set(path, text);
    },
    replaceFile: async (path, text) => {
      if (!disk.has(path)) throw new Error("ENOENT");
      disk.set(path, text);
    },
  });
}

function workProject(
  overrides: Partial<Extract<Project, { readonly type: "work" }>> = {},
): Extract<Project, { readonly type: "work" }> {
  return {
    id: ids.project,
    type: "work",
    name: "Knowledge",
    lifecycle: "active",
    pinned: false,
    rank: "0/1" as never,
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
    binding: { canonicalRoot: "/private/tmp/knowledge" },
    bindingHistory: [
      {
        revisionId: ids.binding as never,
        revision: 1,
        currentBinding: { canonicalRoot: "/private/tmp/knowledge" },
        actor: {
          kind: "local-user",
          actorId: "72000000-0000-4000-8000-000000000009" as never,
        },
        changedAt: now as never,
      },
    ],
    ...overrides,
  } as Extract<Project, { readonly type: "work" }>;
}

function workRunFor(parentThreadId: string, overrides: Record<string, unknown> = {}): AgentRun {
  return decodeAgentRun({
    id: "d4a1b000-0000-4000-8000-000000000001",
    requestId: "d4a1b000-0000-4000-8000-000000000002",
    parentThreadId,
    depth: 0,
    role: "research",
    task: "Summarize the design.",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "completed",
    authority: {
      filesystem: true,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
    routingReceipt: {
      executionResolution: {
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        executionPolicy: "plan",
        permissionPersistence: "current-session",
        effectivePermissions: {
          filesystem: true,
          shell: false,
          git: false,
          network: true,
          tools: true,
          subagents: false,
        },
        source: "project-default",
        fallbackChain: ["project-default"],
        downgradeReasons: [],
      },
      selectedExecutionKind: "octant-managed",
      attemptedExecutionKind: "provider-native",
      selectedProviderInstanceId: ids.provider,
      selectedModelId: "model-a",
      fallbackCandidates: [],
      capabilityDegradations: [],
      contextSnapshotId: "d4a1b000-0000-4000-8000-000000000004",
      effectiveAuthorityDigest: "digest-1",
      usageQuality: "provider-reported",
      hostId: "local",
      mode: "work",
    },
    workspaceReceipt: {
      kind: "work-root",
      mode: "work",
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      canonicalRoot: "/tmp/work-root",
    },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 4,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A summary provider that answers one prompt with `summary` and a usage report. */
function summaryDriver(summary: string): ProviderDriver {
  const queue = Effect.runSync(Queue.unbounded<never>());
  const connection = {
    subscribe: Effect.succeed(Stream.fromQueue(queue)),
    start: (input: { readonly sessionId: string }) =>
      Effect.succeed({ sessionId: input.sessionId }),
    send: (input: { readonly sessionId: string }) =>
      Effect.gen(function* () {
        yield* Queue.offer(queue, {
          kind: "text-delta",
          sessionId: input.sessionId,
          text: summary,
        } as never);
        yield* Queue.offer(queue, {
          kind: "usage",
          sessionId: input.sessionId,
          inputTokens: 600,
          outputTokens: 12,
        } as never);
        yield* Queue.offer(queue, { kind: "completed", sessionId: input.sessionId } as never);
      }),
    interrupt: () => Effect.void,
    stop: () => Effect.void,
    answerApproval: () => Effect.void,
    answerUserInput: () => Effect.void,
    answerTool: () => Effect.void,
  };
  return { acquire: () => Effect.succeed(connection) } as never;
}

it("requires returned Side Chat provenance before Work runtime admission and retains the exact selected reference", async () => {
  const sideChatReturns = [
    {
      sidecarThreadId: ids.project,
      sourceThreadId: ids.thread,
      sourceMode: "work",
      turnId: ids.turn,
      attemptId: ids.request,
      answerDigest: "a".repeat(64),
    },
  ];
  const missing = serviceFixture();
  await expect(
    missing.service.startFirstTurn(ids.window, { ...startCommand(), sideChatReturns }),
  ).rejects.toMatchObject({ failure: { category: "unavailable" } });
  expect(missing.projection.listForThread(ids.thread)).toHaveLength(0);
  const resolveSideChatReturns = vi.fn(
    async () => "Original selected answer reference; no execution approval.",
  );
  const run = vi
    .fn<WorkTurnRuntimePort["run"]>()
    .mockResolvedValue({ kind: "completed", response: "reply" });
  const valid = serviceFixture({ resolveSideChatReturns, turnRuntime: { run } });
  await valid.service.startFirstTurn(ids.window, { ...startCommand(), sideChatReturns });
  await valid.waitForIdle();
  expect(resolveSideChatReturns).toHaveBeenCalledWith({
    references: sideChatReturns,
    readerThreadId: String(ids.thread),
    mode: "work",
    windowId: ids.window,
  });
  expect(valid.projection.listForThread(ids.thread)[0]?.sideChatReturns).toEqual(sideChatReturns);
  expect(run).toHaveBeenCalledOnce();
});

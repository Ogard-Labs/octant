import {
  type AggregateVersion,
  type UtcTimestamp,
  decodeThreadWorkingDirectory,
  decodeWorkThread,
  decodeProviderModel,
  decodeWorkThreadBootstrap,
  decodeWorkThreadId,
  decodeProjectId,
  decodeProviderInstance,
  decodeWindowId,
  decodeWorkTurnAuthority,
  decodeWorkTurnState,
  type EventEnvelope,
  type Project,
  type WorkThreadId,
  type WorkTurnState,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import type { TerminalSessionImportPort } from "../terminalSessions/terminalSessionImports";
import { WorkThreadProjection } from "./workThreadProjection";
import {
  WorkThreadService,
  WorkThreadServiceError,
  type WorkThreadServiceDependencies,
} from "./workThreadService";

const now = "2026-07-26T21:00:00.000Z" as UtcTimestamp;
const ids = {
  window: decodeWindowId("72000000-0000-4000-8000-000000000001"),
  project: decodeProjectId("72000000-0000-4000-8000-000000000002"),
  chatProject: decodeProjectId("72000000-0000-4000-8000-000000000003"),
  thread: decodeWorkThreadId("72000000-0000-4000-8000-000000000004"),
  provider: "72000000-0000-4000-8000-000000000005",
  binding: "72000000-0000-4000-8000-000000000008",
} as const;

describe("WorkThreadService", () => {
  it("bootstraps only threads from accessible active Work Projects", async () => {
    const allowed = thread();
    const hidden = thread({
      id: "72000000-0000-4000-8000-000000000006" as never,
      projectId: "72000000-0000-4000-8000-000000000007" as never,
      title: "Hidden",
      updatedAt: "2026-07-26T21:10:00.000Z" as UtcTimestamp,
    });
    const fixture = serviceFixture({ threads: [allowed, hidden] });

    await expect(fixture.service.bootstrap(ids.window)).resolves.toEqual(
      decodeWorkThreadBootstrap({
        threads: [allowed],
        // Nothing saved yet: new threads ask first and have no default model.
        settings: { defaultAccess: "ask-first", version: 0, updatedAt: "2026-07-26T21:00:00.000Z" },
      }),
    );
    expect(fixture.projects.bootstrap).toHaveBeenCalledWith(ids.window);
  });

  it("reads navigation from projections without bootstrapping Projects", async () => {
    const allowed = thread();
    const archived = thread({
      id: "72000000-0000-4000-8000-000000000009" as never,
      lifecycle: "archived",
    });
    const deleted = thread({
      id: "72000000-0000-4000-8000-000000000010" as never,
      lifecycle: "deleted",
    });
    const fixture = serviceFixture({ threads: [allowed, archived, deleted] });

    await expect(fixture.service.navigation(ids.window)).resolves.toEqual({
      threads: [allowed],
      runtime: [{ threadId: allowed.id, executing: false }],
    });
    expect(fixture.projects.bootstrap).not.toHaveBeenCalled();
  });

  it("carries a running turn's start time and latest step onto its navigation row and bootstrap", async () => {
    const running = thread();
    const idle = thread({ id: "72000000-0000-4000-8000-000000000006" as never });
    const fixture = serviceFixture({
      threads: [running, idle],
      observeRuntime: (threadId) =>
        String(threadId) === String(running.id)
          ? {
              executing: false,
              awaitingInput: true,
              awaitingKind: "approval",
              turnStartedAt: now,
              liveStep: { kind: "waiting", reason: "approval" },
            }
          : { executing: false },
    });

    const navigation = await fixture.service.navigation(ids.window);
    expect(navigation.runtime).toEqual([
      {
        threadId: running.id,
        executing: false,
        awaitingInput: true,
        awaitingKind: "approval",
        turnStartedAt: now,
        liveStep: { kind: "waiting", reason: "approval" },
      },
      { threadId: idle.id, executing: false },
    ]);
    const bootstrap = await fixture.service.bootstrap(ids.window);
    expect(bootstrap.runtime[0]).toMatchObject({
      turnStartedAt: now,
      liveStep: { kind: "waiting", reason: "approval" },
    });
  });

  it("marks only the Project's newest open thread when a status date is due", async () => {
    const older = thread();
    const newest = thread({
      id: "72000000-0000-4000-8000-000000000006" as never,
      title: "Renewal prep",
      updatedAt: "2026-07-26T22:00:00.000Z" as UtcTimestamp,
    });
    const completed = thread({
      id: "72000000-0000-4000-8000-000000000007" as never,
      title: "Signed offer",
      completedAt: "2026-07-26T23:00:00.000Z" as UtcTimestamp,
      updatedAt: "2026-07-26T23:00:00.000Z" as UtcTimestamp,
    });
    const projectDueReminder = vi.fn(async () => ({
      date: "2026-07-20" as const,
      text: "Offer v2 signature window closed",
      state: "overdue" as const,
    }));
    const fixture = serviceFixture({
      threads: [older, newest, completed],
      project: { ...workProject(), statusFile: "enabled" } as Project,
      projectDueReminder,
    });

    const navigation = await fixture.service.navigation(ids.window);
    const byThread = new Map(
      navigation.runtime.map((entry) => [String(entry.threadId), entry] as const),
    );
    expect(byThread.get(String(newest.id))).toEqual({
      threadId: newest.id,
      executing: false,
      followUpDue: {
        date: "2026-07-20",
        text: "Offer v2 signature window closed",
        state: "overdue",
      },
    });
    expect(byThread.get(String(older.id))).toEqual({ threadId: older.id, executing: false });
    expect(byThread.get(String(completed.id))).toEqual({
      threadId: completed.id,
      executing: false,
    });
    expect(projectDueReminder).toHaveBeenCalledTimes(1);
  });

  it("leaves the reminder off when the Project keeps no status file, the read fails, or nothing is due", async () => {
    const unread = vi.fn(async () => ({
      date: "2026-07-20" as const,
      text: "Left over from before the setting",
      state: "overdue" as const,
    }));
    const optedOut = serviceFixture({ threads: [thread()], projectDueReminder: unread });
    await expect(optedOut.service.navigation(ids.window)).resolves.toMatchObject({
      runtime: [{ threadId: ids.thread, executing: false }],
    });
    expect(unread).not.toHaveBeenCalled();

    const enabled = { ...workProject(), statusFile: "enabled" } as Project;
    const failing = serviceFixture({
      threads: [thread()],
      project: enabled,
      projectDueReminder: vi.fn(async () => {
        throw new Error("folder refused the read");
      }),
    });
    await expect(failing.service.navigation(ids.window)).resolves.toMatchObject({
      runtime: [{ threadId: ids.thread, executing: false }],
    });

    const quiet = serviceFixture({
      threads: [thread()],
      project: enabled,
      projectDueReminder: vi.fn(async () => undefined),
    });
    await expect(quiet.service.navigation(ids.window)).resolves.toMatchObject({
      runtime: [{ threadId: ids.thread, executing: false }],
    });
  });

  it("does not read a deleted Work thread from its durable projection", async () => {
    const deleted = thread({ lifecycle: "deleted" });
    const fixture = serviceFixture({ threads: [deleted] });

    await expect(fixture.service.read(ids.window, ids.thread)).resolves.toBeUndefined();
  });

  it("creates a thread for the active Work Project with a local-user event", async () => {
    const fixture = serviceFixture({ threads: [] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
      }),
    ).resolves.toEqual({ kind: "thread-created", thread: thread() });
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: "work-thread", aggregateId: ids.thread },
        expectedVersion: 0,
        events: [
          expect.objectContaining({
            eventName: "work.thread-created@1",
            actor: {
              kind: "local-user",
              actorId: "00000000-0000-4000-8000-000000000002",
            },
            payload: { kind: "thread-created", thread: thread() },
          }),
        ],
      }),
    );
  });

  it("marks a thread a host caller makes from a marked thread before journaling it, or refuses it", async () => {
    const command = {
      kind: "create-work-thread",
      threadId: ids.thread,
      projectId: ids.project,
      title: "Draft brief",
      providerInstanceId: ids.provider,
      modelId: "model-a",
      hostId: "local",
      bindingRevisionId: ids.binding,
    };
    const inheritedMark = {
      sourceLabel: "follow-up",
      contentReference: "follow-up-source-thread-new-thread",
    };
    const record = vi.fn<
      NonNullable<WorkThreadServiceDependencies["recordExternalContentIngestion"]>
    >(() => ({
      kind: "recorded",
      taint: { externalContentIngested: true, ingestedSources: ["follow-up"] },
    }));
    const marked = serviceFixture({ threads: [], recordExternalContentIngestion: record });

    await expect(
      marked.service.execute(ids.window, command, { inheritedMark }),
    ).resolves.toMatchObject({ kind: "thread-created" });
    expect(record).toHaveBeenCalledWith({
      threadId: ids.thread,
      provenance: { origin: "external-content", sourceLabel: "follow-up" },
      contentReference: inheritedMark.contentReference,
      correlationId: expect.any(String),
      authorized: true,
    });
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      marked.persistence.journal.append.mock.invocationCallOrder[0] ?? 0,
    );

    const refused = serviceFixture({
      threads: [],
      recordExternalContentIngestion: () => ({ kind: "refused", reason: "malformed" }),
    });
    await expect(
      refused.service.execute(ids.window, command, { inheritedMark }),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(refused.persistence.journal.append).not.toHaveBeenCalled();
    expect(refused.projection.read(ids.thread)).toBeUndefined();
  });

  it("starts a thread from a terminal session in the Project's folder, marked before it exists, or refuses one from elsewhere", async () => {
    const command = {
      kind: "create-work-thread",
      threadId: ids.thread,
      projectId: ids.project,
      title: "Draft brief",
      providerInstanceId: ids.provider,
      modelId: "model-a",
      hostId: "local",
      bindingRevisionId: ids.binding,
      terminalSession: { provider: "claude", sessionId: "0b4c1f2e-1111-4111-8111-111111111111" },
    } as const;
    const prepared = {
      mark: {
        sourceLabel: "terminal-session",
        contentReference: "terminal-session-claude-0b4c1f2e-1111-4111-8111-111111111111",
      },
      imported: { title: "Upload test flake" } as never,
    };
    const terminalSessions = {
      prepare: vi.fn<TerminalSessionImportPort["prepare"]>(async (_request, folder) =>
        folder === "/private/tmp/knowledge"
          ? { status: "ready", prepared }
          : { status: "refused", message: "That terminal session was started in another folder." },
      ),
      journalImported: vi.fn<TerminalSessionImportPort["journalImported"]>(),
    };
    const record = vi.fn<
      NonNullable<WorkThreadServiceDependencies["recordExternalContentIngestion"]>
    >(() => ({
      kind: "recorded",
      taint: { externalContentIngested: true, ingestedSources: ["terminal-session"] },
    }));
    const imported = serviceFixture({
      threads: [],
      recordExternalContentIngestion: record,
      terminalSessions,
    });

    await expect(imported.service.execute(ids.window, command as never)).resolves.toMatchObject({
      kind: "thread-created",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: ids.thread,
        provenance: { origin: "external-content", sourceLabel: "terminal-session" },
        contentReference: prepared.mark.contentReference,
      }),
    );
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      imported.persistence.journal.append.mock.invocationCallOrder[0] ?? 0,
    );
    expect(terminalSessions.journalImported).toHaveBeenCalledWith(String(ids.thread), prepared);
    expect(imported.persistence.journal.transaction).toHaveBeenCalledTimes(1);

    const elsewhere = serviceFixture({
      threads: [],
      project: { ...workProject(), binding: { canonicalRoot: "/private/tmp/other" } } as never,
      recordExternalContentIngestion: record,
      terminalSessions,
    });
    await expect(elsewhere.service.execute(ids.window, command as never)).rejects.toMatchObject({
      failure: {
        category: "invalid",
        message: "That terminal session was started in another folder.",
      },
    });
    expect(elsewhere.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("refuses a thread that starts from both an issue and a terminal session", async () => {
    const terminalSessions = {
      prepare: vi.fn<TerminalSessionImportPort["prepare"]>(),
      journalImported: vi.fn<TerminalSessionImportPort["journalImported"]>(),
    };
    const fixture = serviceFixture({ threads: [], terminalSessions });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
        issueContext: { owner: "octant", name: "octant", number: 7 },
        terminalSession: { provider: "claude", sessionId: "0b4c1f2e-1111-4111-8111-111111111111" },
      } as never),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(terminalSessions.prepare).not.toHaveBeenCalled();
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("attributes a routine's thread to the routine, not to an open window", async () => {
    const fixture = serviceFixture({ threads: [] });

    await fixture.service.execute(ROUTINE_HOST_SCOPE_ID, {
      kind: "create-work-thread",
      threadId: ids.thread,
      projectId: ids.project,
      title: "Draft brief",
      providerInstanceId: ids.provider,
      modelId: "model-a",
      hostId: "local",
      bindingRevisionId: ids.binding,
    });
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            eventName: "work.thread-created@1",
            actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" },
          }),
        ],
      }),
    );
  });

  it("starts a new thread with the access Work settings give it, and refuses a stale settings save", async () => {
    const fixture = serviceFixture({ threads: [] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "update-work-settings",
        expectedVersion: 0,
        defaultAccess: "auto-accept-edits",
      }),
    ).resolves.toMatchObject({
      kind: "settings-updated",
      settings: { defaultAccess: "auto-accept-edits", version: 1 },
    });
    expect(fixture.persistence.journal.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        aggregate: {
          aggregateType: "work-settings",
          aggregateId: "00000000-0000-4000-8000-000000000030",
        },
        expectedVersion: 0,
      }),
    );
    // A save made against the version before it is refused, not merged.
    await expect(
      fixture.service.execute(ids.window, {
        kind: "update-work-settings",
        expectedVersion: 0,
        defaultAccess: "ask-first",
      }),
    ).rejects.toMatchObject({ failure: { category: "stale" } });

    const created = await fixture.service.execute(ids.window, {
      kind: "create-work-thread",
      threadId: ids.thread,
      projectId: ids.project,
      title: "Draft brief",
      providerInstanceId: ids.provider,
      modelId: "model-a",
      hostId: "local",
      bindingRevisionId: ids.binding,
    });
    expect(created).toMatchObject({
      kind: "thread-created",
      thread: { access: "auto-accept-edits" },
    });
  });

  it("refuses to create a thread when promised GitHub issue context cannot be loaded", async () => {
    const fixture = serviceFixture({
      threads: [],
      issueContext: {
        prepare: vi.fn(async () => ({
          status: "refused" as const,
          reason: "unauthorized" as const,
          message: "The selected GitHub issue could not be loaded. The thread was not created.",
        })),
        bindCreatedThread: vi.fn(),
        peekFramedForFirstTurn: vi.fn(),
        consumeFramedForFirstTurn: vi.fn(),
        takeFramedForFirstTurn: vi.fn(),
      },
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
        issueContext: { owner: "octant", name: "octant", number: 7 },
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unauthorized",
        message: "The selected GitHub issue could not be loaded. The thread was not created.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("refuses to create a thread when promised Linear issue context cannot be loaded", async () => {
    const fixture = serviceFixture({
      threads: [],
      linearIssueContext: {
        prepare: vi.fn(async () => ({
          status: "refused" as const,
          reason: "unauthorized" as const,
          message: "The selected Linear issue could not be loaded. The thread was not created.",
        })),
        bindCreatedThread: vi.fn(),
        peekFramedForFirstTurn: vi.fn(),
        consumeFramedForFirstTurn: vi.fn(),
        takeFramedForFirstTurn: vi.fn(),
      },
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
        linearIssueContext: { id: "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unauthorized",
        message: "The selected Linear issue could not be loaded. The thread was not created.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("still creates a thread when recording issue-context taint throws", async () => {
    const fixture = serviceFixture({
      threads: [],
      issueContext: {
        prepare: vi.fn(async () => ({
          status: "ready" as const,
          framed: {
            section: "workspace-context" as const,
            text: "framed",
          },
        })),
        bindCreatedThread: vi.fn(() => {
          throw new Error("taint journal failed");
        }),
        peekFramedForFirstTurn: vi.fn(),
        consumeFramedForFirstTurn: vi.fn(),
        takeFramedForFirstTurn: vi.fn(),
      },
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
        issueContext: { owner: "octant", name: "octant", number: 7 },
      }),
    ).resolves.toEqual({ kind: "thread-created", thread: thread() });
    expect(fixture.persistence.journal.append).toHaveBeenCalled();
  });

  it("requires an enabled provider instance and active Work Project", async () => {
    const fixture = serviceFixture({
      threads: [],
      providerEnabled: false,
      accessibleProjects: [],
      project: {
        id: ids.chatProject,
        type: "chat",
        name: "Chat only",
        lifecycle: "active",
        pinned: false,
        rank: "0/1" as never,
        version: 1 as never,
        createdAt: now as never,
        updatedAt: now as never,
      } as Project,
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unauthorized",
        message: "Work Project is unavailable for this window.",
      }),
    );

    fixture.projects.bootstrap.mockResolvedValue({
      active: [
        {
          id: ids.project,
          type: "work",
          name: "Knowledge",
          lifecycle: "active",
        },
      ],
      archived: [],
    });
    fixture.persistence.readProject.mockReturnValue(workProject());

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unavailable",
        message: "Selected Work provider is unavailable.",
      }),
    );
  });

  it("rejects a create when the selected model lacks verified Work tool authority", async () => {
    const probeProvider = vi.fn(
      async () =>
        ({
          readiness: "ready",
          models: [
            {
              id: "model-a",
              displayName: "Chat-only model",
              source: "discovered",
              verification: "unverified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            },
          ],
        }) as never,
    );
    const fixture = serviceFixture({ threads: [], probeProvider });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Draft brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unsupported",
        message: "Selected Work model has no verified tool authority.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("admits native-agent provider models whose runtime supplies tool execution", async () => {
    const probeProvider = vi.fn(
      async () =>
        ({
          readiness: "ready",
          models: [
            {
              id: "model-a",
              displayName: "Codex runtime model",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            },
          ],
        }) as never,
    );
    const fixture = serviceFixture({
      threads: [],
      probeProvider,
      providerDriverKind: "codex",
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Native brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
      }),
    ).resolves.toMatchObject({ kind: "thread-created" });
  });

  it("admits an explicitly verified Azure Foundry deployment", async () => {
    const probeProvider = vi.fn(
      async () =>
        ({
          readiness: "ready",
          models: [
            {
              id: "model-a",
              displayName: "Foundry deployment",
              source: "discovered",
              verification: "verified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            },
          ],
          verifiedToolModelIds: ["model-a"],
        }) as never,
    );
    const fixture = serviceFixture({
      threads: [],
      probeProvider,
      providerDriverKind: "azure-foundry",
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "create-work-thread",
        threadId: ids.thread,
        projectId: ids.project,
        title: "Foundry brief",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        hostId: "local",
        bindingRevisionId: ids.binding,
      }),
    ).resolves.toMatchObject({ kind: "thread-created" });
  });

  it("revalidates exact Project authority after an asynchronous provider probe", async () => {
    let resolveProbe: ((value: unknown) => void) | undefined;
    const probeProvider = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }) as never,
    );
    const fixture = serviceFixture({ threads: [], probeProvider });
    const creating = fixture.service.execute(ids.window, {
      kind: "create-work-thread",
      threadId: ids.thread,
      projectId: ids.project,
      title: "Native brief",
      providerInstanceId: ids.provider,
      modelId: "model-a",
      hostId: "local",
      bindingRevisionId: ids.binding,
    });
    await vi.waitFor(() => expect(probeProvider).toHaveBeenCalledOnce());
    fixture.projects.bootstrap.mockResolvedValue({ active: [], archived: [] });
    fixture.persistence.readProject.mockReturnValue({
      ...workProject(),
      lifecycle: "archived",
    } as Project);
    resolveProbe?.({
      readiness: "ready",
      models: [
        {
          id: "model-a",
          displayName: "Verified model",
          source: "discovered",
          verification: "verified",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
          capabilityEvidence: [
            {
              capability: "tool-calling",
              support: "supported",
              source: "provider-metadata",
              confidence: "high",
              observedAt: now,
            },
          ],
        },
      ],
    });

    await expect(creating).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unauthorized",
        message: "Work Project is unavailable for this window.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("revalidates provider authority after an asynchronous provider probe", async () => {
    let resolveProbe: ((value: unknown) => void) | undefined;
    const probeProvider = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }) as never,
    );
    const fixture = serviceFixture({ threads: [], probeProvider });
    const initialProvider = fixture.persistence.readProviderInstance()!;
    fixture.persistence.readProviderInstance.mockReturnValue(initialProvider);
    const creating = fixture.service.execute(ids.window, {
      kind: "create-work-thread",
      threadId: ids.thread,
      projectId: ids.project,
      title: "Native brief",
      providerInstanceId: ids.provider,
      modelId: "model-a",
      hostId: "local",
      bindingRevisionId: ids.binding,
    });
    await vi.waitFor(() => expect(probeProvider).toHaveBeenCalledOnce());
    fixture.persistence.readProviderInstance.mockReturnValue({
      ...initialProvider,
      enabled: false,
      version: 2,
    } as never);
    resolveProbe?.({
      readiness: "ready",
      models: [
        {
          id: "model-a",
          displayName: "Verified model",
          source: "discovered",
          verification: "verified",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
          capabilityEvidence: [
            {
              capability: "tool-calling",
              support: "supported",
              source: "provider-metadata",
              confidence: "high",
              observedAt: now,
            },
          ],
        },
      ],
    });

    await expect(creating).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unavailable",
        message: "Selected Work provider changed; reload and retry.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("records the thread's choice of Claude artifacts and refuses it on an archived thread", async () => {
    const fixture = serviceFixture({ threads: [thread()] });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "change-work-thread-document-delivery",
        threadId: ids.thread,
        expectedVersion: 1,
        documentDelivery: "native-artifacts",
      }),
    ).resolves.toEqual({
      kind: "thread-updated",
      thread: thread({
        documentDelivery: "native-artifacts",
        version: 2 as AggregateVersion,
        updatedAt: now,
      }),
    });
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            eventName: "work.thread-updated@1",
            payload: expect.objectContaining({
              thread: expect.objectContaining({ documentDelivery: "native-artifacts" }),
            }),
          }),
        ],
      }),
    );

    const archived = serviceFixture({ threads: [thread({ lifecycle: "archived" })] });
    await expect(
      archived.service.execute(ids.window, {
        kind: "change-work-thread-document-delivery",
        threadId: ids.thread,
        expectedVersion: 1,
        documentDelivery: "native-artifacts",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("updates thread metadata with optimistic versions and maps concurrency conflicts", async () => {
    const current = thread();
    const fixture = serviceFixture({ threads: [current] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "rename-work-thread",
        threadId: ids.thread,
        expectedVersion: 1,
        title: "Reviewed brief",
      }),
    ).resolves.toEqual({
      kind: "thread-updated",
      thread: thread({
        title: "Reviewed brief",
        version: 2 as AggregateVersion,
        updatedAt: now,
      }),
    });

    fixture.persistence.journal.append.mockImplementationOnce(() => {
      throw new ConcurrencyConflict({
        aggregateType: "work-thread",
        aggregateId: String(ids.thread),
        expectedVersion: 1,
        actualVersion: 2,
      });
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "change-work-thread-lifecycle",
        threadId: ids.thread,
        expectedVersion: 1,
        lifecycle: "archived",
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "stale",
        message: "Work thread changed; reload and retry.",
      }),
    );
  });

  it("lets a person mark a Work thread Done with no evidence text", async () => {
    const fixture = serviceFixture({ threads: [thread()] });

    const marked = await fixture.service.execute(ids.window, {
      kind: "confirm-work-thread-completion",
      threadId: ids.thread,
      expectedVersion: 1,
      deliveryTarget: "Draft brief",
    });
    expect(marked).toMatchObject({
      kind: "thread-completion-confirmed",
      thread: { id: ids.thread, lifecycle: "active", version: 2, completionConfirmed: true },
    });
    if (!("thread" in marked)) throw new Error("Expected the marked thread.");
    // No note means no evidence record, so a paired phone on an older build
    // still decodes the thread.
    expect(marked.thread).not.toHaveProperty("completionEvidence");
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({
            eventName: "work.thread-completion-confirmed@1",
            actor: expect.objectContaining({ kind: "local-user" }),
          }),
        ],
      }),
    );

    await expect(
      fixture.service.execute(ids.window, {
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 2,
        deliveryTarget: "Draft brief",
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "invalid",
        message: "Work thread completion was already confirmed.",
      }),
    );
  });

  it("keeps an evidence note an older client sends with the mark", async () => {
    const fixture = serviceFixture({ threads: [thread()] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 1,
        deliveryTarget: "Draft brief",
        satisfactionEvidence: "The requested brief was reviewed and saved.",
      }),
    ).resolves.toMatchObject({
      kind: "thread-completion-confirmed",
      thread: {
        completionConfirmed: true,
        completionEvidence: {
          deliveryTarget: "Draft brief",
          satisfactionEvidence: "The requested brief was reviewed and saved.",
        },
      },
    });
  });

  it("refuses a routine or anything else acting as the host when it tries to mark a thread Done", async () => {
    const fixture = serviceFixture({ threads: [thread()] });

    await expect(
      fixture.service.execute(ROUTINE_HOST_SCOPE_ID, {
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 1,
        deliveryTarget: "Draft brief",
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "unauthorized",
        message: "Only a person can mark a Work thread Done.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
    expect(fixture.projection.read(ids.thread)?.completionConfirmed).toBeUndefined();
  });

  it("refuses a mark that names a different delivery target than the thread holds", async () => {
    const fixture = serviceFixture({ threads: [thread()] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 1,
        deliveryTarget: "A different request",
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "invalid",
        message: "Work completion must identify the current delivery target.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("clears confirmed completion when an archived thread is reactivated", async () => {
    const fixture = serviceFixture({ threads: [thread()] });

    await fixture.service.execute(ids.window, {
      kind: "confirm-work-thread-completion",
      threadId: ids.thread,
      expectedVersion: 1,
      deliveryTarget: "Draft brief",
    });
    await fixture.service.execute(ids.window, {
      kind: "change-work-thread-lifecycle",
      threadId: ids.thread,
      expectedVersion: 2,
      lifecycle: "archived",
    });

    const reactivated = await fixture.service.execute(ids.window, {
      kind: "change-work-thread-lifecycle",
      threadId: ids.thread,
      expectedVersion: 3,
      lifecycle: "active",
    });
    expect(reactivated).toMatchObject({
      kind: "thread-updated",
      thread: { lifecycle: "active", version: 4 },
    });
    if (!("thread" in reactivated)) throw new Error("Expected the thread update.");
    expect(reactivated.thread).not.toHaveProperty("completionConfirmed");
    expect(reactivated.thread).not.toHaveProperty("completionEvidence");

    await expect(
      fixture.service.execute(ids.window, {
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 4,
        deliveryTarget: "Draft brief",
      }),
    ).resolves.toMatchObject({
      kind: "thread-completion-confirmed",
      thread: { version: 5 },
    });
  });

  it("refuses a provider or model change on a thread a person marked Done until it is reactivated", async () => {
    const fixture = serviceFixture({ threads: [thread({ completionConfirmed: true })] });
    const change = (expectedVersion: number) =>
      fixture.service.execute(ids.window, {
        kind: "change-work-thread-provider",
        threadId: ids.thread,
        expectedVersion,
        providerInstanceId: ids.provider,
        modelId: "model-b",
      });

    await expect(change(1)).rejects.toEqual(
      new WorkThreadServiceError({
        category: "invalid",
        message:
          "This task is marked Done. Archive and reactivate it before changing its provider.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();

    for (const [expectedVersion, lifecycle] of [
      [1, "archived"],
      [2, "active"],
    ] as const) {
      await fixture.service.execute(ids.window, {
        kind: "change-work-thread-lifecycle",
        threadId: ids.thread,
        expectedVersion,
        lifecycle,
      });
    }
    await expect(change(3)).resolves.toMatchObject({
      kind: "thread-updated",
      thread: { modelId: "model-b", version: 4 },
    });
  });

  it("rejects lifecycle commands that do not make a real transition", async () => {
    const fixture = serviceFixture({ threads: [thread()] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "change-work-thread-lifecycle",
        threadId: ids.thread,
        expectedVersion: 1,
        lifecycle: "active",
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "invalid",
        message: "Work thread already has that lifecycle.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("refuses undeclared Work reasoning and saves a declared selection", async () => {
    const model = decodeProviderModel({
      id: "model-a",
      displayName: "Reasoning model",
      source: "discovered",
      verification: "verified",
      reasoning: "supported",
      inputModalities: ["text"],
      options: [
        { kind: "selection", id: "effort", displayName: "Effort", values: ["low", "high"] },
      ],
    });
    const fixture = serviceFixture({ readProviderModel: () => model });
    const command = {
      kind: "change-work-thread-provider",
      threadId: ids.thread,
      expectedVersion: 1,
      providerInstanceId: ids.provider,
      modelId: "model-a",
    };
    await expect(
      fixture.service.execute(ids.window, { ...command, modelOptionValues: { effort: "max" } }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
    await fixture.service.execute(ids.window, {
      ...command,
      modelOptionValues: { effort: "high" },
    });
    expect(fixture.projection.read(ids.thread)?.modelOptionValues).toEqual({ effort: "high" });
    expect(fixture.projection.read(ids.thread)?.providerHandoff).toBeUndefined();
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            payload: expect.objectContaining({
              thread: expect.objectContaining({ modelOptionValues: { effort: "high" } }),
            }),
          }),
        ],
      }),
    );
  });

  it("resets reasoning when changing the Work model", async () => {
    const fixture = serviceFixture({
      threads: [thread({ modelOptionValues: { effort: "high" } })],
    });
    await fixture.service.execute(ids.window, {
      kind: "change-work-thread-provider",
      threadId: ids.thread,
      expectedVersion: 1,
      providerInstanceId: ids.provider,
      modelId: "model-b",
    });
    expect(fixture.projection.read(ids.thread)).not.toHaveProperty("modelOptionValues");
  });

  it("changes provider/model without changing Work authority or losing the handoff event", async () => {
    const current = thread({
      workingDirectory: "research/brief" as never,
    });
    const fixture = serviceFixture({ threads: [current] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "change-work-thread-provider",
        threadId: ids.thread,
        expectedVersion: 1,
        providerInstanceId: ids.provider,
        modelId: "model-b",
      }),
    ).resolves.toMatchObject({
      kind: "thread-updated",
      thread: {
        providerInstanceId: ids.provider,
        modelId: "model-b",
        projectId: ids.project,
        workingDirectory: "research/brief",
        providerHandoff: {
          previousProviderInstanceId: ids.provider,
          previousModelId: "model-a",
          nextProviderInstanceId: ids.provider,
          nextModelId: "model-b",
          changedAt: now,
        },
        version: 2,
      },
    });
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({
            eventName: "work.thread-updated@1",
            payload: expect.objectContaining({
              kind: "thread-updated",
              thread: expect.objectContaining({
                providerInstanceId: ids.provider,
                modelId: "model-b",
              }),
            }),
          }),
        ],
      }),
    );
  });

  it("persists a host-validated working directory and rejects unavailable paths", async () => {
    const current = thread();
    const fixture = serviceFixture({ threads: [current] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "change-work-thread-working-directory",
        threadId: ids.thread,
        expectedVersion: 1,
        workingDirectory: "research/brief",
      }),
    ).resolves.toMatchObject({
      kind: "thread-updated",
      thread: { workingDirectory: "research/brief", version: 2 },
    });
    expect(fixture.workingDirectories.resolve).toHaveBeenCalledWith(
      "/private/tmp/knowledge",
      "research/brief",
    );
    expect(fixture.onWorkingDirectoryChanged).toHaveBeenCalledWith({
      mode: "work",
      projectId: ids.project,
      threadId: ids.thread,
    });

    const unavailable = serviceFixture({ threads: [current] });
    unavailable.workingDirectories.resolve.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      unavailable.service.execute(ids.window, {
        kind: "change-work-thread-working-directory",
        threadId: ids.thread,
        expectedVersion: 1,
        workingDirectory: "missing",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });
});

it("validates the target before journaling an unavailable provider", async () => {
  const current = thread();
  const probeProvider = vi.fn(async () => ({ readiness: "unavailable", models: [] }) as never);
  const fixture = serviceFixture({ threads: [current], probeProvider });

  await expect(
    fixture.service.execute(ids.window, {
      kind: "change-work-thread-provider",
      threadId: ids.thread,
      expectedVersion: 1,
      providerInstanceId: ids.provider,
      modelId: "model-b",
    }),
  ).rejects.toEqual(
    new WorkThreadServiceError({
      category: "unavailable",
      message: "Selected Work provider is not ready.",
    }),
  );
  expect(probeProvider).toHaveBeenCalledWith(ids.provider);
  expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  expect(fixture.projection.read(ids.thread)).toEqual(current);
});

function serviceFixture(
  options: {
    readonly threads?: ReadonlyArray<ReturnType<typeof thread>>;
    readonly accessibleProjects?: ReadonlyArray<{
      id: string;
      type: "work";
      name: string;
      lifecycle: "active";
    }>;
    readonly providerEnabled?: boolean;
    readonly providerDriverKind?: "openai-compatible" | "azure-foundry" | "codex";
    readonly probeProvider?: WorkThreadServiceDependencies["probeProvider"];
    readonly readProviderModel?: WorkThreadServiceDependencies["readProviderModel"];
    readonly project?: Project;
    readonly events?: ReadonlyArray<EventEnvelope>;
    readonly issueContext?: WorkThreadServiceDependencies["issueContext"];
    readonly linearIssueContext?: WorkThreadServiceDependencies["linearIssueContext"];
    readonly observeRuntime?: WorkThreadServiceDependencies["observeRuntime"];
    readonly projectDueReminder?: WorkThreadServiceDependencies["projectDueReminder"];
    readonly turns?: ReadonlyArray<WorkTurnState>;
    readonly recordExternalContentIngestion?: WorkThreadServiceDependencies["recordExternalContentIngestion"];
    readonly terminalSessions?: TerminalSessionImportPort;
  } = {},
) {
  const projection = new WorkThreadProjection();
  for (const entry of options.threads ?? [thread()]) {
    projection.apply({ kind: "thread-created", thread: entry });
  }
  const turnProjection = {
    listForThread: vi.fn(
      (threadId: WorkThreadId): ReadonlyArray<WorkTurnState> =>
        (options.turns ?? []).filter((turn) => String(turn.threadId) === String(threadId)),
    ),
  };
  const persistence = {
    status: vi.fn(() => ({ state: "current", integrity: "ok" })),
    readProject: vi.fn(() => options.project ?? workProject()),
    readProviderInstance: vi.fn(() => {
      const driverKind = options.providerDriverKind ?? "openai-compatible";
      return decodeProviderInstance({
        id: ids.provider,
        displayName: "Provider",
        driverKind,
        configuration:
          driverKind === "codex"
            ? { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" }
            : driverKind === "azure-foundry"
              ? {
                  kind: "azure-foundry-openai-http",
                  baseUrl: "https://foundry.example.openai.azure.com/openai/v1/",
                  authentication: "api-key",
                  protocol: "responses",
                  manualModelIds: ["model-a"],
                }
              : {
                  kind: "openai-compatible-http",
                  baseUrl: "https://example.invalid/v1/",
                  authentication: "bearer",
                  protocol: "responses",
                  manualModelIds: ["model-a"],
                },
        enabled: options.providerEnabled ?? true,
        environmentPolicy: "inherit-host",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }),
    journal: {
      append: vi.fn(),
      replay: vi.fn(() => options.events ?? []),
      transaction: vi.fn(<A>(body: () => A): A => body()),
    },
  };
  const projects = {
    bootstrap: vi.fn().mockResolvedValue({
      active: options.accessibleProjects ?? [
        {
          id: ids.project,
          type: "work",
          name: "Knowledge",
          lifecycle: "active",
        },
      ],
      archived: [],
    }),
  };
  const workingDirectories = {
    resolve: vi.fn(async (root: string, relativeDirectory: string) =>
      relativeDirectory === "." ? root : `${root}/${relativeDirectory}`,
    ),
  };
  const onWorkingDirectoryChanged = vi.fn(async () => undefined);
  const service = new WorkThreadService({
    persistence: persistence as never,
    projects: projects as never,
    projection,
    turnProjection,
    uuid: () => "72000000-0000-4000-8000-000000000099",
    clock: () => now,
    workingDirectories,
    onWorkingDirectoryChanged,
    ...(options.probeProvider === undefined ? {} : { probeProvider: options.probeProvider }),
    ...(options.readProviderModel === undefined
      ? {}
      : { readProviderModel: options.readProviderModel }),
    ...(options.issueContext === undefined ? {} : { issueContext: options.issueContext }),
    ...(options.linearIssueContext === undefined
      ? {}
      : { linearIssueContext: options.linearIssueContext }),
    ...(options.observeRuntime === undefined ? {} : { observeRuntime: options.observeRuntime }),
    ...(options.projectDueReminder === undefined
      ? {}
      : { projectDueReminder: options.projectDueReminder }),
    ...(options.recordExternalContentIngestion === undefined
      ? {}
      : { recordExternalContentIngestion: options.recordExternalContentIngestion }),
    ...(options.terminalSessions === undefined
      ? {}
      : { terminalSessions: options.terminalSessions }),
  });
  return {
    service,
    persistence,
    projects,
    projection,
    workingDirectories,
    onWorkingDirectoryChanged,
  };
}

function workProject(): Project {
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
  } as Project;
}

function thread(overrides: Partial<ReturnType<typeof decodeWorkThread>> = {}) {
  return decodeWorkThread({
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
    ...overrides,
  });
}

describe("moving a Work thread to another Project", () => {
  const otherProject = decodeProjectId("72000000-0000-4000-8000-000000000011");
  const otherBinding = "72000000-0000-4000-8000-000000000012";

  function destination(folder: string, overrides: Partial<Project> = {}): Project {
    const base = workProject();
    if (base.type !== "work") throw new Error("fixture must be a Work Project");
    return {
      ...base,
      id: otherProject,
      name: "Elsewhere",
      binding: { canonicalRoot: folder },
      bindingHistory: [
        {
          ...base.bindingHistory[0]!,
          revisionId: otherBinding as never,
          currentBinding: { canonicalRoot: folder },
        },
      ],
      ...overrides,
    } as Project;
  }

  function moveFixture(
    folder: string,
    options: Parameters<typeof serviceFixture>[0] = {},
    destinationOverrides: Partial<Project> = {},
  ) {
    const target = destination(folder, destinationOverrides);
    const fixture = serviceFixture({
      threads: [thread({ workingDirectory: decodeThreadWorkingDirectory("drafts") })],
      accessibleProjects: [
        { id: ids.project, type: "work", name: "Knowledge", lifecycle: "active" },
        { id: otherProject, type: "work", name: "Elsewhere", lifecycle: "active" },
      ],
      ...options,
    });
    fixture.persistence.readProject.mockImplementation(((id: string) =>
      String(id) === String(otherProject) ? target : workProject()) as never);
    return fixture;
  }

  const move = (expectedVersion = 1) =>
    ({
      kind: "move-work-thread",
      threadId: ids.thread,
      expectedVersion,
      projectId: otherProject,
    }) as const;

  it("files the thread into a Project bound to the same folder and journals who moved it", async () => {
    const fixture = moveFixture("/private/tmp/knowledge");
    const result = await fixture.service.execute(ids.window, move());

    expect(result).toMatchObject({
      kind: "thread-updated",
      thread: {
        projectId: otherProject,
        bindingRevisionId: otherBinding,
        workingDirectory: "drafts",
        access: "ask-first",
        title: "Draft brief",
        version: 2,
      },
    });
    expect(fixture.projection.read(ids.thread)?.projectId).toBe(otherProject);
    const append = fixture.persistence.journal.append.mock.calls[0]?.[0];
    expect(append?.events[0]).toMatchObject({
      eventName: "work.thread-updated@1",
      actor: { kind: "local-user" },
      occurredAt: now,
    });
  });

  it("keeps the thread in the same place when the Project's folder contains it", async () => {
    const fixture = moveFixture("/private");
    const result = await fixture.service.execute(ids.window, move());

    expect(result).toMatchObject({
      kind: "thread-updated",
      thread: { projectId: otherProject, workingDirectory: "tmp/knowledge/drafts" },
    });
    expect(fixture.workingDirectories.resolve).toHaveBeenCalledWith(
      "/private",
      "tmp/knowledge/drafts",
    );
  });

  it("refuses a Project bound to a different folder and changes nothing", async () => {
    for (const folder of ["/private/tmp/other", "/private/tmp/knowledge/drafts"]) {
      const fixture = moveFixture(folder);
      await expect(fixture.service.execute(ids.window, move())).rejects.toMatchObject({
        failure: { category: "invalid", message: /different folder/ },
      });
      expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
      expect(fixture.projection.read(ids.thread)?.projectId).toBe(ids.project);
    }
  });

  it("refuses a Chat Project, a Project the window cannot see, and a thread that is running", async () => {
    const chat = moveFixture("/private/tmp/knowledge", {}, { type: "chat" } as never);
    await expect(chat.service.execute(ids.window, move())).rejects.toMatchObject({
      failure: { message: /own kind/ },
    });

    const hidden = moveFixture("/private/tmp/knowledge", {
      accessibleProjects: [
        { id: ids.project, type: "work", name: "Knowledge", lifecycle: "active" },
      ],
    });
    await expect(hidden.service.execute(ids.window, move())).rejects.toMatchObject({
      failure: { message: /not available/ },
    });

    const running = moveFixture("/private/tmp/knowledge", {
      observeRuntime: () => ({ executing: true, awaitingInput: false }),
    });
    await expect(running.service.execute(ids.window, move())).rejects.toMatchObject({
      failure: { message: /running turn/ },
    });
    for (const fixture of [chat, hidden, running]) {
      expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
    }
  });

  it("refuses a move a routine makes as the host, and a stale version", async () => {
    const routine = moveFixture("/private/tmp/knowledge");
    await expect(routine.service.execute(ROUTINE_HOST_SCOPE_ID, move())).rejects.toMatchObject({
      failure: { category: "unauthorized" },
    });

    const stale = moveFixture("/private/tmp/knowledge");
    await expect(stale.service.execute(ids.window, move(7))).rejects.toMatchObject({
      failure: { category: "stale" },
    });
  });

  it("refuses a Project whose provider policy excludes the thread's provider", async () => {
    const fixture = moveFixture("/private/tmp/knowledge", {}, {
      providerPolicy: { mode: "whitelist", providerInstanceIds: [] },
    } as never);
    await expect(fixture.service.execute(ids.window, move())).rejects.toMatchObject({
      failure: { category: "unauthorized" },
    });
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });
});

describe("completing and snoozing a Work thread", () => {
  const later = new Date(Date.parse(now) + 24 * 60 * 60 * 1_000).toISOString();

  it("puts a finished thread away and brings it back with Reopen", async () => {
    const fixture = serviceFixture({ threads: [thread()] });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "complete-work-thread",
        threadId: ids.thread,
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({ kind: "thread-updated", thread: { completedAt: now, version: 2 } });
    expect(fixture.projection.read(ids.thread)?.completedAt).toBe(now);

    await expect(
      fixture.service.execute(ids.window, {
        kind: "reopen-work-thread",
        threadId: ids.thread,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ kind: "thread-updated", thread: { version: 3 } });
    expect(fixture.projection.read(ids.thread)).not.toHaveProperty("completedAt");
  });

  it("refuses to put a thread away while its turn runs or waits on the person", async () => {
    const running = serviceFixture({
      threads: [thread()],
      observeRuntime: () => ({ executing: true, awaitingInput: false }),
    });
    await expect(
      running.service.execute(ids.window, {
        kind: "complete-work-thread",
        threadId: ids.thread,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      failure: { category: "invalid", message: /before putting this thread away/ },
    });

    const waiting = serviceFixture({
      threads: [thread()],
      observeRuntime: () => ({ executing: false, awaitingInput: true }),
    });
    await expect(
      waiting.service.execute(ids.window, {
        kind: "snooze-work-thread",
        threadId: ids.thread,
        expectedVersion: 1,
        until: later,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid", message: /waiting on you/ } });
    expect(running.persistence.journal.append).not.toHaveBeenCalled();
    expect(waiting.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("snoozes a running thread, remembers the turn under way, and wakes it again", async () => {
    const fixture = serviceFixture({
      threads: [thread()],
      observeRuntime: () => ({ executing: true, awaitingInput: false }),
    });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "snooze-work-thread",
        threadId: ids.thread,
        expectedVersion: 1,
        until: later,
      }),
    ).resolves.toMatchObject({
      kind: "thread-updated",
      thread: { snooze: { until: later, at: now, duringTurn: true }, version: 2 },
    });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "wake-work-thread",
        threadId: ids.thread,
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({ kind: "thread-updated", thread: { version: 3 } });
    expect(fixture.projection.read(ids.thread)).not.toHaveProperty("snooze");
    await expect(
      fixture.service.execute(ids.window, {
        kind: "snooze-work-thread",
        threadId: ids.thread,
        expectedVersion: 3,
        until: new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString(),
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid", message: /still ahead/ } });
  });

  it("brings a resting thread back when a person asks it for a turn, and journals nothing otherwise", () => {
    const resting = serviceFixture({
      threads: [thread({ completedAt: now as never, snooze: { until: later, at: now } as never })],
    });
    resting.service.noteTurnRequested(ids.thread);
    expect(resting.persistence.journal.append).toHaveBeenCalledTimes(1);
    const back = resting.projection.read(ids.thread);
    expect(back?.version).toBe(2);
    expect(back).not.toHaveProperty("completedAt");
    expect(back).not.toHaveProperty("snooze");

    const inPlay = serviceFixture({ threads: [thread()] });
    inPlay.service.noteTurnRequested(ids.thread);
    expect(inPlay.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("archives a completed thread on the host's timer as the system, only once it is old enough", () => {
    const completedAt = new Date(Date.parse(now) - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const fixture = serviceFixture({ threads: [thread({ completedAt: completedAt as never })] });
    expect(
      fixture.service.archiveCompletedThread(ids.thread, {
        afterDays: 7,
        now: new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString(),
      }),
    ).toEqual({ status: "skipped", reason: "not-due" });
    expect(fixture.service.archiveCompletedThread(ids.thread, { afterDays: 7, now })).toEqual({
      status: "archived",
    });
    expect(fixture.persistence.journal.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({
            eventName: "work.thread-updated@1",
            actor: expect.objectContaining({ kind: "system" }),
          }),
        ],
      }),
    );
    expect(fixture.projection.read(ids.thread)?.lifecycle).toBe("archived");
  });
});

describe("scheduling a Work thread's usage-limit resume", () => {
  const usageLimitTurn = (
    usageLimit: object = { kind: "exhausted", resetsAt: "2026-07-19T13:00:00.000Z" },
  ) =>
    decodeWorkTurnState({
      requestId: "72000000-0000-4000-8000-0000000000a1",
      threadId: ids.thread,
      turnId: "72000000-0000-4000-8000-0000000000b2",
      projectId: ids.project,
      authority: decodeWorkTurnAuthority({
        hostId: "local",
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: ids.provider,
        modelId: "model-a",
      }),
      providerSessionId: "72000000-0000-4000-8000-0000000000c3",
      resumeCursor: { driverKind: "openai-compatible", value: "session-1" },
      status: "waiting",
      prompt: "Keep going.",
      transcript: [],
      failure: {
        category: "rate-limited",
        message: "The provider's usage window is spent.",
        usageLimit,
      },
      capabilities: {
        workspace: "project-backed",
        confinement: "project-root-confined",
        shell: "denied",
        git: "denied",
        worktree: "denied",
        pullRequest: "denied",
        code: "denied",
      },
      version: 1,
      acceptedAt: now,
      updatedAt: now,
    });

  it("schedules a host-owned resume for a turn waiting on a provider usage limit", async () => {
    const turn = usageLimitTurn();
    const fixture = serviceFixture({ threads: [thread()], turns: [turn] });

    const result = await fixture.service.execute(ids.window, {
      kind: "schedule-work-usage-resume",
      threadId: ids.thread,
      expectedVersion: 1,
      turnId: turn.turnId,
    });
    expect(result).toMatchObject({ kind: "thread-updated" });
    expect(fixture.projection.read(ids.thread)?.usageResume).toMatchObject({
      status: "scheduled",
      record: {
        turnId: String(turn.turnId),
        providerInstanceId: String(ids.provider),
        resetsAt: "2026-07-19T13:00:00.000Z",
      },
    });
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({ eventName: "usage-resume.scheduled@1" }),
          expect.objectContaining({ eventName: "work.thread-updated@1" }),
        ],
      }),
    );
  });

  it("refuses to schedule a resume on a thread a person marked Done until it is reactivated", async () => {
    const turn = usageLimitTurn();
    const fixture = serviceFixture({
      threads: [thread({ completionConfirmed: true })],
      turns: [turn],
    });
    const schedule = (expectedVersion: number) =>
      fixture.service.execute(ids.window, {
        kind: "schedule-work-usage-resume",
        threadId: ids.thread,
        expectedVersion,
        turnId: turn.turnId,
      });

    await expect(schedule(1)).rejects.toEqual(
      new WorkThreadServiceError({
        category: "invalid",
        message: "This task is marked Done. Archive and reactivate it before resuming it.",
      }),
    );
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();

    for (const [expectedVersion, lifecycle] of [
      [1, "archived"],
      [2, "active"],
    ] as const) {
      await fixture.service.execute(ids.window, {
        kind: "change-work-thread-lifecycle",
        threadId: ids.thread,
        expectedVersion,
        lifecycle,
      });
    }
    await expect(schedule(3)).resolves.toMatchObject({ kind: "thread-updated" });
    expect(fixture.projection.read(ids.thread)?.usageResume?.status).toBe("scheduled");
  });

  it("withdraws the scheduled resume when the person cancels it", async () => {
    const turn = usageLimitTurn();
    const fixture = serviceFixture({ threads: [thread()], turns: [turn] });
    fixture.projection.applyUsageResume({
      eventName: "usage-resume.scheduled@1",
      payload: {
        resume: {
          threadId: String(ids.thread),
          turnId: String(turn.turnId),
          providerInstanceId: String(ids.provider),
          usageLimit: { kind: "exhausted", resetsAt: "2026-07-19T13:00:00.000Z" },
          resetsAt: "2026-07-19T13:00:00.000Z",
          scheduledAt: now,
        },
      },
    });

    const result = await fixture.service.execute(ids.window, {
      kind: "cancel-work-usage-resume",
      threadId: ids.thread,
      expectedVersion: 1,
    });
    expect(result).toMatchObject({ kind: "thread-updated" });
    expect(fixture.projection.read(ids.thread)?.usageResume).toBeUndefined();
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({ eventName: "usage-resume.cancelled@1" }),
          expect.objectContaining({ eventName: "work.thread-updated@1" }),
        ],
      }),
    );
  });

  it("refuses to schedule a resume for a waiting turn that discloses no reset", async () => {
    const fixture = serviceFixture({
      threads: [thread()],
      turns: [usageLimitTurn({ kind: "exhausted" })],
    });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "schedule-work-usage-resume",
        threadId: ids.thread,
        expectedVersion: 1,
        turnId: "72000000-0000-4000-8000-0000000000b2" as never,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("hides the thread until the provider's declared reset without a provider turn", async () => {
    const turn = usageLimitTurn({ kind: "exhausted", resetsAt: "2099-01-02T09:00:00.000Z" });
    const fixture = serviceFixture({ threads: [thread()], turns: [turn] });

    const result = await fixture.service.execute(ids.window, {
      kind: "snooze-work-thread-at-usage-reset",
      threadId: ids.thread,
      expectedVersion: 1,
    });
    expect(result).toMatchObject({
      kind: "thread-updated",
      thread: {
        snooze: { until: "2099-01-02T09:00:00.000Z", at: now, origin: "usage-limit" },
      },
    });
    expect(fixture.projection.read(ids.thread)?.snooze).toMatchObject({
      until: "2099-01-02T09:00:00.000Z",
      origin: "usage-limit",
    });
  });

  it("keeps an armed resume when the thread hides until the reset", async () => {
    const turn = usageLimitTurn({ kind: "exhausted", resetsAt: "2099-01-02T09:00:00.000Z" });
    const fixture = serviceFixture({ threads: [thread()], turns: [turn] });
    await fixture.service.execute(ids.window, {
      kind: "schedule-work-usage-resume",
      threadId: ids.thread,
      expectedVersion: 1,
      turnId: turn.turnId,
    });
    const armed = fixture.projection.read(ids.thread);
    if (armed === undefined) throw new Error("Expected the thread.");

    await fixture.service.execute(ids.window, {
      kind: "snooze-work-thread-at-usage-reset",
      threadId: ids.thread,
      expectedVersion: armed.version,
    });
    const view = fixture.projection.read(ids.thread);
    expect(view?.snooze?.origin).toBe("usage-limit");
    expect(view?.usageResume?.status).toBe("scheduled");
  });

  it("refuses to hide a thread whose latest turn is not waiting on a usage limit", async () => {
    const fixture = serviceFixture({ threads: [thread()], turns: [] });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "snooze-work-thread-at-usage-reset",
        threadId: ids.thread,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("refuses to hide a thread when the limited turn discloses no reset", async () => {
    const fixture = serviceFixture({
      threads: [thread()],
      turns: [usageLimitTurn({ kind: "exhausted" })],
    });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "snooze-work-thread-at-usage-reset",
        threadId: ids.thread,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });

  it("refuses to hide a thread whose declared reset has already passed", async () => {
    const fixture = serviceFixture({
      threads: [thread()],
      turns: [usageLimitTurn({ kind: "exhausted", resetsAt: "2020-01-01T00:00:00.000Z" })],
    });
    await expect(
      fixture.service.execute(ids.window, {
        kind: "snooze-work-thread-at-usage-reset",
        threadId: ids.thread,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.persistence.journal.append).not.toHaveBeenCalled();
  });
});

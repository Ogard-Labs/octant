import {
  type AggregateVersion,
  type UtcTimestamp,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
  decodeWorkThreadId,
  decodeProjectId,
  decodeProviderInstance,
  decodeWindowId,
  type EventEnvelope,
  type Project,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyConflict } from "../persistence/journalErrors";
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
      decodeWorkThreadBootstrap({ threads: [allowed] }),
    );
    expect(fixture.projects.bootstrap).toHaveBeenCalledWith(ids.window);
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

  it("persists an authorized explicit completion confirmation", async () => {
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
        id: ids.thread,
        lifecycle: "active",
        version: 2,
        completionEvidence: {
          deliveryTarget: "Draft brief",
          satisfactionEvidence: "The requested brief was reviewed and saved.",
        },
      },
    });
    expect(fixture.persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({
            eventName: "work.thread-completion-confirmed@1",
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
        satisfactionEvidence: "The requested brief was reviewed and saved.",
      }),
    ).rejects.toEqual(
      new WorkThreadServiceError({
        category: "invalid",
        message: "Work thread completion was already confirmed.",
      }),
    );
  });

  it("rejects completion unless evidence names the authoritative delivery target", async () => {
    const fixture = serviceFixture({ threads: [thread()] });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "confirm-work-thread-completion",
        threadId: ids.thread,
        expectedVersion: 1,
        deliveryTarget: "A different request",
        satisfactionEvidence: "Something else was delivered.",
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
      satisfactionEvidence: "The requested brief was reviewed and saved.",
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
        satisfactionEvidence: "The requested brief was reviewed and saved again.",
      }),
    ).resolves.toMatchObject({
      kind: "thread-completion-confirmed",
      thread: { version: 5 },
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
    readonly project?: Project;
    readonly events?: ReadonlyArray<EventEnvelope>;
  } = {},
) {
  const projection = new WorkThreadProjection();
  for (const entry of options.threads ?? [thread()]) {
    projection.apply({ kind: "thread-created", thread: entry });
  }
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
    uuid: () => "72000000-0000-4000-8000-000000000099",
    clock: () => now,
    workingDirectories,
    onWorkingDirectoryChanged,
    ...(options.probeProvider === undefined ? {} : { probeProvider: options.probeProvider }),
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

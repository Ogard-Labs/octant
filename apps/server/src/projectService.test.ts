import {
  decodeMemoryEntryId,
  decodeProjectId,
  decodeWindowId,
  type MemoryEntry,
  type Project,
} from "@octant/contracts";
import { compareProjectOrder } from "@octant/domain";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { BindingReceiptStore } from "./bindingReceiptStore";
import { ConcurrencyConflict } from "./persistence/journalErrors";
import {
  Persistence,
  makePersistenceLive,
  type PersistenceService,
} from "./persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";
import { ProjectService } from "./projectService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000601");
const chatId = decodeProjectId("00000000-0000-4000-8000-000000000602");
const workId = decodeProjectId("00000000-0000-4000-8000-000000000603");
const entryId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000610");
const successorId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000611");
const transferId = decodeMemoryEntryId("00000000-0000-4000-8000-000000000612");
const now = "2026-07-14T10:00:00.000Z";

describe("ProjectService", () => {
  it("projects a credential-free GitHub identity for an available Code Project", async () => {
    const project = codeProject();
    const observeCodeProjectRepository = vi.fn(async (root: string) => {
      expect(root).toBe(project.binding.canonicalRoot);
      return { host: "github.com" as const, owner: "acme", repository: "octant" };
    });
    const fixture = fixtureService({ projects: [project], observeCodeProjectRepository });

    const bootstrap = await fixture.service.bootstrap(windowId);

    expect(bootstrap.active).toEqual([
      expect.objectContaining({
        id: project.id,
        type: "code",
        connectedRepository: { host: "github.com", owner: "acme", repository: "octant" },
      }),
    ]);
    expect(JSON.stringify(bootstrap)).not.toContain("https://");
    expect(observeCodeProjectRepository).toHaveBeenCalledTimes(1);
  });

  it("keeps the Code Project usable when remote identity is ambiguous", async () => {
    const project = codeProject();
    const fixture = fixtureService({
      projects: [project],
      observeCodeProjectRepository: async () => undefined,
    });

    const bootstrap = await fixture.service.bootstrap(windowId);

    expect(bootstrap.active[0]).not.toHaveProperty("connectedRepository");
  });

  it("checks active Project identity for route authorization without probing the filesystem", () => {
    const validate = vi.fn(async (_type: "work" | "code", path: string) => ({
      canonicalRoot: path,
    }));
    const fixture = fixtureService({
      projects: [codeProject(), { ...chatProject(), lifecycle: "archived" }],
      validate,
    });

    expect(fixture.service.hasActiveProject(workId, "code")).toBe(true);
    expect(fixture.service.hasActiveProject(workId, "work")).toBe(false);
    expect(fixture.service.hasActiveProject(chatId, "chat")).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    expect(fixture.status).not.toHaveBeenCalled();
  });

  it("bootstraps empty state and never journals availability observations", async () => {
    const fixture = fixtureService();
    await expect(fixture.service.bootstrap(windowId)).resolves.toEqual({
      active: [],
      archived: [],
      availability: [],
      memory: [],
    });
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("creates and mutates Projects with local-user events and optimistic versions", async () => {
    const fixture = fixtureService();
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "create-chat-project",
        projectId: chatId,
        expectedVersion: 0,
        name: "Research",
        hostId: "local",
      }),
    ).resolves.toMatchObject({
      kind: "chat-project-created",
      project: { id: chatId, name: "Research", type: "chat", version: 1, rank: "0/1" },
    });
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      aggregate: { aggregateType: "project", aggregateId: chatId },
      expectedVersion: 0,
      events: [
        {
          eventName: "project.created@1",
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        },
      ],
    });

    await expect(
      fixture.service.executeProject(windowId, {
        kind: "rename-project",
        projectId: chatId,
        expectedVersion: 1,
        name: "Signals",
      }),
    ).resolves.toMatchObject({ kind: "project-renamed", project: { name: "Signals", version: 2 } });

    await expect(
      fixture.service.executeProject(windowId, {
        kind: "change-project-lifecycle",
        projectId: chatId,
        expectedVersion: 2,
        lifecycle: "archived",
      }),
    ).resolves.toMatchObject({
      kind: "project-lifecycle-changed",
      project: { lifecycle: "archived", version: 3 },
    });
  });

  it("notifies server-internal listeners after an active Work Project is archived", async () => {
    const fixture = fixtureService({ projects: [workProject()] });
    const archived = vi.fn();
    fixture.service.onWorkProjectArchived(archived);

    await fixture.service.executeProject(windowId, {
      kind: "change-project-lifecycle",
      projectId: workId,
      expectedVersion: 1,
      lifecycle: "archived",
    });

    expect(archived).toHaveBeenCalledWith(
      expect.objectContaining({ id: workId, type: "work", lifecycle: "archived" }),
    );
  });

  it("rejects duplicate IDs and stale versions before appending", async () => {
    const fixture = fixtureService({ projects: [chatProject()] });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "create-chat-project",
        projectId: chatId,
        expectedVersion: 0,
        name: "Duplicate",
        hostId: "local",
      }),
    ).rejects.toMatchObject({ failure: { category: "conflict", currentVersion: 1 } });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "rename-project",
        projectId: chatId,
        expectedVersion: 0,
        name: "Stale",
      }),
    ).rejects.toMatchObject({ failure: { category: "conflict", currentVersion: 1 } });
    expect(fixture.append).not.toHaveBeenCalled();

    const raced = fixtureService({
      projects: [chatProject()],
      appendError: new ConcurrencyConflict({
        aggregateType: "project",
        aggregateId: chatId,
        expectedVersion: 1,
        actualVersion: 2,
      }),
    });
    await expect(
      raced.service.executeProject(windowId, {
        kind: "rename-project",
        projectId: chatId,
        expectedVersion: 1,
        name: "Race",
      }),
    ).rejects.toMatchObject({ failure: { category: "conflict", currentVersion: 2 } });
  });

  it("validates all bound create state before consuming and uses only the receipt binding", async () => {
    const receipts = new BindingReceiptStore(() => Buffer.alloc(32));
    const issued = receipts.issue({
      windowId,
      projectType: "work",
      canonicalBinding: { canonicalRoot: "/canonical/work" },
      now: 0,
    });
    const fixture = fixtureService({ receipts, nowMs: 1 });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "create-work-project",
        projectId: workId,
        expectedVersion: 0,
        name: "Work",
        receiptId: issued.receiptId,
        hostId: "local",
      }),
    ).resolves.toMatchObject({
      kind: "work-project-created",
      project: { binding: { canonicalRoot: "/canonical/work" }, bindingHistory: [{ revision: 1 }] },
    });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "create-work-project",
        projectId: decodeProjectId("00000000-0000-4000-8000-000000000604"),
        expectedVersion: 0,
        name: "Reuse",
        receiptId: issued.receiptId,
        hostId: "local",
      }),
    ).rejects.toMatchObject({ failure: { category: "unauthorized" } });
  });

  it("rejects disabled modes and archived mutations", async () => {
    const fixture = fixtureService({ settings: { chatEnabled: false, workEnabled: false } });
    const archived = fixtureService({ projects: [{ ...chatProject(), lifecycle: "archived" }] });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "create-chat-project",
        projectId: decodeProjectId("00000000-0000-4000-8000-000000000605"),
        expectedVersion: 0,
        name: "Disabled",
        hostId: "local",
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });
    await expect(
      archived.service.executeProject(windowId, {
        kind: "rename-project",
        projectId: chatId,
        expectedVersion: 1,
        name: "No",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("observes missing roots ephemerally and searches only committed display fields", async () => {
    const project = workProject();
    const fixture = fixtureService({
      projects: [project],
      validate: vi.fn(async () => {
        throw new Error("missing");
      }),
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      availability: [{ projectId: workId, status: "unavailable", reason: "Relink required." }],
    });
    expect(await fixture.service.search(" CANONICAL ")).toHaveLength(1);
    expect(await fixture.service.search("secret memory")).toHaveLength(0);
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("initializes Git before journaling a Code Project when create asks for it", async () => {
    const codeReceipts = new BindingReceiptStore(() => Buffer.alloc(32, 9));
    const codeReceipt = codeReceipts.issue({
      windowId,
      projectType: "code",
      canonicalBinding: { canonicalRoot: "/fresh" },
      now: 0,
    });
    const codeId = decodeProjectId("00000000-0000-4000-8000-000000000677");
    const initializeGitRepository = vi.fn(async (canonicalRoot: string) => {
      expect(canonicalRoot).toBe("/fresh");
      return { status: "initialized" as const };
    });
    const codeFixture = fixtureService({
      receipts: codeReceipts,
      nowMs: 1,
      initializeGitRepository,
    });
    await expect(
      codeFixture.service.executeProject(windowId, {
        kind: "create-code-project",
        projectId: codeId,
        expectedVersion: 0,
        name: "Fresh",
        receiptId: codeReceipt.receiptId,
        hostId: "local",
        initializeGit: true,
      }),
    ).resolves.toMatchObject({
      kind: "code-project-created",
      project: { id: codeId, binding: { canonicalRoot: "/fresh" } },
    });
    expect(initializeGitRepository).toHaveBeenCalledWith("/fresh");
    expect(codeFixture.append).toHaveBeenCalled();
  });

  it("refuses Code Project creation when requested Git initialization fails", async () => {
    const codeReceipts = new BindingReceiptStore(() => Buffer.alloc(32, 10));
    const codeReceipt = codeReceipts.issue({
      windowId,
      projectType: "code",
      canonicalBinding: { canonicalRoot: "/blocked" },
      now: 0,
    });
    const codeId = decodeProjectId("00000000-0000-4000-8000-000000000678");
    const codeFixture = fixtureService({
      receipts: codeReceipts,
      nowMs: 1,
      initializeGitRepository: async () => ({
        status: "failed",
        message: "Octant could not initialize a Git repository in the chosen folder.",
      }),
    });
    await expect(
      codeFixture.service.executeProject(windowId, {
        kind: "create-code-project",
        projectId: codeId,
        expectedVersion: 0,
        name: "Blocked",
        receiptId: codeReceipt.receiptId,
        hostId: "local",
        initializeGit: true,
      }),
    ).rejects.toMatchObject({
      failure: {
        category: "unavailable",
        message: "Octant could not initialize a Git repository in the chosen folder.",
      },
    });
    expect(codeFixture.append).not.toHaveBeenCalled();
  });

  it("creates Code, reorders, restores, and relinks without changing Project identity", async () => {
    const codeReceipts = new BindingReceiptStore(() => Buffer.alloc(32, 1));
    const codeReceipt = codeReceipts.issue({
      windowId,
      projectType: "code",
      canonicalBinding: { canonicalRoot: "/repo" },
      now: 0,
    });
    const codeId = decodeProjectId("00000000-0000-4000-8000-000000000607");
    const codeFixture = fixtureService({ receipts: codeReceipts, nowMs: 1 });
    await expect(
      codeFixture.service.executeProject(windowId, {
        kind: "create-code-project",
        projectId: codeId,
        expectedVersion: 0,
        name: "Code",
        receiptId: codeReceipt.receiptId,
        hostId: "local",
      }),
    ).resolves.toMatchObject({
      kind: "code-project-created",
      project: {
        id: codeId,
        codeAccessPersistence: "current-session",
        binding: { canonicalRoot: "/repo" },
      },
    });

    const neighbor = {
      ...chatProject(),
      id: decodeProjectId("00000000-0000-4000-8000-000000000608"),
      rank: "2/1" as never,
    };
    const moveFixture = fixtureService({ projects: [chatProject(), neighbor] });
    await expect(
      moveFixture.service.executeProject(windowId, {
        kind: "move-project",
        projectId: chatId,
        expectedVersion: 1,
        pinned: false,
        afterProjectId: neighbor.id,
      }),
    ).resolves.toMatchObject({ kind: "project-moved", project: { rank: "1/1", version: 2 } });

    const archived = { ...chatProject(), lifecycle: "archived" as const };
    const restoreFixture = fixtureService({ projects: [archived] });
    await expect(
      restoreFixture.service.executeProject(windowId, {
        kind: "change-project-lifecycle",
        projectId: chatId,
        expectedVersion: 1,
        lifecycle: "active",
      }),
    ).resolves.toMatchObject({ project: { lifecycle: "active", version: 2 } });

    const relinkReceipts = new BindingReceiptStore(() => Buffer.alloc(32, 2));
    const relinkReceipt = relinkReceipts.issue({
      windowId,
      projectType: "work",
      canonicalBinding: { canonicalRoot: "/replacement" },
      now: 0,
    });
    const relinkFixture = fixtureService({
      projects: [workProject()],
      receipts: relinkReceipts,
      nowMs: 1,
    });
    await expect(
      relinkFixture.service.executeProject(windowId, {
        kind: "relink-project",
        projectId: workId,
        expectedVersion: 1,
        receiptId: relinkReceipt.receiptId,
      }),
    ).resolves.toMatchObject({
      kind: "project-relinked",
      project: {
        id: workId,
        binding: { canonicalRoot: "/replacement" },
        bindingHistory: [
          { revision: 1 },
          { revision: 2, previousBinding: { canonicalRoot: "/canonical/work" } },
        ],
        version: 2,
      },
    });
  });

  it("does not burn a relink receipt when durable binding history is inconsistent", async () => {
    const consume = vi.fn();
    const valid = workProject();
    if (valid.type === "chat") throw new Error("expected bound Project");
    const corrupt = {
      ...valid,
      bindingHistory: [
        {
          ...valid.bindingHistory[0],
          currentBinding: { canonicalRoot: "/other" },
        },
      ],
    } as Project;
    const fixture = fixtureService({ projects: [corrupt], receipts: { consume } as never });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "relink-project",
        projectId: workId,
        expectedVersion: 1,
        receiptId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as never,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(consume).not.toHaveBeenCalled();
  });

  it("pins and unpins through authoritative move transitions", async () => {
    const fixture = fixtureService({ projects: [chatProject()] });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "move-project",
        projectId: chatId,
        expectedVersion: 1,
        pinned: true,
      }),
    ).resolves.toMatchObject({
      kind: "project-moved",
      project: { pinned: true, version: 2 },
    });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "move-project",
        projectId: chatId,
        expectedVersion: 2,
        pinned: false,
      }),
    ).resolves.toMatchObject({
      kind: "project-moved",
      project: { pinned: false, version: 3 },
    });
    expect(fixture.append).toHaveBeenCalledTimes(2);
  });

  it("returns equal-rank Projects in deterministic ProjectId order", async () => {
    const lowerId = decodeProjectId("00000000-0000-4000-8000-000000000600");
    const higherId = decodeProjectId("00000000-0000-4000-8000-000000000699");
    const fixture = fixtureService({
      projects: [
        { ...chatProject(), id: higherId, name: "Higher" },
        { ...chatProject(), id: lowerId, name: "Lower" },
      ],
      sortProjects: true,
    });
    await expect(fixture.service.bootstrap(windowId)).resolves.toMatchObject({
      active: [{ id: lowerId }, { id: higherId }],
    });
  });

  it("creates every explicit memory kind and returns active history separately", async () => {
    const fixture = fixtureService({ projects: [chatProject()] });
    const kinds = ["decision", "fact", "preference", "summary", "outcome"] as const;
    for (const [index, memoryKind] of kinds.entries()) {
      const id = decodeMemoryEntryId(
        `00000000-0000-4000-8000-${String(620 + index).padStart(12, "0")}`,
      );
      await expect(
        fixture.service.executeMemory({
          kind: "create-memory-entry",
          projectId: chatId,
          entryId: id,
          memoryKind,
          content: `${memoryKind} content`,
          expectedVersion: index,
        }),
      ).resolves.toMatchObject({
        kind: "memory-entry-created",
        entry: { id, kind: memoryKind, content: `${memoryKind} content`, version: index + 1 },
      });
    }
    await expect(fixture.service.memory(chatId)).resolves.toMatchObject({
      projectId: chatId,
      active: kinds.map((kind) => ({ kind })),
      history: [],
    });
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      aggregate: { aggregateType: "project-memory", aggregateId: chatId },
      expectedVersion: 0,
      events: [
        {
          eventName: "memory.entry-created@1",
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        },
      ],
    });
  });

  it("rejects memory mutations when the destination or transfer source mode is disabled", async () => {
    const disabledChat = fixtureService({
      projects: [chatProject(), workProject()],
      memory: [activeMemory()],
      settings: { chatEnabled: false, workEnabled: true },
    });
    await expect(
      disabledChat.service.executeMemory({
        kind: "create-memory-entry",
        projectId: chatId,
        entryId: successorId,
        memoryKind: "fact",
        content: "Must remain unavailable",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });
    await expect(
      disabledChat.service.executeMemory({
        kind: "transfer-memory-entry",
        sourceProjectId: chatId,
        sourceEntryId: entryId,
        destinationProjectId: workId,
        destinationEntryId: transferId,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });
    expect(disabledChat.append).not.toHaveBeenCalled();

    const disabledWork = fixtureService({
      projects: [chatProject(), workProject()],
      memory: [activeMemory()],
      settings: { chatEnabled: true, workEnabled: false },
    });
    await expect(
      disabledWork.service.executeMemory({
        kind: "transfer-memory-entry",
        sourceProjectId: chatId,
        sourceEntryId: entryId,
        destinationProjectId: workId,
        destinationEntryId: transferId,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ failure: { category: "unsupported" } });
    expect(disabledWork.append).not.toHaveBeenCalled();
  });

  it("supersedes and retracts only active entries in the command Project", async () => {
    const fixture = fixtureService({ projects: [chatProject()], memory: [activeMemory()] });
    await expect(
      fixture.service.executeMemory({
        kind: "supersede-memory-entry",
        projectId: chatId,
        entryId,
        successorEntryId: successorId,
        content: "Corrected",
        expectedVersion: 1,
      }),
    ).resolves.toMatchObject({
      kind: "memory-entry-superseded",
      previousEntry: { id: entryId, status: "superseded", supersededBy: successorId },
      entry: { id: successorId, status: "active", content: "Corrected", version: 2 },
    });
    await expect(
      fixture.service.executeMemory({
        kind: "retract-memory-entry",
        projectId: chatId,
        entryId: successorId,
        reason: "No longer true",
        expectedVersion: 2,
      }),
    ).resolves.toMatchObject({
      kind: "memory-entry-retracted",
      entry: { id: successorId, status: "retracted", retractionReason: "No longer true" },
    });
    await expect(fixture.service.memory(chatId)).resolves.toMatchObject({
      active: [],
      history: [
        { id: entryId, status: "superseded" },
        { id: successorId, status: "retracted" },
      ],
    });
    await expect(
      fixture.service.executeMemory({
        kind: "supersede-memory-entry",
        projectId: chatId,
        entryId,
        successorEntryId: transferId,
        content: "Cannot reactivate",
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    await expect(
      fixture.service.executeMemory({
        kind: "retract-memory-entry",
        projectId: workId,
        entryId,
        reason: "Wrong scope",
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ failure: { category: "not-found" } });
  });

  it("loads transfer content server-side and mutates only an active destination aggregate", async () => {
    const archivedSource = { ...chatProject(), lifecycle: "archived" as const };
    const fixture = fixtureService({
      projects: [archivedSource, workProject()],
      memory: [activeMemory()],
    });
    await expect(
      fixture.service.executeMemory({
        kind: "transfer-memory-entry",
        sourceProjectId: chatId,
        sourceEntryId: entryId,
        destinationProjectId: workId,
        destinationEntryId: transferId,
        expectedVersion: 0,
      }),
    ).resolves.toMatchObject({
      kind: "memory-entry-transferred",
      entry: {
        id: transferId,
        projectId: workId,
        content: "Source truth",
        provenance: {
          sourceProjectId: chatId,
          sourceEntryId: entryId,
          destinationProjectId: workId,
          selectedContent: "Source truth",
        },
      },
    });
    expect(fixture.append).toHaveBeenCalledTimes(1);
    expect(fixture.append.mock.calls[0]?.[0]).toMatchObject({
      aggregate: { aggregateType: "project-memory", aggregateId: workId },
      expectedVersion: 0,
      events: [{ eventName: "memory.entry-transferred@1" }],
    });
    await expect(fixture.service.memory(chatId)).resolves.toMatchObject({
      active: [{ id: entryId, content: "Source truth" }],
    });
    await expect(fixture.service.memory(workId)).resolves.toMatchObject({
      active: [{ id: transferId, content: "Source truth" }],
    });

    const independent = fixtureService({
      projects: [chatProject(), workProject()],
      memory: [activeMemory()],
    });
    await independent.service.executeMemory({
      kind: "transfer-memory-entry",
      sourceProjectId: chatId,
      sourceEntryId: entryId,
      destinationProjectId: workId,
      destinationEntryId: transferId,
      expectedVersion: 0,
    });
    await independent.service.executeMemory({
      kind: "supersede-memory-entry",
      projectId: chatId,
      entryId,
      successorEntryId: successorId,
      content: "Source changed",
      expectedVersion: 1,
    });
    await expect(independent.service.memory(workId)).resolves.toMatchObject({
      active: [{ id: transferId, content: "Source truth" }],
    });

    const archivedDestination = fixtureService({
      projects: [chatProject(), { ...workProject(), lifecycle: "archived" }],
      memory: [activeMemory()],
    });
    await expect(
      archivedDestination.service.executeMemory({
        kind: "transfer-memory-entry",
        sourceProjectId: chatId,
        sourceEntryId: entryId,
        destinationProjectId: workId,
        destinationEntryId: transferId,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
  });

  it("rejects malformed memory commands, archived mutations, stale versions, and missing reads", async () => {
    const archived = fixtureService({
      projects: [{ ...chatProject(), lifecycle: "archived" }],
      memory: [activeMemory()],
    });
    await expect(archived.service.memory(chatId)).resolves.toMatchObject({
      active: [{ id: entryId }],
    });
    await expect(
      archived.service.executeMemory({
        kind: "create-memory-entry",
        projectId: chatId,
        entryId: successorId,
        memoryKind: "fact",
        content: "No",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    await expect(archived.service.memory("bad-id")).rejects.toMatchObject({
      failure: { category: "invalid" },
    });
    await expect(
      archived.service.memory(decodeProjectId("00000000-0000-4000-8000-000000000699")),
    ).rejects.toMatchObject({ failure: { category: "not-found" } });

    const stale = fixtureService({ projects: [chatProject()], memory: [activeMemory()] });
    await expect(
      stale.service.executeMemory({
        kind: "create-memory-entry",
        projectId: chatId,
        entryId: successorId,
        memoryKind: "fact",
        content: "Stale",
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ failure: { category: "conflict", currentVersion: 1 } });
    await expect(
      stale.service.executeMemory({
        kind: "transfer-memory-entry",
        sourceProjectId: chatId,
        sourceEntryId: entryId,
        destinationProjectId: workId,
        destinationEntryId: transferId,
        expectedVersion: 0,
        content: "forged",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });

    const raced = fixtureService({
      projects: [chatProject()],
      memory: [activeMemory()],
      appendError: new ConcurrencyConflict({
        aggregateType: "project-memory",
        aggregateId: chatId,
        expectedVersion: 1,
        actualVersion: 2,
      }),
    });
    await expect(
      raced.service.executeMemory({
        kind: "create-memory-entry",
        projectId: chatId,
        entryId: successorId,
        memoryKind: "fact",
        content: "Raced",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ failure: { category: "conflict", currentVersion: 2 } });
  });

  it("reads authoritative memory after closing and reopening persistent storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-project-memory-service-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            const service = persistentService(persistence);
            yield* Effect.promise(() =>
              service.executeProject(windowId, {
                kind: "create-chat-project",
                projectId: chatId,
                expectedVersion: 0,
                name: "Persistent",
                hostId: "local",
              }),
            );
            yield* Effect.promise(() =>
              service.executeMemory({
                kind: "create-memory-entry",
                projectId: chatId,
                entryId,
                memoryKind: "outcome",
                content: "Survives restart",
                expectedVersion: 0,
              }),
            );
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );

      const restored = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            return yield* Effect.promise(() => persistentService(persistence).memory(chatId));
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );
      expect(restored).toMatchObject({
        projectId: chatId,
        active: [{ id: entryId, content: "Survives restart", version: 1 }],
        history: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses background pull-request refresh on a Chat Project and a stale expected version", async () => {
    const fixture = fixtureService({ projects: [chatProject(), codeProject()] });
    await expect(
      fixture.service.executeProject(windowId, {
        kind: "change-code-project-pull-request-background-refresh",
        projectId: chatId,
        expectedVersion: 1,
        pullRequestBackgroundRefresh: "enabled",
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(fixture.append).not.toHaveBeenCalled();

    await expect(
      fixture.service.executeProject(windowId, {
        kind: "change-code-project-pull-request-background-refresh",
        projectId: workId,
        expectedVersion: 0,
        pullRequestBackgroundRefresh: "enabled",
      }),
    ).rejects.toMatchObject({ failure: { category: "conflict" } });
  });

  it("enables background pull-request refresh through the authoritative command and journals one event", async () => {
    const fixture = fixtureService({ projects: [codeProject()] });
    const result = await fixture.service.executeProject(windowId, {
      kind: "change-code-project-pull-request-background-refresh",
      projectId: workId,
      expectedVersion: 1,
      pullRequestBackgroundRefresh: "enabled",
    });
    expect(result).toMatchObject({
      kind: "code-project-pull-request-background-refresh-changed",
      project: { pullRequestBackgroundRefresh: "enabled", version: 2 },
    });
    expect(fixture.append).toHaveBeenCalledTimes(1);
    expect(fixture.append.mock.calls[0]?.[0]?.events?.[0]?.eventName).toBe(
      "project.code-pull-request-background-refresh-changed@1",
    );
  });

  it("replays the pull-request background refresh opt-in across persistence restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-project-pr-cadence-service-"));
    const codeId = decodeProjectId("00000000-0000-4000-8000-000000000698");
    const receiptId = `${"A".repeat(42)}A` as never;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            const service = persistentService(persistence);
            yield* Effect.promise(() =>
              service.executeProject(windowId, {
                kind: "create-code-project",
                projectId: codeId,
                expectedVersion: 0,
                name: "Persistent cadence",
                receiptId,
                hostId: "local",
              }),
            );
            yield* Effect.promise(() =>
              service.executeProject(windowId, {
                kind: "change-code-project-pull-request-background-refresh",
                projectId: codeId,
                expectedVersion: 1,
                pullRequestBackgroundRefresh: "enabled",
              }),
            );
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );

      const restored = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            return yield* Effect.promise(() => persistentService(persistence).bootstrap(windowId));
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );
      expect(restored.active).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: codeId, pullRequestBackgroundRefresh: "enabled" }),
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays a Code Project access policy across persistence restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-project-access-service-"));
    const codeId = decodeProjectId("00000000-0000-4000-8000-000000000699");
    const receiptId = `${"A".repeat(42)}A` as never;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            const service = persistentService(persistence);
            yield* Effect.promise(() =>
              service.executeProject(windowId, {
                kind: "create-code-project",
                projectId: codeId,
                expectedVersion: 0,
                name: "Persistent Code",
                receiptId,
                hostId: "local",
              }),
            );
            yield* Effect.promise(() =>
              service.executeProject(windowId, {
                kind: "change-code-project-access",
                projectId: codeId,
                expectedVersion: 1,
                codeAccessPersistence: "project-default",
              }),
            );
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );

      const restored = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            return yield* Effect.promise(() => persistentService(persistence).bootstrap(windowId));
          }).pipe(
            Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
          ),
        ),
      );
      expect(restored.active).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: codeId, codeAccessPersistence: "project-default" }),
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function activeMemory(): MemoryEntry {
  return {
    id: entryId,
    projectId: chatId,
    kind: "decision",
    content: "Source truth",
    provenance: { kind: "user-authored" },
    author: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    status: "active",
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
  };
}

function chatProject(): Project {
  return {
    id: chatId,
    type: "chat",
    name: "Chat",
    lifecycle: "active",
    pinned: false,
    rank: "0/1" as never,
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
  };
}

function workProject(): Project {
  return {
    id: workId,
    type: "work",
    name: "Work",
    lifecycle: "active",
    pinned: false,
    rank: "0/1" as never,
    version: 1 as never,
    createdAt: now as never,
    updatedAt: now as never,
    binding: { canonicalRoot: "/canonical/work" },
    bindingHistory: [
      {
        revisionId: "00000000-0000-4000-8000-000000000606" as never,
        revision: 1,
        currentBinding: { canonicalRoot: "/canonical/work" },
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        changedAt: now as never,
      },
    ],
  };
}

function codeProject(): Extract<Project, { readonly type: "code" }> {
  const project = workProject();
  if (project.type !== "work") throw new Error("Expected Work Project fixture.");
  return {
    ...project,
    type: "code",
    codeAccessPersistence: "current-session",
  };
}

function fixtureService(
  options: {
    projects?: Project[];
    receipts?: BindingReceiptStore;
    nowMs?: number;
    settings?: { chatEnabled: boolean; workEnabled: boolean };
    appendError?: Error;
    sortProjects?: boolean;
    memory?: MemoryEntry[];
    validate?: (type: "work" | "code", path: string) => Promise<{ canonicalRoot: string }>;
    observeCodeProjectRepository?: (
      canonicalRoot: string,
    ) => Promise<{ host: "github.com"; owner: string; repository: string } | undefined>;
    initializeGitRepository?: (
      canonicalRoot: string,
    ) => Promise<
      | { readonly status: "initialized" }
      | { readonly status: "already-repository" }
      | { readonly status: "failed"; readonly message: string }
    >;
  } = {},
) {
  const projects = [...(options.projects ?? [])];
  const memory = [...(options.memory ?? [])];
  const status = vi.fn(() => ({ state: "current" as const, integrity: "ok" as const }));
  const append = vi.fn((request: any) => {
    if (options.appendError !== undefined) throw options.appendError;
    const payload = request.events[0].payload as Record<string, unknown>;
    if (request.aggregate.aggregateType === "project") {
      const project = payload.project as Project;
      const index = projects.findIndex((candidate) => candidate.id === project.id);
      if (index === -1) projects.push(project);
      else projects[index] = project;
      return { aggregateVersion: project.version };
    }
    const entries = [payload.previousEntry, payload.entry].filter(Boolean) as MemoryEntry[];
    for (const entry of entries) {
      const index = memory.findIndex(
        (candidate) => candidate.projectId === entry.projectId && candidate.id === entry.id,
      );
      if (index === -1) memory.push(entry);
      else memory[index] = entry;
    }
    return { aggregateVersion: entries.at(-1)?.version };
  });
  const persistence = {
    journal: { append },
    readProject: (id: typeof chatId) => projects.find((project) => project.id === id),
    readProjects: (filter?: { lifecycle?: string }) => {
      const result = projects.filter(
        (project) => filter?.lifecycle === undefined || project.lifecycle === filter.lifecycle,
      );
      return options.sortProjects ? result.sort(compareProjectOrder) : result;
    },
    searchProjects: (query: string) =>
      projects.filter((project) =>
        [
          project.name,
          project.type,
          project.type === "chat" ? "" : project.binding.canonicalRoot,
        ].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())),
      ),
    readMemoryEntry: (projectId: typeof chatId, id: typeof entryId) =>
      memory.find((entry) => entry.projectId === projectId && entry.id === id),
    readProjectMemory: (projectId: typeof chatId) => ({
      projectId,
      active: memory.filter((entry) => entry.projectId === projectId && entry.status === "active"),
      history: memory.filter((entry) => entry.projectId === projectId && entry.status !== "active"),
    }),
    readShellSettings: () => ({
      settings: {
        ...(options.settings ?? { chatEnabled: true, workEnabled: true }),
        sidebarWidth: 280,
        contextSidebarWidth: 360,
        lastContextSurface: null,
        sidebarMaterial: "system",
      },
      aggregateVersion: 0,
    }),
    status,
  } as unknown as PersistenceService;
  return {
    append,
    status,
    service: new ProjectService({
      persistence,
      bindingReceiptStore:
        options.receipts ?? ({ consume: () => ({ canonicalRoot: "/unused" }) } as never),
      projectRootPort: {
        validate: options.validate ?? (async (_type, path) => ({ canonicalRoot: path })),
      },
      uuid: uuidSequence(),
      clock: () => now,
      now: () => options.nowMs ?? 0,
      ...(options.observeCodeProjectRepository === undefined
        ? {}
        : { observeCodeProjectRepository: options.observeCodeProjectRepository }),
      ...(options.initializeGitRepository === undefined
        ? {}
        : { initializeGitRepository: options.initializeGitRepository }),
    }),
  };
}

function persistentService(persistence: PersistenceService): ProjectService {
  return new ProjectService({
    persistence,
    bindingReceiptStore: { consume: () => ({ canonicalRoot: "/unused" }) } as never,
    projectRootPort: { validate: async (_type, path) => ({ canonicalRoot: path }) },
    uuid: uuidSequence(),
    clock: () => now,
  });
}

function uuidSequence() {
  let value = 700;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

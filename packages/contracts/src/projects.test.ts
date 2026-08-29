import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROJECT_EVENT_NAMES,
  decodeBindingReceiptId,
  decodeMemoryCommand,
  decodeMemoryCommandResult,
  decodeMemoryEntry,
  decodeMemoryEntryCreated,
  decodeMemoryEntryRetracted,
  decodeMemoryEntrySuperseded,
  decodeMemoryEntryTransferred,
  decodeMemoryEntryId,
  decodeProject,
  decodeProjectAvailability,
  decodeProjectBindingRelinked,
  decodeCodeProjectAccessChanged,
  decodeProjectBootstrap,
  decodeProjectCommand,
  decodeProjectCommandResult,
  decodeProjectCreated,
  decodeProjectFailure,
  decodeProjectLifecycleChanged,
  decodeProjectOrderChanged,
  decodeProjectRank,
  decodeProjectRenamed,
  decodeProjectSummary,
} from "./projects";

const ids = {
  project: "11111111-1111-4111-8111-111111111111",
  otherProject: "22222222-2222-4222-8222-222222222222",
  entry: "33333333-3333-4333-8333-333333333333",
  successor: "44444444-4444-4444-8444-444444444444",
  receipt: "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVA",
  revision: "66666666-6666-4666-8666-666666666666",
  previousRevision: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
} as const;

const actor = { kind: "local-user", actorId: ids.actor } as const;
const createdAt = "2026-07-14T08:00:00.000Z";
const updatedAt = "2026-07-14T09:00:00.000Z";

describe("BindingReceiptId", () => {
  it("accepts the canonical unpadded base64url encoding of exactly 32 random bytes", () => {
    const receiptId = randomBytes(32).toString("base64url");

    expect(receiptId).toHaveLength(43);
    expect(decodeBindingReceiptId(receiptId)).toBe(receiptId);
  });

  it.each([
    "55555555-5555-4555-8555-555555555555",
    "short",
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}=`,
    `${"A".repeat(41)}+/`,
    `${"A".repeat(42)} `,
  ])("rejects noncanonical receipt identity %s", (receiptId) => {
    expect(() => decodeBindingReceiptId(receiptId)).toThrow();
  });
});

const commonProject = {
  id: ids.project,
  name: "Project Atlas",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 1,
  createdAt,
  updatedAt,
} as const;

const initialBindingRevision = {
  revisionId: ids.revision,
  revision: 1,
  currentBinding: { canonicalRoot: "/Users/example/Project Atlas" },
  actor,
  changedAt: createdAt,
} as const;

const binding = initialBindingRevision.currentBinding;

const chatProject = { ...commonProject, type: "chat" } as const;
const workProject = {
  ...commonProject,
  type: "work",
  binding,
  bindingHistory: [initialBindingRevision],
} as const;
const codeProject = {
  ...commonProject,
  type: "code",
  binding,
  bindingHistory: [initialBindingRevision],
  codeAccessPersistence: "current-session",
} as const;

const userMemory = {
  id: ids.entry,
  projectId: ids.project,
  kind: "decision",
  content: "Use an append-only event journal.",
  provenance: { kind: "user-authored" },
  author: actor,
  status: "active",
  version: 1,
  createdAt,
  updatedAt: createdAt,
} as const;

const transferredMemory = {
  ...userMemory,
  provenance: {
    kind: "transferred",
    sourceProjectId: ids.otherProject,
    sourceEntryId: ids.successor,
    destinationProjectId: ids.project,
    transferredBy: actor,
    transferredAt: updatedAt,
    selectedContent: userMemory.content,
  },
} as const;

describe("Project identity and rank contracts", () => {
  it("accepts branded identities and rejects malformed values", () => {
    expect(decodeMemoryEntryId(ids.entry)).toBe(ids.entry);
    expect(decodeBindingReceiptId(ids.receipt)).toBe(ids.receipt);
    expect(() => decodeMemoryEntryId("not-a-uuid")).toThrow();
    expect(() => decodeBindingReceiptId("not-a-uuid")).toThrow();
  });

  it.each(["0/1", "-1/2", "17/9"])("accepts canonical rank %s", (rank) => {
    expect(decodeProjectRank(rank)).toBe(rank);
  });

  it.each(["1/0", "2/4", "-0/1", "01/2", "1/-2", "1", " 1/2 "])(
    "rejects non-canonical rank %s",
    (rank) => expect(() => decodeProjectRank(rank)).toThrow(),
  );
});

describe("Project read contracts", () => {
  it.each([chatProject, workProject, codeProject])("decodes a strict $type Project", (project) => {
    expect(decodeProject(project)).toMatchObject(project);
    expect(() => decodeProject({ ...project, privateValue: true })).toThrow();
  });

  it("separates virtual Chat Projects from bound Projects", () => {
    expect(() => decodeProject({ ...chatProject, binding, bindingHistory: [] })).toThrow();
    expect(() => decodeProject({ ...workProject, bindingHistory: [] })).toThrow();
    expect(
      decodeProject({ ...codeProject, codeAccessPersistence: "project-default" }),
    ).toMatchObject({ codeAccessPersistence: "project-default" });
  });

  it("keeps binding audit history out of compact Project summaries", () => {
    const { bindingHistory: _, ...summary } = workProject;
    expect(decodeProjectSummary({ ...summary, bindingRevisionId: ids.revision })).toMatchObject({
      type: "work",
      binding,
      bindingRevisionId: ids.revision,
    });
    expect(() => decodeProjectSummary(workProject)).toThrow();
    const { bindingHistory: _codeHistory, ...codeSummary } = codeProject;
    expect(
      decodeProjectSummary({
        ...codeSummary,
        bindingRevisionId: ids.revision,
        codeAccessPersistence: "project-default",
      }),
    ).toMatchObject({
      type: "code",
      bindingRevisionId: ids.revision,
      codeAccessPersistence: "project-default",
    });
  });

  it("decodes immutable relink revisions with previous and current bindings", () => {
    const revision = {
      revisionId: ids.revision,
      revision: 2,
      previousBinding: { canonicalRoot: "/Users/example/Old Atlas" },
      currentBinding: binding,
      actor,
      changedAt: updatedAt,
    } as const;
    expect(
      decodeProject({ ...workProject, bindingHistory: [initialBindingRevision, revision] }),
    ).toMatchObject({ bindingHistory: [initialBindingRevision, revision] });
  });

  it.each([
    { projectId: ids.project, status: "available", observedAt: updatedAt },
    {
      projectId: ids.project,
      status: "unavailable",
      observedAt: updatedAt,
      reason: "Select the Project root again.",
    },
    {
      projectId: ids.project,
      status: "unverified",
      observedAt: updatedAt,
      reason: "The host could not verify this root.",
    },
  ] as const)("decodes a strict $status availability observation", (availability) => {
    expect(decodeProjectAvailability(availability)).toEqual(availability);
  });

  it("rejects misleading availability reasons and decodes bootstrap read models", () => {
    expect(() =>
      decodeProjectAvailability({
        projectId: ids.project,
        status: "available",
        observedAt: updatedAt,
        reason: "This must not be shown.",
      }),
    ).toThrow();

    const { bindingHistory: _, ...archivedCodeSummary } = codeProject;
    expect(
      decodeProjectBootstrap({
        active: [chatProject],
        archived: [
          {
            ...archivedCodeSummary,
            bindingRevisionId: ids.revision,
            lifecycle: "archived",
          },
        ],
        availability: [{ projectId: ids.project, status: "available", observedAt: updatedAt }],
        memory: [{ projectId: ids.project, active: [userMemory], history: [] }],
      }),
    ).toMatchObject({ active: [{ type: "chat" }], archived: [{ lifecycle: "archived" }] });
  });
});

describe("Project command contracts", () => {
  const commands = [
    {
      kind: "create-chat-project",
      projectId: ids.project,
      name: "Project Atlas",
      expectedVersion: 0,
      hostId: "local",
    },
    {
      kind: "create-work-project",
      projectId: ids.project,
      name: "Project Atlas",
      receiptId: ids.receipt,
      expectedVersion: 0,
      hostId: "local",
    },
    {
      kind: "create-code-project",
      projectId: ids.project,
      name: "Project Atlas",
      receiptId: ids.receipt,
      expectedVersion: 0,
      hostId: "local",
    },
    { kind: "rename-project", projectId: ids.project, name: "Atlas", expectedVersion: 1 },
    {
      kind: "move-project",
      projectId: ids.project,
      pinned: true,
      beforeProjectId: ids.otherProject,
      expectedVersion: 1,
    },
    {
      kind: "change-project-lifecycle",
      projectId: ids.project,
      lifecycle: "archived",
      expectedVersion: 1,
    },
    {
      kind: "relink-project",
      projectId: ids.project,
      receiptId: ids.receipt,
      expectedVersion: 1,
    },
  ] as const;

  it.each(commands)("decodes $kind", (command) => {
    expect(decodeProjectCommand(command)).toMatchObject(command);
  });

  it("accepts receipts rather than renderer paths or window identities", () => {
    const bound = commands[1];
    expect(() => decodeProjectCommand({ ...bound, path: "/tmp/project" })).toThrow();
    expect(() => decodeProjectCommand({ ...bound, windowId: ids.otherProject })).toThrow();
    expect(() => decodeProjectCommand({ ...commands[0], receiptId: ids.receipt })).toThrow();
  });

  it.each([
    { kind: "chat-project-created", project: chatProject },
    { kind: "work-project-created", project: workProject },
    { kind: "code-project-created", project: codeProject },
    { kind: "project-renamed", project: chatProject },
    { kind: "project-moved", project: chatProject },
    { kind: "project-lifecycle-changed", project: { ...chatProject, lifecycle: "archived" } },
    { kind: "project-relinked", project: workProject },
  ] as const)("decodes $kind result", (result) => {
    expect(decodeProjectCommandResult(result)).toMatchObject(result);
  });

  it("rejects a virtual Chat snapshot as a relink result", () => {
    expect(() =>
      decodeProjectCommandResult({ kind: "project-relinked", project: chatProject }),
    ).toThrow();
  });

  it.each([
    { category: "invalid", message: "Invalid command" },
    { category: "unauthorized", message: "Window authority is invalid" },
    { category: "unsupported", message: "Chat is disabled" },
    { category: "unavailable", message: "The selected root is unavailable" },
    { category: "not-found", message: "Project not found" },
    { category: "conflict", message: "Project changed", currentVersion: 2 },
  ] as const)("decodes $category failures", (failure) => {
    expect(decodeProjectFailure(failure)).toMatchObject(failure);
  });
});

describe("Project memory contracts", () => {
  it.each(["decision", "fact", "preference", "summary", "outcome"] as const)(
    "decodes active %s memory",
    (kind) => expect(decodeMemoryEntry({ ...userMemory, kind })).toMatchObject({ kind }),
  );

  it("preserves strict superseded and retracted history", () => {
    expect(
      decodeMemoryEntry({ ...userMemory, status: "superseded", supersededBy: ids.successor }),
    ).toMatchObject({ status: "superseded", supersededBy: ids.successor });
    const oldRetractedShape = {
      ...userMemory,
      status: "retracted",
      retractionReason: "No longer true",
    } as const;
    expect(() => decodeMemoryEntry(oldRetractedShape)).toThrow();
    const retracted = {
      ...oldRetractedShape,
      retractedBy: actor,
      retractedAt: updatedAt,
    } as const;
    expect(decodeMemoryEntry(retracted)).toMatchObject({
      author: userMemory.author,
      status: "retracted",
      retractionReason: "No longer true",
      retractedBy: actor,
      retractedAt: updatedAt,
    });
    expect(() => decodeMemoryEntry({ ...retracted, retractedAt: "not-a-timestamp" })).toThrow();
    expect(() =>
      decodeMemoryEntry({ ...retracted, retractedBy: { kind: "agent", actorId: ids.actor } }),
    ).toThrow();
    expect(() =>
      decodeMemoryEntry({ ...retracted, retractedBy: { ...actor, unexpectedAuditField: true } }),
    ).toThrow();
    expect(() => decodeMemoryEntry({ ...retracted, unexpectedAuditField: true })).toThrow();
    expect(() => decodeMemoryEntry({ ...userMemory, supersededBy: ids.successor })).toThrow();
  });

  it("requires complete immutable transfer provenance", () => {
    const provenance = {
      kind: "transferred",
      sourceProjectId: ids.otherProject,
      sourceEntryId: ids.successor,
      destinationProjectId: ids.project,
      transferredBy: actor,
      transferredAt: updatedAt,
      selectedContent: userMemory.content,
    } as const;
    expect(decodeMemoryEntry({ ...userMemory, provenance })).toMatchObject({ provenance });
    const { transferredAt: _, ...missingTimestamp } = provenance;
    expect(() => decodeMemoryEntry({ ...userMemory, provenance: missingTimestamp })).toThrow();
  });

  const commands = [
    {
      kind: "create-memory-entry",
      projectId: ids.project,
      entryId: ids.entry,
      memoryKind: "decision",
      content: userMemory.content,
      expectedVersion: 0,
    },
    {
      kind: "supersede-memory-entry",
      projectId: ids.project,
      entryId: ids.entry,
      successorEntryId: ids.successor,
      content: "Use a durable event journal.",
      expectedVersion: 1,
    },
    {
      kind: "retract-memory-entry",
      projectId: ids.project,
      entryId: ids.entry,
      reason: "The decision changed.",
      expectedVersion: 1,
    },
    {
      kind: "transfer-memory-entry",
      sourceProjectId: ids.otherProject,
      sourceEntryId: ids.successor,
      destinationProjectId: ids.project,
      destinationEntryId: ids.entry,
      expectedVersion: 0,
    },
  ] as const;

  it.each(commands)("decodes $kind without inferred memory or transfer content", (command) => {
    expect(decodeMemoryCommand(command)).toMatchObject(command);
  });

  it("rejects client-supplied content on a transfer command", () => {
    expect(() => decodeMemoryCommand({ ...commands[3], content: "Forged content" })).toThrow();
  });

  it.each([
    { kind: "memory-entry-created", entry: userMemory },
    {
      kind: "memory-entry-superseded",
      previousEntry: { ...userMemory, status: "superseded", supersededBy: ids.successor },
      entry: { ...userMemory, id: ids.successor, content: "Use a durable event journal." },
    },
    {
      kind: "memory-entry-retracted",
      entry: {
        ...userMemory,
        status: "retracted",
        retractionReason: "No longer true",
        retractedBy: actor,
        retractedAt: updatedAt,
      },
    },
    { kind: "memory-entry-transferred", entry: transferredMemory },
  ] as const)("decodes $kind result", (result) => {
    expect(decodeMemoryCommandResult(result)).toMatchObject(result);
  });

  it("requires transferred provenance on a transfer result", () => {
    expect(() =>
      decodeMemoryCommandResult({ kind: "memory-entry-transferred", entry: userMemory }),
    ).toThrow();
  });
});

describe("Project and memory event payload contracts", () => {
  it("exposes every approved versioned event tag", () => {
    expect(PROJECT_EVENT_NAMES).toEqual([
      "project.created@1",
      "project.renamed@1",
      "project.order-changed@1",
      "project.lifecycle-changed@1",
      "project.binding-relinked@1",
      "project.code-access-changed@1",
      "project.code-new-thread-workspace-changed@1",
      "project.code-pull-request-background-refresh-changed@1",
      "memory.entry-created@1",
      "memory.entry-superseded@1",
      "memory.entry-retracted@1",
      "memory.entry-transferred@1",
    ]);
  });

  it("decodes complete Project snapshots for every Project event payload", () => {
    expect(decodeProjectCreated({ project: chatProject })).toMatchObject({ project: chatProject });
    expect(decodeProjectRenamed({ project: chatProject })).toMatchObject({ project: chatProject });
    expect(decodeProjectOrderChanged({ project: chatProject })).toMatchObject({
      project: chatProject,
    });
    expect(decodeProjectLifecycleChanged({ project: chatProject })).toMatchObject({
      project: chatProject,
    });
    expect(decodeProjectBindingRelinked({ project: workProject })).toMatchObject({
      project: workProject,
    });
    expect(() => decodeProjectBindingRelinked({ project: chatProject })).toThrow();
    expect(
      decodeCodeProjectAccessChanged({
        project: { ...codeProject, codeAccessPersistence: "project-default" },
      }),
    ).toMatchObject({ project: { ...codeProject, codeAccessPersistence: "project-default" } });
  });

  it("decodes complete memory snapshots for all four memory event payloads", () => {
    const superseded = {
      ...userMemory,
      status: "superseded",
      supersededBy: ids.successor,
    } as const;
    const successor = { ...userMemory, id: ids.successor } as const;
    const retracted = {
      ...userMemory,
      status: "retracted",
      retractionReason: "No longer true",
      retractedBy: actor,
      retractedAt: updatedAt,
    } as const;
    expect(decodeMemoryEntryCreated({ entry: userMemory })).toMatchObject({ entry: userMemory });
    expect(
      decodeMemoryEntrySuperseded({ previousEntry: superseded, entry: successor }),
    ).toMatchObject({
      previousEntry: superseded,
      entry: successor,
    });
    expect(decodeMemoryEntryRetracted({ entry: retracted })).toMatchObject({ entry: retracted });
    expect(decodeMemoryEntryTransferred({ entry: transferredMemory })).toMatchObject({
      entry: transferredMemory,
    });
    expect(() => decodeMemoryEntryTransferred({ entry: userMemory })).toThrow();
  });
});

import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import {
  decodeMemoryEntry,
  decodeMemoryEntryId,
  decodeProjectId,
  type ActiveMemoryEntry,
  type MemoryKind,
  type ProjectActor,
} from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import {
  MemoryPolicyRejected,
  createMemoryEntry,
  retractMemoryEntry,
  supersedeMemoryEntry,
  transferMemoryEntry,
} from "./memoryPolicy";

const ids = {
  sourceProject: decodeProjectId("11111111-1111-4111-8111-111111111111"),
  destinationProject: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  entry: decodeMemoryEntryId("33333333-3333-4333-8333-333333333333"),
  successor: decodeMemoryEntryId("44444444-4444-4444-8444-444444444444"),
  destination: decodeMemoryEntryId("55555555-5555-4555-8555-555555555555"),
} as const;

const createdAt = "2026-07-14T08:00:00.000Z" as UtcTimestamp;
const changedAt = "2026-07-14T09:00:00.000Z" as UtcTimestamp;
const laterAt = "2026-07-14T10:00:00.000Z" as UtcTimestamp;
const actor = {
  kind: "local-user",
  actorId: "66666666-6666-4666-8666-666666666666",
} as ProjectActor;
const otherActor = {
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
} as ProjectActor;
const version = (value: number) => value as AggregateVersion;

function activeEntry(overrides: Partial<ActiveMemoryEntry> = {}): ActiveMemoryEntry {
  return decodeMemoryEntry({
    id: ids.entry,
    projectId: ids.sourceProject,
    kind: "decision",
    content: "Use the durable event journal.",
    provenance: { kind: "user-authored" },
    author: actor,
    status: "active",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }) as ActiveMemoryEntry;
}

describe("explicit Project memory creation", () => {
  it.each(["decision", "fact", "preference", "summary", "outcome"] as const)(
    "creates active user-authored %s memory scoped to one Project",
    (kind: MemoryKind) => {
      const entry = createMemoryEntry({
        id: ids.entry,
        projectId: ids.sourceProject,
        kind,
        content: "  Keep this exact approved content.  ",
        actor,
        createdAt,
        expectedVersion: version(0),
      });

      expect(entry).toEqual({
        id: ids.entry,
        projectId: ids.sourceProject,
        kind,
        content: "Keep this exact approved content.",
        provenance: { kind: "user-authored" },
        author: actor,
        status: "active",
        version: 1,
        createdAt,
        updatedAt: createdAt,
      });
    },
  );

  it("rejects silent system creation and empty content", () => {
    expect(() =>
      createMemoryEntry({
        id: ids.entry,
        projectId: ids.sourceProject,
        kind: "fact",
        content: "Inferred content",
        actor: { ...actor, kind: "system" },
        createdAt,
        expectedVersion: version(0),
      }),
    ).toThrow(MemoryPolicyRejected);
    expect(() =>
      createMemoryEntry({
        id: ids.entry,
        projectId: ids.sourceProject,
        kind: "fact",
        content: "   ",
        actor,
        createdAt,
        expectedVersion: version(0),
      }),
    ).toThrow(MemoryPolicyRejected);
  });
});

describe("append-oriented correction and retraction", () => {
  it("supersedes only an active predecessor and returns immutable history plus successor", () => {
    const original = activeEntry();
    const result = supersedeMemoryEntry(original, {
      successorEntryId: ids.successor,
      content: "  Use the replayable durable event journal. ",
      actor: otherActor,
      supersededAt: changedAt,
      expectedVersion: version(1),
    });

    expect(result.previousEntry).toEqual({
      ...original,
      status: "superseded",
      supersededBy: ids.successor,
      version: 2,
      updatedAt: changedAt,
    });
    expect(result.entry).toEqual({
      id: ids.successor,
      projectId: original.projectId,
      kind: original.kind,
      content: "Use the replayable durable event journal.",
      provenance: original.provenance,
      author: otherActor,
      status: "active",
      version: 2,
      createdAt: changedAt,
      updatedAt: changedAt,
    });
    expect(original).toEqual(activeEntry());
    expect(result.previousEntry).not.toBe(original);
    expect(result.entry.provenance).not.toBe(original.provenance);
  });

  it("supports correction chains and rejects duplicate IDs, double supersede, and retracted predecessors", () => {
    const first = supersedeMemoryEntry(activeEntry(), {
      successorEntryId: ids.successor,
      content: "Second version",
      actor,
      supersededAt: changedAt,
      expectedVersion: version(1),
    });
    const second = supersedeMemoryEntry(first.entry, {
      successorEntryId: ids.destination,
      content: "Third version",
      actor,
      supersededAt: laterAt,
      expectedVersion: version(2),
    });
    expect(second.previousEntry.supersededBy).toBe(ids.destination);
    expect(second.entry.version).toBe(3);
    expect(() =>
      supersedeMemoryEntry(activeEntry(), {
        successorEntryId: ids.entry,
        content: "Duplicate",
        actor,
        supersededAt: changedAt,
        expectedVersion: version(1),
      }),
    ).toThrow(MemoryPolicyRejected);
    expect(() =>
      supersedeMemoryEntry(first.previousEntry, {
        successorEntryId: ids.destination,
        content: "Double supersede",
        actor,
        supersededAt: laterAt,
        expectedVersion: version(2),
      }),
    ).toThrow(MemoryPolicyRejected);
    expect(() =>
      supersedeMemoryEntry(
        {
          ...activeEntry(),
          status: "retracted",
          retractionReason: "Wrong",
          retractedBy: actor,
          retractedAt: changedAt,
        },
        {
          successorEntryId: ids.destination,
          content: "Reactivate",
          actor,
          supersededAt: laterAt,
          expectedVersion: version(2),
        },
      ),
    ).toThrow(MemoryPolicyRejected);
  });

  it("retracts only active memory with an audited actor, timestamp, and non-empty reason", () => {
    const original = activeEntry();
    const retracted = retractMemoryEntry(original, {
      reason: "  This decision no longer applies. ",
      actor: otherActor,
      retractedAt: changedAt,
      expectedVersion: version(1),
    });

    expect(retracted).toEqual({
      ...original,
      status: "retracted",
      retractionReason: "This decision no longer applies.",
      retractedBy: otherActor,
      retractedAt: changedAt,
      version: 2,
      updatedAt: changedAt,
    });
    expect(retracted.author).toEqual(original.author);
    expect(retracted.author).not.toBe(otherActor);
    expect(retracted.content).toBe(original.content);
    expect(retracted.provenance).toEqual(original.provenance);
    expect(retracted.provenance).not.toBe(original.provenance);
    expect(original.status).toBe("active");
    expect(() =>
      retractMemoryEntry(original, {
        reason: "  ",
        actor,
        retractedAt: changedAt,
        expectedVersion: version(1),
      }),
    ).toThrow(MemoryPolicyRejected);
    expect(() =>
      retractMemoryEntry(retracted, {
        reason: "Again",
        actor,
        retractedAt: laterAt,
        expectedVersion: version(2),
      }),
    ).toThrow(MemoryPolicyRejected);
  });
});

describe("explicit independent memory transfer", () => {
  it.each([
    ["same-Project", ids.sourceProject],
    ["cross-Project and cross-mode", ids.destinationProject],
  ] as const)(
    "copies active source content for %s transfer with complete provenance",
    (_, projectId) => {
      const source = activeEntry();
      const destination = transferMemoryEntry(source, {
        destinationProjectId: projectId,
        destinationEntryId: ids.destination,
        actor: otherActor,
        transferredAt: changedAt,
        expectedVersion: version(7),
      });

      expect(destination).toEqual({
        id: ids.destination,
        projectId,
        kind: source.kind,
        content: source.content,
        provenance: {
          kind: "transferred",
          sourceProjectId: source.projectId,
          sourceEntryId: source.id,
          destinationProjectId: projectId,
          transferredBy: otherActor,
          transferredAt: changedAt,
          selectedContent: source.content,
        },
        author: otherActor,
        status: "active",
        version: 8,
        createdAt: changedAt,
        updatedAt: changedAt,
      });
      expect(destination.provenance).not.toBe(source.provenance);
    },
  );

  it("takes no alternate source content and remains unchanged after source mutations", () => {
    const source = activeEntry();
    const destination = transferMemoryEntry(source, {
      destinationProjectId: ids.destinationProject,
      destinationEntryId: ids.destination,
      actor,
      transferredAt: changedAt,
      expectedVersion: version(0),
    });
    const changedSource = supersedeMemoryEntry(source, {
      successorEntryId: ids.successor,
      content: "A later source correction",
      actor,
      supersededAt: laterAt,
      expectedVersion: version(1),
    });

    expect(destination.content).toBe("Use the durable event journal.");
    expect(destination.provenance.selectedContent).toBe("Use the durable event journal.");
    expect(changedSource.entry.content).toBe("A later source correction");
  });

  it("rejects inactive sources, a reused destination ID, and non-user transfer actors", () => {
    const source = activeEntry();
    const input = {
      destinationProjectId: ids.destinationProject,
      destinationEntryId: ids.destination,
      actor,
      transferredAt: changedAt,
      expectedVersion: version(0),
    } as const;
    expect(() =>
      transferMemoryEntry({ ...source, status: "superseded", supersededBy: ids.successor }, input),
    ).toThrow(MemoryPolicyRejected);
    expect(() =>
      transferMemoryEntry(
        {
          ...source,
          status: "retracted",
          retractionReason: "No longer active",
          retractedBy: actor,
          retractedAt: changedAt,
        },
        input,
      ),
    ).toThrow(MemoryPolicyRejected);
    expect(() => transferMemoryEntry(source, { ...input, destinationEntryId: source.id })).toThrow(
      MemoryPolicyRejected,
    );
    expect(() =>
      transferMemoryEntry(source, { ...input, actor: { ...actor, kind: "system" } }),
    ).toThrow(MemoryPolicyRejected);
  });
});

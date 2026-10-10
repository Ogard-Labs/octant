import { ARTIFACT_BUNDLE_FORMAT, decodeArtifactBundle } from "@octant/contracts/artifact-bundle";
import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type { HostId } from "@octant/contracts/host";
import {
  REPLICA_ENTRY_FORMAT,
  decodeReplicaArtifactEntry,
  decodeReplicaCommentEntry,
  type ReplicaCommentEntry,
  type ReplicaInstanceId,
  type ReplicaSignatureVerdict,
  type ReplicaArtifactEntry,
} from "@octant/contracts/replica-entry";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  decideReplicaArtifactBinding,
  mergeReplicaArtifactBlocks,
  reconcileReplicaEntry,
  replicaArtifactHeads,
  replicaArtifactHidden,
  replicaArtifactStanding,
  replicaReconcileCannotOverwrite,
  type ReplicaAppliedEntry,
  type ReplicaArtifactRecord,
  type ReplicaLocalState,
  type ReplicaReconcileOutcome,
} from "./replicaEntryPolicy";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111" as CanvasId,
  version: "22222222-2222-4222-8222-222222222222" as CanvasVersionId,
  parent: "33333333-3333-4333-8333-333333333333" as CanvasVersionId,
  otherVersion: "44444444-4444-4444-8444-444444444444" as CanvasVersionId,
  project: "55555555-5555-4555-8555-555555555555",
  thread: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
  north: "99999999-9999-4999-8999-999999999999" as ReplicaInstanceId,
  south: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ReplicaInstanceId,
  revoked: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as ReplicaInstanceId,
  local: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as ReplicaInstanceId,
  stranger: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as ReplicaInstanceId,
} as const;

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const now = "2026-08-18T09:00:00.000Z";
const localHost = "host-local" as HostId;

function bundle(versionId: string, hostId: string, text: string) {
  return decodeArtifactBundle({
    octant: {
      format: ARTIFACT_BUNDLE_FORMAT,
      canvasId: ids.canvas,
      versionId,
      sequence: 1,
      title: "Launch plan",
      mode: "work",
      projectId: ids.project,
      hostId,
      createdAt: now,
    },
    definition: {
      schemaVersion: 1,
      title: "Launch plan",
      provenance: {
        hostId,
        projectId: ids.project,
        actor: { kind: "system", actorId: ids.actor },
        providerInstanceId: ids.provider,
        modelId: "octant-test-model",
        createdAt: now,
        mode: "work",
        threadId: ids.thread,
      },
      sourceManifest: [],
      blocks: [{ blockId: "t1", schemaVersion: 1, kind: "rich-text", text }],
    },
  });
}

function entry(options: {
  readonly instanceId?: ReplicaInstanceId;
  readonly displayName?: string;
  readonly sequence?: number;
  readonly kind?: ReplicaArtifactEntry["kind"];
  readonly hostId?: string;
  readonly versionId?: string;
  readonly parents?: ReadonlyArray<string>;
  readonly contentHash?: string;
  readonly text?: string;
  readonly bundleCanvasId?: string;
  readonly bundleHostId?: string;
}): ReplicaArtifactEntry {
  const hostId = options.hostId ?? "host-north";
  const versionId = options.versionId ?? ids.version;
  const contentHash = options.contentHash ?? hashA;
  const decoded = decodeReplicaArtifactEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: options.kind ?? "artifact-version",
    origin: {
      instanceId: options.instanceId ?? ids.north,
      displayName: options.displayName ?? "North",
      sequence: options.sequence ?? 1,
      publicKey: "MCowBQYDK2VwAyEAsI3Vx6E5C70zWN51mv4VIXZxVQC4M1DBS7XoBYp5/R4=",
    },
    artifact: { canvasId: ids.canvas, hostId, projectName: "Launch" },
    parents: (options.parents ?? [ids.parent]).map((versionId) => ({ versionId })),
    contentHash,
    bundle: bundle(
      versionId,
      options.bundleHostId ?? hostId,
      options.text ?? "Ship the preview first.",
    ),
  });
  if (options.bundleCanvasId === undefined) return decoded;
  return decodeReplicaArtifactEntry({
    ...decoded,
    bundle: {
      ...decoded.bundle,
      octant: { ...decoded.bundle.octant, canvasId: options.bundleCanvasId },
    },
  });
}

function state(overrides: Partial<ReplicaLocalState> = {}): ReplicaLocalState {
  return {
    localHostId: localHost,
    localInstanceId: ids.local,
    instances: [
      { instanceId: ids.local, status: "member" },
      { instanceId: ids.north, status: "member" },
      { instanceId: ids.south, status: "member" },
    ],
    applied: [],
    listedSlots: [],
    settledSlots: [],
    artifacts: [],
    measuredContentHash: hashA,
    signature: "verified",
    ...overrides,
  };
}

function slot(instanceId: ReplicaInstanceId, sequence: number) {
  return { instanceId, sequence };
}

function appliedFrom(value: ReplicaArtifactEntry): ReplicaAppliedEntry {
  return {
    instanceId: value.origin.instanceId,
    sequence: value.origin.sequence,
    kind: value.kind,
    contentHash: value.contentHash,
  };
}

function versionFrom(value: ReplicaArtifactEntry) {
  return {
    versionId: value.bundle.octant.versionId,
    contentHash: value.contentHash,
    parentVersionIds: value.parents.map((parent: { readonly versionId: string }) =>
      String(parent.versionId),
    ),
  };
}

/**
 * What a caller does with a decision. It has no replace branch: a keeping
 * outcome adds, and a refusal leaves the library as it was.
 */
function noteApplied(
  local: ReplicaLocalState,
  value: ReplicaArtifactEntry,
  outcome: ReplicaReconcileOutcome,
): ReplicaLocalState {
  if (outcome.outcome === "already-present" || outcome.outcome === "refused") return local;
  const applied = [...local.applied, appliedFrom(value)];
  const existing = local.artifacts.find(
    (artifact) => String(artifact.canvasId) === String(value.artifact.canvasId),
  );
  if (outcome.outcome === "tombstone") {
    const tombstone = {
      contentHash: value.contentHash,
      originInstanceId: value.origin.instanceId,
      originSequence: value.origin.sequence,
      parentVersionIds: value.parents.map((parent) => String(parent.versionId)),
    };
    const artifacts: ReadonlyArray<ReplicaArtifactRecord> =
      existing === undefined
        ? [
            ...local.artifacts,
            {
              canvasId: value.artifact.canvasId,
              originHostId: value.artifact.hostId,
              versions: [],
              tombstones: [tombstone],
            },
          ]
        : local.artifacts.map((artifact) =>
            artifact === existing
              ? { ...artifact, tombstones: [...artifact.tombstones, tombstone] }
              : artifact,
          );
    return { ...local, applied, artifacts };
  }
  const version = versionFrom(value);
  const artifacts: ReadonlyArray<ReplicaArtifactRecord> =
    existing === undefined
      ? [
          ...local.artifacts,
          {
            canvasId: value.artifact.canvasId,
            originHostId: value.artifact.hostId,
            versions: [version],
            tombstones: [],
          },
        ]
      : local.artifacts.map((artifact) =>
          artifact === existing
            ? { ...artifact, versions: [...artifact.versions, version] }
            : artifact,
        );
  return { ...local, applied, artifacts };
}

describe("reconciling a replica entry", () => {
  it("cannot express overwrite", () => {
    expect(replicaReconcileCannotOverwrite).toBe(true);
    expectTypeOf<ReplicaReconcileOutcome["outcome"]>().toEqualTypeOf<
      | "append-version"
      | "append-comment"
      | "already-present"
      | "concurrent-head"
      | "tombstone"
      | "refused"
    >();
  });

  it("changes nothing when the same entry is pulled again", () => {
    const value = entry({});
    const first = reconcileReplicaEntry(state(), value);
    expect(first).toEqual({ outcome: "append-version" });
    const noted = noteApplied(state(), value, first);
    const before = structuredClone(noted);
    expect(reconcileReplicaEntry(noted, value)).toEqual({ outcome: "already-present" });
    expect(noted).toEqual(before);
    expect(noteApplied(noted, value, { outcome: "already-present" }).applied).toHaveLength(1);
  });

  it("keeps both heads when two computers revise the same parent", () => {
    const north = entry({
      instanceId: ids.north,
      sequence: 1,
      versionId: ids.version,
      contentHash: hashA,
      parents: [ids.parent],
      text: "North's revision",
    });
    const south = entry({
      instanceId: ids.south,
      displayName: "South",
      sequence: 1,
      versionId: ids.otherVersion,
      contentHash: hashB,
      parents: [ids.parent],
      text: "South's revision",
      hostId: "host-north",
    });
    const afterNorth = noteApplied(state(), north, reconcileReplicaEntry(state(), north));
    const southState = { ...afterNorth, measuredContentHash: hashB };
    const second = reconcileReplicaEntry(southState, south);
    expect(second).toEqual({ outcome: "concurrent-head" });
    const afterBoth = noteApplied(southState, south, second);
    expect(afterBoth.artifacts[0]?.versions.map((version) => String(version.versionId))).toEqual([
      ids.version,
      ids.otherVersion,
    ]);
    expect(afterBoth.applied).toHaveLength(2);
  });

  it("refuses an entry from a revoked instance", () => {
    const value = entry({ instanceId: ids.revoked, displayName: "Revoked" });
    const revoked = state({
      instances: [
        { instanceId: ids.local, status: "member" },
        { instanceId: ids.north, status: "member" },
        { instanceId: ids.revoked, status: "revoked", lastAcceptedSequence: 0 },
      ],
    });
    expect(reconcileReplicaEntry(revoked, value)).toEqual({
      outcome: "refused",
      reason: "revoked-instance",
    });
  });

  it("appends a later version after a tombstone and keeps the tombstone", () => {
    const first = entry({ sequence: 1, versionId: ids.version, contentHash: hashA, parents: [] });
    const tombstone = entry({
      kind: "artifact-tombstone",
      sequence: 2,
      versionId: ids.version,
      contentHash: hashB,
      parents: [ids.version],
    });
    const revival = entry({
      instanceId: ids.south,
      displayName: "South",
      sequence: 1,
      versionId: ids.otherVersion,
      contentHash: hashC,
      parents: [ids.version],
      text: "Revived on another computer",
    });
    const afterFirst = noteApplied(state(), first, reconcileReplicaEntry(state(), first));
    const tombstoneState = { ...afterFirst, measuredContentHash: hashB };
    const tombstoneOutcome = reconcileReplicaEntry(tombstoneState, tombstone);
    expect(tombstoneOutcome).toEqual({ outcome: "tombstone" });
    const afterTombstone = noteApplied(tombstoneState, tombstone, tombstoneOutcome);
    const revivalState = { ...afterTombstone, measuredContentHash: hashC };
    const before = structuredClone(revivalState);
    const revived = reconcileReplicaEntry(revivalState, revival);
    expect(revived).toEqual({ outcome: "append-version" });
    expect(revivalState).toEqual(before);
    expect(revivalState.artifacts[0]?.tombstones).toHaveLength(1);
    expect(revivalState.artifacts[0]?.versions).toHaveLength(1);
    const afterRevival = noteApplied(revivalState, revival, revived);
    expect(afterRevival.artifacts[0]?.tombstones).toHaveLength(1);
    expect(afterRevival.artifacts[0]?.versions).toHaveLength(2);
    expect(revived).not.toHaveProperty("replace");
    expect(revived).not.toHaveProperty("overwrite");
  });

  it("holds a later entry while an earlier listed slot of its writer is unsettled", () => {
    const first = entry({ sequence: 1, contentHash: hashA, versionId: ids.version, parents: [] });
    const second = entry({
      sequence: 2,
      contentHash: hashB,
      versionId: ids.otherVersion,
      parents: [ids.version],
      text: "Second",
    });
    const third = entry({
      sequence: 3,
      contentHash: hashC,
      versionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      parents: [ids.otherVersion],
      text: "Third",
    });
    const listed = state({ listedSlots: [1, 2, 3].map((sequence) => slot(ids.north, sequence)) });
    const afterFirst = noteApplied(listed, first, reconcileReplicaEntry(listed, first));
    const held = reconcileReplicaEntry({ ...afterFirst, measuredContentHash: hashC }, third);
    expect(held).toEqual({ outcome: "refused", reason: "sequence-gap" });
    expect(noteApplied(afterFirst, third, held).applied).toHaveLength(1);
    const afterSecond = noteApplied(
      { ...afterFirst, measuredContentHash: hashB },
      second,
      reconcileReplicaEntry({ ...afterFirst, measuredContentHash: hashB }, second),
    );
    expect(reconcileReplicaEntry({ ...afterSecond, measuredContentHash: hashC }, third)).toEqual({
      outcome: "append-version",
    });
  });

  it("applies a writer's first artifact entry after its own membership records", () => {
    // North founded the store at 1 and approved a computer at 2; its first
    // Canvas is its sequence 3, in the same sequence space.
    const first = entry({ sequence: 3, parents: [] });
    expect(
      reconcileReplicaEntry(
        state({
          listedSlots: [1, 2, 3].map((sequence) => slot(ids.north, sequence)),
          settledSlots: [1, 2].map((sequence) => slot(ids.north, sequence)),
        }),
        first,
      ),
    ).toEqual({ outcome: "append-version" });
  });

  it("does not wait on a slot the store does not list or that holds no valid record", () => {
    const later = entry({ sequence: 5, parents: [] });
    // 2 was squatted and its file removed, so the store no longer lists it;
    // 3 holds someone else's bytes, settled here as not a valid record; 4 is
    // a membership record. None of them is an entry this writer still owes.
    expect(
      reconcileReplicaEntry(
        state({
          listedSlots: [1, 3, 4, 5].map((sequence) => slot(ids.north, sequence)),
          settledSlots: [1, 3, 4].map((sequence) => slot(ids.north, sequence)),
        }),
        later,
      ),
    ).toEqual({ outcome: "append-version" });
    // Another writer's unsettled slot never holds this one back.
    expect(
      reconcileReplicaEntry(state({ listedSlots: [slot(ids.south, 1)] }), entry({ sequence: 2 })),
    ).toEqual({ outcome: "append-version" });
  });

  it("refuses an entry from an instance it does not know", () => {
    const stranger = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as ReplicaInstanceId;
    expect(
      reconcileReplicaEntry(state(), entry({ instanceId: stranger, displayName: "Stranger" })),
    ).toEqual({
      outcome: "refused",
      reason: "unknown-instance",
    });
  });

  it("refuses an entry that names a local artifact as foreign", () => {
    const localArtifact: ReplicaArtifactRecord = {
      canvasId: ids.canvas,
      originHostId: localHost,
      versions: [],
      tombstones: [],
    };
    const foreign = entry({ hostId: "host-north", sequence: 1 });
    expect(reconcileReplicaEntry(state({ artifacts: [localArtifact] }), foreign)).toEqual({
      outcome: "refused",
      reason: "names-local-artifact-as-foreign",
    });
  });

  it("refuses an entry whose content hash does not match", () => {
    expect(
      reconcileReplicaEntry(state({ measuredContentHash: hashB }), entry({ contentHash: hashA })),
    ).toEqual({ outcome: "refused", reason: "hash-mismatch" });
  });

  it("refuses a bad signature and a missing signature", () => {
    const value = entry({});
    for (const signature of [
      "bad-signature",
      "missing",
    ] as const satisfies ReadonlyArray<ReplicaSignatureVerdict>) {
      expect(reconcileReplicaEntry(state({ signature }), value)).toEqual({
        outcome: "refused",
        reason: "bad-signature",
      });
    }
  });

  it("refuses a different body for a version that is already in the library", () => {
    const first = entry({ sequence: 1, versionId: ids.version, contentHash: hashA });
    const noted = noteApplied(state(), first, reconcileReplicaEntry(state(), first));
    const replacement = entry({
      instanceId: ids.south,
      displayName: "South",
      sequence: 1,
      versionId: ids.version,
      contentHash: hashB,
      text: "A different body for the same version",
    });
    expect(reconcileReplicaEntry({ ...noted, measuredContentHash: hashB }, replacement)).toEqual({
      outcome: "refused",
      reason: "hash-mismatch",
    });
  });

  it("refuses a different body for a sequence that was already applied", () => {
    const first = entry({ sequence: 1, contentHash: hashA });
    const noted = noteApplied(state(), first, reconcileReplicaEntry(state(), first));
    const replacement = entry({ sequence: 1, contentHash: hashB, text: "A different body" });
    expect(reconcileReplicaEntry({ ...noted, measuredContentHash: hashB }, replacement)).toEqual({
      outcome: "refused",
      reason: "hash-mismatch",
    });
  });
});

function commentEntry(options: {
  readonly instanceId?: ReplicaInstanceId;
  readonly sequence?: number;
  readonly hostId?: string;
  readonly after?: ReadonlyArray<{
    readonly instanceId: ReplicaInstanceId;
    readonly sequence: number;
  }>;
  readonly contentHash?: string;
}): ReplicaCommentEntry {
  return decodeReplicaCommentEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: "canvas-comment",
    origin: {
      instanceId: options.instanceId ?? ids.north,
      displayName: "North",
      sequence: options.sequence ?? 1,
      publicKey: "MCowBQYDK2VwAyEAsI3Vx6E5C70zWN51mv4VIXZxVQC4M1DBS7XoBYp5/R4=",
    },
    artifact: {
      canvasId: ids.canvas,
      hostId: options.hostId ?? "host-north",
      projectName: "Launch",
    },
    after: options.after ?? [],
    contentHash: options.contentHash ?? hashA,
    change: {
      kind: "comment",
      commentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      anchor: { kind: "block", blockId: "t1" },
      author: { kind: "local-user", actorId: ids.actor },
      body: "Move the launch to Monday?",
      createdAt: now,
    },
  });
}

describe("reconciling a restore", () => {
  it("applies an artifact entry ahead of its writer's earlier slots, and ends with the same heads", () => {
    const first = entry({ sequence: 1, contentHash: hashA, versionId: ids.version, parents: [] });
    const second = entry({
      sequence: 2,
      contentHash: hashB,
      versionId: ids.otherVersion,
      parents: [ids.version],
      text: "Second",
    });
    const listed = state({
      listedSlots: [slot(ids.north, 1), slot(ids.north, 2)],
      restoring: true,
    });
    // Newest first: the second version applies before the first is read.
    const newest = reconcileReplicaEntry({ ...listed, measuredContentHash: hashB }, second);
    expect(newest).toEqual({ outcome: "append-version" });
    const afterNewest = noteApplied(listed, second, newest);
    const oldest = reconcileReplicaEntry(afterNewest, first);
    expect(oldest).toEqual({ outcome: "append-version" });
    const restored = noteApplied(afterNewest, first, oldest);

    const inOrder = noteApplied(listed, first, reconcileReplicaEntry(listed, first));
    const writerOrder = noteApplied(
      inOrder,
      second,
      reconcileReplicaEntry({ ...inOrder, measuredContentHash: hashB }, second),
    );
    const record = (local: ReplicaLocalState) => {
      const artifact = local.artifacts[0];
      if (artifact === undefined) throw new Error("no artifact");
      return replicaArtifactHeads(artifact);
    };
    expect(record(restored)).toEqual(record(writerOrder));
    expect(record(restored)).toEqual([{ kind: "version", versionId: ids.otherVersion }]);
  });

  it("still holds a comment entry until its writer's earlier slots are settled", () => {
    const comment = commentEntry({ sequence: 2 });
    const restoring = state({
      listedSlots: [slot(ids.north, 1), slot(ids.north, 2)],
      restoring: true,
    });
    expect(reconcileReplicaEntry(restoring, comment)).toEqual({
      outcome: "refused",
      reason: "sequence-gap",
    });
    expect(
      reconcileReplicaEntry({ ...restoring, settledSlots: [slot(ids.north, 1)] }, comment),
    ).toEqual({ outcome: "append-comment" });
  });
});

describe("reconciling a comment entry", () => {
  it("waits until every comment entry its writer had seen is here", () => {
    const reply = commentEntry({
      instanceId: ids.south,
      sequence: 1,
      after: [slot(ids.north, 4)],
    });
    expect(reconcileReplicaEntry(state(), reply)).toEqual({
      outcome: "refused",
      reason: "sequence-gap",
    });
    const seen = state({
      applied: [{ instanceId: ids.north, sequence: 4, kind: "canvas-comment", contentHash: hashB }],
    });
    expect(reconcileReplicaEntry(seen, reply)).toEqual({ outcome: "append-comment" });
  });

  it("changes nothing when the same comment entry is pulled again, and refuses another body in its slot", () => {
    const comment = commentEntry({ sequence: 3 });
    const applied = state({
      applied: [{ instanceId: ids.north, sequence: 3, kind: "canvas-comment", contentHash: hashA }],
    });
    expect(reconcileReplicaEntry(applied, comment)).toEqual({ outcome: "already-present" });
    expect(
      reconcileReplicaEntry(
        { ...applied, measuredContentHash: hashB },
        commentEntry({ sequence: 3, contentHash: hashB }),
      ),
    ).toEqual({ outcome: "refused", reason: "hash-mismatch" });
  });

  it("refuses a comment from a computer that is not a member, or one whose content does not match", () => {
    expect(reconcileReplicaEntry(state(), commentEntry({ instanceId: ids.stranger }))).toEqual({
      outcome: "refused",
      reason: "unknown-instance",
    });
    expect(
      reconcileReplicaEntry({ ...state(), measuredContentHash: hashB }, commentEntry({})),
    ).toEqual({ outcome: "refused", reason: "hash-mismatch" });
  });

  it("refuses a comment that names a local artifact as foreign", () => {
    const local = state({
      artifacts: [{ canvasId: ids.canvas, originHostId: localHost, versions: [], tombstones: [] }],
    });
    expect(reconcileReplicaEntry(local, commentEntry({}))).toEqual({
      outcome: "refused",
      reason: "names-local-artifact-as-foreign",
    });
  });
});

describe("the heads of a replicated artifact", () => {
  const version = (versionId: string, parents: ReadonlyArray<string>) => ({
    versionId: versionId as CanvasVersionId,
    contentHash: hashA,
    parentVersionIds: parents,
  });
  const tombstone = (parents: ReadonlyArray<string>, originSequence = 4) => ({
    contentHash: hashA,
    originInstanceId: ids.north,
    originSequence,
    parentVersionIds: parents,
  });

  it("keeps both revisions from one parent as two heads", () => {
    const record = {
      versions: [
        version(ids.parent, []),
        version(ids.version, [ids.parent]),
        version(ids.otherVersion, [ids.parent]),
      ],
      tombstones: [],
    };
    expect(replicaArtifactHeads(record)).toEqual([
      { kind: "version", versionId: ids.version },
      { kind: "version", versionId: ids.otherVersion },
    ]);
    expect(replicaArtifactHidden(record)).toBe(false);
  });

  it("hides an artifact only while a tombstone is its only head", () => {
    const deleted = { versions: [version(ids.parent, [])], tombstones: [tombstone([ids.parent])] };
    expect(replicaArtifactHidden(deleted)).toBe(true);
    // A revision from the same parent stands beside the deletion, which stays.
    const revised = {
      versions: [...deleted.versions, version(ids.version, [ids.parent])],
      tombstones: deleted.tombstones,
    };
    expect(replicaArtifactHeads(revised)).toEqual([
      { kind: "version", versionId: ids.version },
      { kind: "tombstone", originInstanceId: ids.north, originSequence: 4 },
    ]);
    expect(replicaArtifactHidden(revised)).toBe(false);
  });
});

describe("where a synced artifact stands", () => {
  const version = (versionId: string, parents: ReadonlyArray<string>) => ({
    versionId: versionId as CanvasVersionId,
    contentHash: hashA,
    parentVersionIds: parents,
  });
  const deletion = (parents: ReadonlyArray<string>) => ({
    contentHash: hashA,
    originInstanceId: ids.north,
    originSequence: 7,
    parentVersionIds: parents,
  });
  const twoHeads = {
    versions: [
      version(ids.parent, []),
      version(ids.version, [ids.parent]),
      version(ids.otherVersion, [ids.parent]),
    ],
    tombstones: [],
  };

  it("offers two versions revised from one parent to choose between", () => {
    expect(replicaArtifactStanding(twoHeads)).toEqual({
      status: "two-versions",
      candidates: [ids.version, ids.otherVersion],
      ahead: undefined,
      deletions: [],
    });
  });

  it("counts the version open here as one of the two, and not a head it already holds", () => {
    // Open here at `version`; the other computer's `otherVersion` stands beside it.
    expect(
      replicaArtifactStanding(twoHeads, {
        currentVersionId: ids.version,
        versionIds: [ids.parent, ids.version],
      }),
    ).toMatchObject({ status: "two-versions", candidates: [ids.version, ids.otherVersion] });
    // A version written here while sync was off descends from a head it holds.
    const writtenHere = "12121212-1212-4121-8121-121212121212";
    expect(
      replicaArtifactStanding(
        { versions: [version(ids.parent, [])], tombstones: [] },
        { currentVersionId: writtenHere, versionIds: [ids.parent, writtenHere] },
      ),
    ).toMatchObject({ status: "current", candidates: [writtenHere], ahead: undefined });
  });

  it("appends a later version from another computer rather than offering a choice", () => {
    const resolved = "13131313-1313-4131-8131-131313131313";
    const record = {
      versions: [...twoHeads.versions, version(resolved, [ids.version, ids.otherVersion])],
      tombstones: [],
    };
    expect(
      replicaArtifactStanding(record, {
        currentVersionId: ids.version,
        versionIds: [ids.parent, ids.version],
      }),
    ).toEqual({ status: "current", candidates: [resolved], ahead: resolved, deletions: [] });
  });

  it("says deleted only while the deletion is all that is left, and not once restored", () => {
    const tombstone = deletion([ids.parent]);
    const deleted = { versions: [version(ids.parent, [])], tombstones: [tombstone] };
    expect(replicaArtifactStanding(deleted)).toEqual({
      status: "deleted",
      candidates: [],
      ahead: undefined,
      deletions: [tombstone],
    });
    // Open here at the deleted version, it is deleted here too.
    expect(
      replicaArtifactStanding(deleted, { currentVersionId: ids.parent, versionIds: [ids.parent] })
        .status,
    ).toBe("deleted");
    // A restore is a version over the deleted one; the tombstone stays in the history.
    const restored = {
      versions: [...deleted.versions, version(ids.version, [ids.parent])],
      tombstones: deleted.tombstones,
    };
    expect(replicaArtifactStanding(restored)).toMatchObject({
      status: "current",
      candidates: [ids.version],
    });
    expect(replicaArtifactHeads(restored)).toContainEqual(
      expect.objectContaining({ kind: "tombstone" }),
    );
  });
});

describe("binding a synced artifact to a thread", () => {
  const thread = {
    mode: "work" as const,
    active: true,
    projectActive: true,
    readOnly: false,
    workspaceResolved: true,
  };

  it("takes an artifact only into an active thread of its own mode whose workspace resolves", () => {
    expect(decideReplicaArtifactBinding("work", thread)).toEqual({ kind: "compatible" });
    expect(decideReplicaArtifactBinding("chat", thread)).toEqual({
      kind: "incompatible",
      reason: "mode-mismatch",
    });
    expect(decideReplicaArtifactBinding("work", { ...thread, active: false })).toMatchObject({
      reason: "thread-inactive",
    });
    expect(decideReplicaArtifactBinding("work", { ...thread, projectActive: false })).toMatchObject(
      { reason: "project-unavailable" },
    );
    expect(
      decideReplicaArtifactBinding("work", { ...thread, workspaceResolved: false }),
    ).toMatchObject({ reason: "workspace-unavailable" });
  });

  it("never takes one into a thread in Plan mode", () => {
    expect(
      decideReplicaArtifactBinding("code", { ...thread, mode: "code", readOnly: true }),
    ).toEqual({ kind: "incompatible", reason: "read-only" });
  });
});

describe("merging two versions' blocks", () => {
  const text = (blockId: string, value: string) =>
    ({ blockId, schemaVersion: 1, kind: "rich-text", text: value }) as never;

  it("keeps every block of both, and both sides of a block they changed differently", () => {
    const merged = mergeReplicaArtifactBlocks(
      { blocks: [text("t1", "Ship Monday"), text("t2", "Owner: Ada")], sourceManifest: [] },
      { blocks: [text("t1", "Ship after beta"), text("t2", "Owner: Ada"), text("t3", "Risks")] },
    );
    expect(merged.omitted).toBe(0);
    expect(merged.blocks.map((block) => [block.blockId, (block as { text: string }).text])).toEqual(
      [
        ["t1", "Ship Monday"],
        ["t2", "Owner: Ada"],
        ["t1-2", "Ship after beta"],
        ["t3", "Risks"],
      ],
    );
  });

  it("leaves out a block that names a source the merged version does not list, and counts it", () => {
    const citation = {
      blockId: "c1",
      schemaVersion: 1,
      kind: "citation",
      sourceId: "77777777-0000-4000-8000-000000000001",
      label: "Spec",
    } as never;
    const merged = mergeReplicaArtifactBlocks(
      { blocks: [text("t1", "Ship")], sourceManifest: [] },
      { blocks: [citation] },
    );
    expect(merged).toEqual({ blocks: [text("t1", "Ship")], omitted: 1 });
  });
});

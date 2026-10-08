import { ARTIFACT_BUNDLE_FORMAT, decodeArtifactBundle } from "@octant/contracts/artifact-bundle";
import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type { HostId } from "@octant/contracts/host";
import {
  REPLICA_ENTRY_FORMAT,
  decodeReplicaArtifactEntry,
  type ReplicaInstanceId,
  type ReplicaSignatureVerdict,
  type ReplicaArtifactEntry,
} from "@octant/contracts/replica-entry";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  reconcileReplicaEntry,
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
    artifact: { canvasId: ids.canvas, hostId },
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
    artifacts: [],
    measuredContentHash: hashA,
    signature: "verified",
    ...overrides,
  };
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
      "append-version" | "already-present" | "concurrent-head" | "tombstone" | "refused"
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

  it("holds a later entry while an earlier sequence is missing", () => {
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
    const afterFirst = noteApplied(state(), first, reconcileReplicaEntry(state(), first));
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

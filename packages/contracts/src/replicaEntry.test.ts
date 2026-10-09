import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BUNDLE_FORMAT,
  decodeArtifactBundle,
  encodeArtifactBundle,
} from "./artifactBundle";
import {
  REPLICA_ENTRY_FORMAT,
  decodeReplicaEntry,
  decodeReplicaArtifactEntry,
  decodeReplicaMembershipEntry,
  decodeReplicaMembershipResult,
  decodeReplicaEntryText,
  encodeReplicaEntry,
  replicaEntryContentPreimage,
  replicaEntryRelativePaths,
  type ReplicaEntry,
  type ReplicaArtifactEntry,
} from "./replicaEntry";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  otherVersion: "33333333-3333-4333-8333-333333333333",
  project: "55555555-5555-4555-8555-555555555555",
  thread: "66666666-6666-4666-8666-666666666666",
  provider: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
  instance: "99999999-9999-4999-8999-999999999999",
} as const;

const hash = "a".repeat(64);
const key = "MCowBQYDK2VwAyEAsI3Vx6E5C70zWN51mv4VIXZxVQC4M1DBS7XoBYp5/R4=";
const origin = (sequence: number) => ({
  instanceId: ids.instance,
  displayName: "North",
  sequence,
  publicKey: key,
});
const now = "2026-08-18T09:00:00.000Z";

function definition(text = "Ship the preview first.") {
  return {
    schemaVersion: 1,
    title: "Launch plan",
    provenance: {
      hostId: "host-north",
      projectId: ids.project,
      actor: { kind: "system", actorId: ids.actor },
      providerInstanceId: ids.provider,
      modelId: "octant-test-model",
      createdAt: now,
      mode: "work",
      threadId: ids.thread,
    },
    sourceManifest: [],
    blocks: [
      { blockId: "h1", schemaVersion: 1, kind: "heading", level: 1, text: "Sequence" },
      { blockId: "t1", schemaVersion: 1, kind: "rich-text", text },
    ],
  };
}

function bundle(text?: string) {
  return decodeArtifactBundle({
    octant: {
      format: ARTIFACT_BUNDLE_FORMAT,
      canvasId: ids.canvas,
      versionId: ids.version,
      sequence: 1,
      title: "Launch plan",
      mode: "work",
      projectId: ids.project,
      hostId: "host-north",
      createdAt: now,
    },
    definition: definition(text),
  });
}

function entry(
  overrides: { readonly kind?: ReplicaEntry["kind"]; readonly text?: string } = {},
): ReplicaArtifactEntry {
  return decodeReplicaArtifactEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: overrides.kind ?? "artifact-version",
    origin: {
      instanceId: ids.instance,
      displayName: "North",
      sequence: 1,
      publicKey: key,
    },
    artifact: {
      canvasId: ids.canvas,
      hostId: "host-north",
      projectName: "Launch",
    },
    parents: [{ versionId: ids.otherVersion }],
    contentHash: hash,
    bundle: bundle(overrides.text),
  });
}

describe("artifact bundle contract", () => {
  it("decodes the bundle the mirror writes and refuses a format it does not know", () => {
    const encoded = encodeArtifactBundle(bundle());
    expect(encoded.endsWith("\n")).toBe(true);
    expect(Object.keys((JSON.parse(encoded) as { octant: object }).octant)).toEqual([
      "format",
      "canvasId",
      "versionId",
      "sequence",
      "title",
      "mode",
      "projectId",
      "hostId",
      "createdAt",
    ]);
    expect(decodeArtifactBundle(JSON.parse(encoded))).toEqual(bundle());
    expect(() =>
      decodeArtifactBundle({
        octant: { format: "octant.artifact-bundle/9" },
        definition: {},
      }),
    ).toThrow();
  });

  it("refuses an entry whose origin does not carry its writer's key", () => {
    expect(() =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-request",
        origin: { instanceId: ids.instance, displayName: "North", sequence: 1 },
        requestedAt: 1,
      }),
    ).toThrow();
  });

  it("holds a founding record and a join request to sequence 1, and an accept to a later one", () => {
    expect(() =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "replica-founded",
        origin: origin(2),
      }),
    ).toThrow();
    expect(() =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-request",
        origin: origin(2),
        requestedAt: 1,
      }),
    ).toThrow();
    const accept = {
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-accepted",
      approver: ids.otherVersion,
      approvalSequence: 2,
      approvalHash: hash,
      founder: ids.otherVersion,
    } as const;
    expect(() => decodeReplicaMembershipEntry({ ...accept, origin: origin(1) })).toThrow();
    expect(decodeReplicaMembershipEntry({ ...accept, origin: origin(2) }).kind).toBe(
      "join-accepted",
    );
  });

  it("refuses a join request that does not say when it was written", () => {
    expect(() =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-request",
        origin: origin(1),
      }),
    ).toThrow();
  });

  it("refuses an approval that does not carry the approved device key", () => {
    expect(() =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-approved",
        origin: origin(2),
        subject: ids.otherVersion,
        subjectName: "South",
      }),
    ).toThrow();
  });

  it("refuses a field another kind defines", () => {
    expect(() =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "revocation",
        origin: origin(3),
        subject: ids.otherVersion,
        cut: 1,
        requestedAt: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-approved",
        origin: origin(3),
        subject: ids.otherVersion,
        subjectKey: key,
        subjectName: "South",
        cut: 1,
      }),
    ).toThrow();
  });

  it("requires a revocation to name its cut, and signs it", () => {
    const fields = {
      format: REPLICA_ENTRY_FORMAT,
      kind: "revocation",
      origin: origin(3),
      subject: ids.otherVersion,
    } as const;
    expect(() => decodeReplicaMembershipEntry(fields)).toThrow();
    const revocation = decodeReplicaMembershipEntry({ ...fields, cut: 4 });
    const encoded = JSON.parse(encodeReplicaEntry(revocation)) as Record<string, unknown>;
    expect(encoded.cut).toBe(4);
    expect(Object.keys(encoded)).toEqual(["format", "kind", "origin", "subject", "cut"]);
  });
});

describe("replica entry contract", () => {
  it("round-trips an entry as readable JSON with a fixed key order", () => {
    const encoded = encodeReplicaEntry(entry());
    const parsed = JSON.parse(encoded) as {
      origin: object;
      artifact: object;
      bundle: { octant: object };
    };

    expect(encoded.endsWith("\n")).toBe(true);
    expect(Object.keys(parsed)).toEqual([
      "format",
      "kind",
      "origin",
      "artifact",
      "parents",
      "contentHash",
      "bundle",
    ]);
    expect(Object.keys(parsed.origin)).toEqual([
      "instanceId",
      "displayName",
      "sequence",
      "publicKey",
    ]);
    expect(Object.keys(parsed.artifact)).toEqual(["canvasId", "hostId", "projectName"]);
    expect(Object.keys(parsed.bundle.octant)).toEqual([
      "format",
      "canvasId",
      "versionId",
      "sequence",
      "title",
      "mode",
      "projectId",
      "hostId",
      "createdAt",
    ]);
    expect(decodeReplicaEntryText(encoded)).toEqual(entry());
    expect(encodeReplicaEntry(decodeReplicaEntryText(encoded))).toBe(encoded);
  });

  it("changes one line when the bundle changes one sentence", () => {
    const before = encodeReplicaEntry(entry());
    const after = encodeReplicaEntry(entry({ text: "Ship the gallery first." }));
    const changed = after.split("\n").filter((line, index) => line !== before.split("\n")[index]);
    expect(changed).toHaveLength(1);
  });

  it("refuses an entry whose format it does not know", () => {
    const parsed = JSON.parse(encodeReplicaEntry(entry())) as { format: string };
    parsed.format = "octant.replica-entry/9";
    expect(() => decodeReplicaEntry(parsed)).toThrow();
    expect(() => decodeReplicaEntryText("{")).toThrow();
    expect(() =>
      decodeReplicaEntry({ ...JSON.parse(encodeReplicaEntry(entry())), secret: "no" }),
    ).toThrow();
  });

  it("names the write-once entry beside its detached signature", () => {
    expect(replicaEntryRelativePaths(entry().origin.instanceId, 3)).toEqual({
      entry: `${ids.instance}/3.json`,
      signature: `${ids.instance}/3.sig`,
    });
  });

  it("hashes the canonical bundle, not a second document", () => {
    const value: ReplicaArtifactEntry = entry();
    expect(replicaEntryContentPreimage(value)).toBe(encodeArtifactBundle(value.bundle));
    expect(value.bundle.octant.format).toBe(ARTIFACT_BUNDLE_FORMAT);
  });

  it("signs the whole entry, not just its bundle", () => {
    const base = encodeReplicaEntry(entry());
    expect(base).not.toBe(encodeReplicaEntry(entry({ text: "A different bundle." })));
    const moved = JSON.parse(base) as { origin: { sequence: number } };
    const sameBodyOtherSequence = decodeReplicaEntry({
      ...JSON.parse(base),
      origin: { ...moved.origin, sequence: 2 },
    });
    expect(encodeReplicaEntry(sameBodyOtherSequence)).not.toBe(base);
    const grafted = decodeReplicaEntry({
      ...JSON.parse(base),
      parents: [{ versionId: "44444444-4444-4444-8444-444444444444" }],
    });
    expect(encodeReplicaEntry(grafted)).not.toBe(base);
  });

  it("round-trips every membership record the same way, with the writer's key in its origin", () => {
    const records = [
      { format: REPLICA_ENTRY_FORMAT, kind: "replica-founded", origin: origin(1) },
      { format: REPLICA_ENTRY_FORMAT, kind: "join-request", origin: origin(1), requestedAt: 1 },
      {
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-approved",
        origin: origin(2),
        subject: ids.otherVersion,
        subjectKey: key,
        subjectName: "South",
      },
      {
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-accepted",
        origin: origin(2),
        approver: ids.otherVersion,
        approvalSequence: 3,
        approvalHash: hash,
        founder: ids.otherVersion,
      },
    ];
    for (const record of records) {
      const decoded = decodeReplicaMembershipEntry(record);
      const encoded = encodeReplicaEntry(decoded);
      expect(Object.keys(JSON.parse(encoded) as Record<string, unknown>)).toEqual(
        Object.keys(record),
      );
      expect(Object.keys((JSON.parse(encoded) as { origin: object }).origin)).toEqual([
        "instanceId",
        "displayName",
        "sequence",
        "publicKey",
      ]);
      expect(decodeReplicaEntryText(encoded)).toEqual(decoded);
    }
  });

  it("refuses an entry written in the first format", () => {
    const encoded = JSON.parse(encodeReplicaEntry(entry())) as Record<string, unknown>;
    expect(() =>
      decodeReplicaEntryText(JSON.stringify({ ...encoded, format: "octant.replica-entry/1" })),
    ).toThrow();
  });
});

describe("replica membership results", () => {
  const revocation = (subject: string, sequence: number) => ({
    format: REPLICA_ENTRY_FORMAT,
    kind: "revocation",
    origin: origin(sequence),
    subject,
    cut: 2,
  });

  it("names the computers a revoke left unrevoked, and refuses a partial revoke that names none", () => {
    const partial = {
      kind: "revoked-in-part",
      subject: ids.version,
      entry: revocation(ids.version, 3),
      alsoRevoked: [],
      notRevoked: [ids.otherVersion],
      message: "The replica store did not take the entry.",
      readStore: true,
    };
    expect(decodeReplicaMembershipResult(partial)).toMatchObject({
      kind: "revoked-in-part",
      notRevoked: [ids.otherVersion],
    });
    expect(() => decodeReplicaMembershipResult({ ...partial, notRevoked: [] })).toThrow();
  });

  it("carries the revocations a preview's subject already wrote, each at its sequence", () => {
    const preview = {
      kind: "revoke-preview",
      subject: ids.version,
      cut: 4,
      broughtIn: [],
      subjectRevocations: [{ sequence: 3, subject: ids.otherVersion, cut: 2 }],
      readStore: true,
    };
    expect(decodeReplicaMembershipResult(preview)).toMatchObject(preview);
    expect(() =>
      decodeReplicaMembershipResult({ ...preview, subjectRevocations: undefined }),
    ).toThrow();
  });
});

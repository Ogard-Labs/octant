import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BUNDLE_FORMAT,
  decodeArtifactBundle,
  encodeArtifactBundle,
} from "./artifactBundle";
import {
  REPLICA_ENTRY_FORMAT,
  decodeReplicaEntry,
  decodeReplicaEntryText,
  encodeReplicaEntry,
  replicaEntryContentPreimage,
  replicaEntryRelativePaths,
  type ReplicaEntry,
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
): ReplicaEntry {
  return decodeReplicaEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: overrides.kind ?? "artifact-version",
    origin: {
      instanceId: ids.instance,
      displayName: "North",
      sequence: 1,
    },
    artifact: {
      canvasId: ids.canvas,
      hostId: "host-north",
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
    expect(Object.keys(parsed.origin)).toEqual(["instanceId", "displayName", "sequence"]);
    expect(Object.keys(parsed.artifact)).toEqual(["canvasId", "hostId"]);
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
    const value = entry();
    expect(replicaEntryContentPreimage(value)).toBe(encodeArtifactBundle(value.bundle));
    expect(value.bundle.octant.format).toBe(ARTIFACT_BUNDLE_FORMAT);
  });
});

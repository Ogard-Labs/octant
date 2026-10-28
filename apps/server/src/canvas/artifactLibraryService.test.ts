import type { CanvasVersion } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { ClientPrincipal } from "../clientPrincipal";
import {
  ArtifactLibraryService,
  type ArtifactLibraryProjectRecord,
} from "./artifactLibraryService";

const localWindow: ClientPrincipal = {
  kind: "local-window",
  windowId: "40000000-0000-4000-8000-000000000001",
  capabilityGeneration: 0,
};
const pairedDevice = {
  kind: "remote-device",
  hostId: "host-1",
  deviceId: "device-1",
  credentialGeneration: 1,
  origin: "https://phone.test",
  protocolVersion: 1,
  capabilityDigest: "a".repeat(64),
  sessionId: "session-1",
} as unknown as ClientPrincipal;

const projects: ReadonlyArray<ArtifactLibraryProjectRecord> = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Storefront",
    type: "work",
    lifecycle: "active",
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    name: "Old ideas",
    type: "chat",
    lifecycle: "archived",
  },
] as unknown as ReadonlyArray<ArtifactLibraryProjectRecord>;

function version(overrides: {
  readonly canvasId: string;
  readonly projectId: string | null;
  readonly mode: "chat" | "work" | "code";
  readonly title: string;
}): CanvasVersion {
  return {
    schemaVersion: 1,
    canvasId: overrides.canvasId,
    versionId: "30000000-0000-4000-8000-000000000001",
    sequence: 1,
    definition: {
      schemaVersion: 1,
      title: overrides.title,
      provenance: {
        hostId: "host-1",
        projectId: overrides.projectId,
        actor: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
        providerInstanceId: "60000000-0000-4000-8000-000000000001",
        modelId: "model-a",
        createdAt: "2026-08-18T09:00:00.000Z",
        mode: overrides.mode,
        threadId: "70000000-0000-4000-8000-000000000001",
      },
      sourceManifest: { sources: [] },
      blocks: [{ blockId: "diagram-1", schemaVersion: 1, kind: "diagram", nodes: [], edges: [] }],
    },
    createdBy: { kind: "system", actorId: "50000000-0000-4000-8000-000000000001" },
    createdAt: "2026-08-18T09:00:00.000Z",
  } as unknown as CanvasVersion;
}

const syncedFromStudio = {
  canvasId: "10000000-0000-4000-8000-00000000000c",
  projectName: "Launch",
  computerName: "Studio Mac",
  mode: "work",
  kind: "document",
  title: "Pricing notes",
  versionCount: 2,
  headCount: 2,
  status: "two-versions",
  updatedAt: "2026-08-18T08:00:00.000Z",
} as const;

function library(
  options: {
    readonly liveShares?: ReadonlySet<string>;
    readonly synced?: ReadonlyArray<unknown>;
    readonly tags?: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly threadHoldsCanvas?: boolean;
  } = {},
) {
  const entries = [
    {
      canvasId: "10000000-0000-4000-8000-00000000000a",
      currentVersion: version({
        canvasId: "10000000-0000-4000-8000-00000000000a",
        projectId: "20000000-0000-4000-8000-000000000001",
        mode: "work",
        title: "Launch plan",
      }),
      versions: [],
      versionCount: 3,
      updatedAt: "2026-08-18T09:00:00.000Z",
    },
    {
      canvasId: "10000000-0000-4000-8000-00000000000b",
      currentVersion: version({
        canvasId: "10000000-0000-4000-8000-00000000000b",
        projectId: "20000000-0000-4000-8000-000000000002",
        mode: "chat",
        title: "Old sketch",
      }),
      versions: [],
      versionCount: 1,
      updatedAt: "2026-08-17T09:00:00.000Z",
    },
    ...(options.threadHoldsCanvas === undefined
      ? []
      : [
          {
            canvasId: "10000000-0000-4000-8000-00000000000e",
            currentVersion: version({
              canvasId: "10000000-0000-4000-8000-00000000000e",
              projectId: null,
              mode: "chat",
              title: "Trip notes",
            }),
            versions: [],
            versionCount: 1,
            updatedAt: "2026-08-16T09:00:00.000Z",
          },
        ]),
  ];
  return new ArtifactLibraryService({
    projection: {
      snapshot: () => new Map(entries.map((entry) => [entry.canvasId, entry])) as never,
    },
    projects: () => projects,
    liveShares: () => options.liveShares ?? new Set<string>(),
    ...(options.synced === undefined ? {} : { synced: () => options.synced as never }),
    ...(options.tags === undefined
      ? {}
      : { tags: (canvasId: string) => options.tags?.[canvasId] ?? [] }),
    ...(options.threadHoldsCanvas === undefined
      ? {}
      : { threadHoldsCanvas: () => options.threadHoldsCanvas === true }),
    clock: () => "2026-08-18T10:00:00.000Z" as never,
  });
}

describe("reading the host's artifact library", () => {
  it("gathers artifacts from every Project on this host, newest first", () => {
    const listing = library().list({ tab: "all" } as never, localWindow);

    expect(listing.entries.map((entry) => entry.title)).toEqual(["Launch plan", "Old sketch"]);
    expect(listing.projects.map((project) => project.name)).toEqual(["Old ideas", "Storefront"]);
    expect(listing.matchCount).toBe(2);
    expect(listing.truncated).toBe(false);
  });

  it("names each artifact's Project rather than leaving the caller an id", () => {
    const listing = library().list({ tab: "all" } as never, localWindow);

    expect(listing.entries[0]?.projectName).toBe("Storefront");
  });

  it("draws a preview the caller can render without fetching anything", () => {
    const preview = library().list({ tab: "all" } as never, localWindow).entries[0]?.preview;

    expect(preview?.format).toBe("svg");
    expect(preview?.markup.startsWith("<svg")).toBe(true);
  });

  it("hides an archived Project's artifacts from a paired device and keeps them locally", () => {
    const local = library().list({ tab: "all" } as never, localWindow);
    const remote = library().list({ tab: "all" } as never, pairedDevice);

    expect(local.entries.map((entry) => entry.title)).toContain("Old sketch");
    expect(remote.entries.map((entry) => entry.title)).not.toContain("Old sketch");
    // The Project is absent entirely, so the listing does not disclose that it
    // exists by offering it as a filter with nothing in it.
    expect(remote.projects.map((project) => project.name)).toEqual(["Storefront"]);
  });

  it("counts only the artifacts the caller may see", () => {
    expect(library().list({ tab: "all" } as never, pairedDevice).matchCount).toBe(1);
  });

  it("lists an artifact under Shared exactly while a share of it is live", () => {
    const shared = library({
      liveShares: new Set(["10000000-0000-4000-8000-00000000000a"]),
    });

    expect(shared.list({ tab: "shared" } as never, localWindow).entries).toHaveLength(1);
    expect(library().list({ tab: "shared" } as never, localWindow).entries).toEqual([]);
  });

  it("applies the query the caller sent rather than returning everything", () => {
    const listing = library().list({ tab: "all", query: "sketch" } as never, localWindow);

    expect(listing.entries.map((entry) => entry.title)).toEqual(["Old sketch"]);
    expect(listing.matchCount).toBe(1);
  });

  it("lists artifacts synced from another computer by that computer's name, on this host only", () => {
    const alreadyHere = { ...syncedFromStudio, canvasId: "10000000-0000-4000-8000-00000000000a" };
    const synced = library({ synced: [syncedFromStudio, alreadyHere] });

    const local = synced.list({ tab: "all" } as never, localWindow);
    expect(local.synced).toEqual([syncedFromStudio]);
    // It is not one of this host's Project artifacts, so it is not a card
    // that opens a local Canvas.
    expect(local.entries.map((entry) => entry.title)).not.toContain("Pricing notes");
    expect(synced.list({ tab: "all" } as never, pairedDevice).synced).toBeUndefined();
    // The query applies to them too.
    expect(synced.list({ tab: "shared" } as never, localWindow).synced).toBeUndefined();
    expect(
      synced.list({ tab: "all", query: "budget" } as never, localWindow).synced,
    ).toBeUndefined();
  });

  it("lists a Canvas a Chat thread owns under no Project, for a window on this host only", () => {
    const withThreadOwned = library({ threadHoldsCanvas: true });

    const local = withThreadOwned.list({ tab: "all" } as never, localWindow);
    const trip = local.entries.find((entry) => entry.title === "Trip notes");
    expect(trip?.projectId).toBeUndefined();
    expect(trip?.projectName).toBeUndefined();
    // A paired device has no Project to be clamped to, so it sees nothing of
    // a Canvas that belongs to a thread on this host.
    expect(withThreadOwned.list({ tab: "all" } as never, pairedDevice).entries).not.toContainEqual(
      expect.objectContaining({ title: "Trip notes" }),
    );
  });

  it("leaves out a thread-owned Canvas whose thread no longer holds it", () => {
    expect(
      library({ threadHoldsCanvas: false })
        .list({ tab: "all" } as never, localWindow)
        .entries.map((entry) => entry.title),
    ).not.toContain("Trip notes");
  });

  it("does not file a thread-owned Canvas under any Project filter", () => {
    const listing = library({ threadHoldsCanvas: true }).list(
      { tab: "all", projectId: "20000000-0000-4000-8000-000000000001" } as never,
      localWindow,
    );

    expect(listing.entries.map((entry) => entry.title)).toEqual(["Launch plan"]);
  });

  it("carries the person's tags and answers a tag query from the host", () => {
    const tagged = library({
      tags: { "10000000-0000-4000-8000-00000000000a": ["Launch"] },
    });

    const listing = tagged.list({ tab: "all" } as never, localWindow);
    expect(listing.entries[0]?.tags).toEqual(["Launch"]);
    expect(listing.tags).toEqual([{ name: "Launch", artifactCount: 1 }]);
    expect(listing.entries[1]?.tags).toBeUndefined();

    const filtered = tagged.list({ tab: "all", tag: "Launch" } as never, localWindow);
    expect(filtered.entries.map((entry) => entry.title)).toEqual(["Launch plan"]);

    // An artifact with no tags is never a match for a tag filter, and a tag
    // nobody carries answers with nothing rather than an empty roster.
    expect(tagged.list({ tab: "all", tag: "Absent" } as never, localWindow).entries).toEqual([]);
  });

  it("offers no tag roster when nothing carries a tag", () => {
    expect(library().list({ tab: "all" } as never, localWindow).tags).toBeUndefined();
  });
});

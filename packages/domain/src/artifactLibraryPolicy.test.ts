import type {
  ArtifactLibraryEntry,
  ArtifactLibraryQuery,
} from "@octant/contracts/artifact-library";
import { describe, expect, it } from "vitest";
import {
  artifactEditedAgo,
  artifactKindForBlocks,
  selectArtifactLibraryEntries,
} from "./artifactLibraryPolicy";

function entry(overrides: Partial<ArtifactLibraryEntry>): ArtifactLibraryEntry {
  return {
    canvasId: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    projectName: "Storefront",
    mode: "work",
    kind: "document",
    title: "Launch plan",
    versionCount: 2,
    currentVersionId: "30000000-0000-4000-8000-000000000001",
    currentSequence: 2,
    updatedAt: "2026-08-18T09:00:00.000Z",
    shared: false,
    ...overrides,
  } as ArtifactLibraryEntry;
}

function query(overrides: Partial<ArtifactLibraryQuery> = {}): ArtifactLibraryQuery {
  return { tab: "all", ...overrides } as ArtifactLibraryQuery;
}

describe("reading what an artifact is", () => {
  it("calls a page of diagrams a diagram", () => {
    expect(artifactKindForBlocks([{ kind: "heading" }, { kind: "diagram" }])).toBe("diagram");
  });

  it("calls a page of prose with one diagram in it a document", () => {
    expect(
      artifactKindForBlocks([
        { kind: "rich-text" },
        { kind: "rich-text" },
        { kind: "callout" },
        { kind: "diagram" },
      ]),
    ).toBe("document");
  });

  it("refuses to pick a character when two are evenly matched", () => {
    expect(
      artifactKindForBlocks([
        { kind: "chart" },
        { kind: "chart" },
        { kind: "table" },
        { kind: "table" },
      ]),
    ).toBe("mixed");
  });

  it("treats a page of headings and links as a document rather than as nothing", () => {
    expect(
      artifactKindForBlocks([{ kind: "heading" }, { kind: "link" }, { kind: "divider" }]),
    ).toBe("document");
  });
});

describe("selecting the artifacts a library query asks for", () => {
  const entries = [
    entry({ canvasId: "10000000-0000-4000-8000-00000000000a" as never, title: "Launch plan" }),
    entry({
      canvasId: "10000000-0000-4000-8000-00000000000b" as never,
      title: "Schema map",
      kind: "diagram",
      mode: "code",
      projectId: "20000000-0000-4000-8000-000000000002" as never,
      projectName: "Octant",
      shared: true,
      updatedAt: "2026-08-18T10:00:00.000Z" as never,
    }),
  ] as ReadonlyArray<ArtifactLibraryEntry>;

  it("lists the most recently edited artifact first", () => {
    expect(selectArtifactLibraryEntries(entries, query()).map((found) => found.title)).toEqual([
      "Schema map",
      "Launch plan",
    ]);
  });

  it("shows a shared artifact in All as well as in Shared", () => {
    expect(selectArtifactLibraryEntries(entries, query({ tab: "shared" }))).toHaveLength(1);
    expect(selectArtifactLibraryEntries(entries, query({ tab: "all" }))).toHaveLength(2);
  });

  it("finds an artifact by the Project it was made in, not only by its title", () => {
    expect(
      selectArtifactLibraryEntries(entries, query({ query: "octant" })).map((found) => found.title),
    ).toEqual(["Schema map"]);
  });

  it("narrows by kind and by mode independently", () => {
    expect(selectArtifactLibraryEntries(entries, query({ kind: "diagram" }))).toHaveLength(1);
    expect(selectArtifactLibraryEntries(entries, query({ mode: "work" }))).toHaveLength(1);
    expect(selectArtifactLibraryEntries(entries, query({ kind: "diagram", mode: "work" }))).toEqual(
      [],
    );
  });

  it("keeps the order stable when two artifacts were edited in the same instant", () => {
    const sameInstant = [
      entry({ canvasId: "10000000-0000-4000-8000-00000000000d" as never, title: "Zeta" }),
      entry({ canvasId: "10000000-0000-4000-8000-00000000000c" as never, title: "Alpha" }),
    ] as ReadonlyArray<ArtifactLibraryEntry>;

    expect(selectArtifactLibraryEntries(sameInstant, query()).map((found) => found.title)).toEqual([
      "Alpha",
      "Zeta",
    ]);
  });
});

describe("saying how long ago an artifact was edited", () => {
  it.each([
    ["2026-08-18T08:59:40.000Z", "Edited just now"],
    ["2026-08-18T08:45:00.000Z", "Edited 15 minutes ago"],
    ["2026-08-18T06:00:00.000Z", "Edited 3 hours ago"],
    ["2026-08-15T09:00:00.000Z", "Edited 3 days ago"],
    ["2026-06-18T09:00:00.000Z", "Edited 2 months ago"],
    ["2024-08-18T09:00:00.000Z", "Edited 2 years ago"],
  ])("describes %s as %s", (updatedAt, expected) => {
    expect(artifactEditedAgo(updatedAt, "2026-08-18T09:00:00.000Z")).toBe(expected);
  });
});

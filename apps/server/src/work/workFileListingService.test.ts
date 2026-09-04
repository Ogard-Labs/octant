import { decodeProjectId } from "@octant/contracts/projects";
import { decodeWorkThreadId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { WorkArtifactEntry } from "./workArtifactProjection";
import { workFilesystemFixture, type WorkFilesystemFixture } from "./workFilesystemFixture";
import { WorkFileListingService } from "./workFileListingService";

const projectId = decodeProjectId("00000000-0000-4000-8000-0000000009a1");
const threadId = decodeWorkThreadId("00000000-0000-4000-8000-0000000007a1");
const root = "/work";

const encoder = new TextEncoder();

function artifact(overrides: Partial<WorkArtifactEntry> & { relativePath: string }) {
  return {
    artifactId: "00000000-0000-4000-8000-0000000005a1",
    projectId,
    format: "markdown",
    artifactRef: "ref",
    displayName: overrides.relativePath,
    sequence: 1,
    currentSourceVersion: {
      contentSha256: "a".repeat(64),
      byteSize: 1,
      observedAt: "2026-09-04T10:00:00.000Z",
    },
    deleted: false,
    lastMutation: "created",
    ...overrides,
  } as WorkArtifactEntry;
}

async function seed(filesystem: WorkFilesystemFixture, paths: ReadonlyArray<string>) {
  for (const path of paths) {
    const directory = path.split("/").slice(0, -1).join("/");
    if (directory !== "" && directory !== root)
      await filesystem.mkdir(directory, { recursive: true });
    await filesystem.writeFile(path, encoder.encode("x"));
  }
}

function service(
  filesystem: WorkFilesystemFixture,
  artifacts: ReadonlyArray<WorkArtifactEntry> = [],
  options: { readonly maxEntries?: number; readonly maxDepth?: number } = {},
) {
  return new WorkFileListingService({
    filesystem,
    artifactsForProject: () => artifacts,
    clock: () => "2026-09-04T10:00:00.000Z",
    ...options,
  });
}

describe("WorkFileListingService", () => {
  it("lists the whole bound folder with the files Work wrote first", async () => {
    const filesystem = workFilesystemFixture(root);
    await seed(filesystem, [
      `${root}/agenda.txt`,
      `${root}/summary.md`,
      `${root}/research/interview.txt`,
    ]);

    const result = await service(filesystem, [artifact({ relativePath: "summary.md" })]).list({
      threadId,
      projectId,
      rootPath: root,
    });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual([
      "summary.md",
      "agenda.txt",
      "research",
      "research/interview.txt",
    ]);
    const summary = result.listing.entries[0];
    expect(summary).toMatchObject({
      kind: "file",
      origin: "authored",
      artifact: { format: "markdown", sequence: 1 },
    });
    expect(result.listing.entries[1]).toMatchObject({ kind: "file", origin: "untouched" });
    expect(result.listing.truncated).toBe(false);
  });

  it("refuses to report a file a symlink points at outside the bound folder", async () => {
    const filesystem = workFilesystemFixture(root);
    await seed(filesystem, [`${root}/agenda.txt`, "/elsewhere/secrets.txt"]);
    filesystem.putSymlink(`${root}/escape.txt`, "/elsewhere/secrets.txt");

    const result = await service(filesystem).list({ threadId, projectId, rootPath: root });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["agenda.txt"]);
  });

  it("says the listing is incomplete rather than presenting a partial walk as the folder", async () => {
    const filesystem = workFilesystemFixture(root);
    await seed(filesystem, [`${root}/a.txt`, `${root}/b.txt`, `${root}/c.txt`]);

    const result = await service(filesystem, [], { maxEntries: 2 }).list({
      threadId,
      projectId,
      rootPath: root,
    });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries).toHaveLength(2);
    expect(result.listing.truncated).toBe(true);
  });

  it("keeps hidden platform entries out of a folder listing", async () => {
    const filesystem = workFilesystemFixture(root);
    await seed(filesystem, [`${root}/.DS_Store`, `${root}/agenda.txt`]);

    const result = await service(filesystem).list({ threadId, projectId, rootPath: root });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["agenda.txt"]);
  });

  it("does not claim Work wrote a file whose artifact was deleted", async () => {
    const filesystem = workFilesystemFixture(root);
    await seed(filesystem, [`${root}/summary.md`]);

    const result = await service(filesystem, [
      artifact({ relativePath: "summary.md", deleted: true }),
    ]).list({ threadId, projectId, rootPath: root });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries[0]).toMatchObject({ origin: "untouched" });
    expect(result.listing.entries[0]).not.toHaveProperty("artifact");
  });

  it("refuses a directory outside the bound folder", async () => {
    const filesystem = workFilesystemFixture(root);
    await seed(filesystem, [`${root}/agenda.txt`]);

    const result = await service(filesystem).list({
      threadId,
      projectId,
      rootPath: root,
      directory: "../elsewhere",
    });

    expect(result).toMatchObject({ status: "failed", failure: { category: "invalid" } });
  });
});

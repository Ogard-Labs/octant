import type { ArtifactMirrorSettings } from "@octant/contracts/artifact-mirror";
import { describe, expect, it } from "vitest";
import {
  artifactBundlePaths,
  decideArtifactReimport,
  decideMirrorWrite,
  mirrorRefusalText,
  reimportRefusalText,
  resolveArtifactDestination,
  type MirrorWriteFacts,
  type ReimportFacts,
} from "./artifactMirrorPolicy";

const projectA = "20000000-0000-4000-8000-000000000001";
const projectB = "20000000-0000-4000-8000-000000000002";
const canvasId = "1a2b3c4d-0000-4000-8000-000000000001";

function settings(
  overrides: Partial<Pick<ArtifactMirrorSettings, "fallback" | "overrides">> = {},
): Pick<ArtifactMirrorSettings, "fallback" | "overrides"> {
  return {
    fallback: { kind: "internal-only" },
    overrides: [],
    ...overrides,
  } as Pick<ArtifactMirrorSettings, "fallback" | "overrides">;
}

function writeFacts(overrides: Partial<MirrorWriteFacts> = {}): MirrorWriteFacts {
  return {
    destination: { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" },
    destinationRootResolved: true,
    projectBindsRepository: true,
    outsideRootApproved: true,
    planMode: false,
    ...overrides,
  };
}

function reimportFacts(overrides: Partial<ReimportFacts> = {}): ReimportFacts {
  return {
    canvasId,
    currentVersionId: "30000000-0000-4000-8000-000000000001",
    expectedVersionId: "30000000-0000-4000-8000-000000000001",
    file: { status: "read", bundleForCanvasId: canvasId, changed: true },
    ...overrides,
  };
}

describe("choosing where an artifact's files go", () => {
  it("writes nothing at all by default", () => {
    expect(resolveArtifactDestination(settings(), projectA)).toEqual({ kind: "internal-only" });
    expect(
      artifactBundlePaths(
        { canvasId, title: "Launch plan", mode: "work", projectName: "Storefront" },
        { kind: "internal-only" },
      ),
    ).toBeUndefined();
  });

  it("lets a Project override the host-wide choice, and leaves other Projects alone", () => {
    const configured = settings({
      fallback: { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" },
      overrides: [
        {
          projectId: projectA,
          destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
        },
      ],
    } as never);

    expect(resolveArtifactDestination(configured, projectA)).toEqual({
      kind: "project-repository",
      relativeDirectory: "docs/artifacts",
    });
    expect(resolveArtifactDestination(configured, projectB)).toEqual({
      kind: "global-folder",
      canonicalRoot: "/Users/me/Artifacts",
    });
  });

  it("groups a global folder by Project and leaves a repository folder as chosen", () => {
    const naming = {
      canvasId,
      title: "Launch plan",
      mode: "work" as const,
      projectName: "Store Front",
    };

    expect(
      artifactBundlePaths(naming, { kind: "global-folder", canonicalRoot: "/Users/me/Artifacts" }),
    ).toEqual({
      directory: "store-front",
      bundle: "store-front/launch-plan-1a2b3c4d.octant.json",
      sidecars: [
        { path: "store-front/launch-plan-1a2b3c4d.md", format: "md" },
        { path: "store-front/launch-plan-1a2b3c4d.svg", format: "svg" },
      ],
    });
    expect(
      artifactBundlePaths(naming, {
        kind: "project-repository",
        relativeDirectory: "docs/artifacts",
      })?.bundle,
    ).toBe("docs/artifacts/launch-plan-1a2b3c4d.octant.json");
  });

  it("keeps two artifacts with the same title in separate files", () => {
    const first = artifactBundlePaths(
      { canvasId, title: "Notes", mode: "chat", projectName: "P" },
      { kind: "global-folder", canonicalRoot: "/x" },
    );
    const second = artifactBundlePaths(
      {
        canvasId: "9f8e7d6c-0000-4000-8000-000000000002",
        title: "Notes",
        mode: "chat",
        projectName: "P",
      },
      { kind: "global-folder", canonicalRoot: "/x" },
    );

    expect(first?.bundle).not.toBe(second?.bundle);
  });

  it("gives a nameless artifact a usable filename rather than an empty one", () => {
    expect(
      artifactBundlePaths(
        { canvasId, title: "★ ☆ ★", mode: "chat", projectName: "···" },
        { kind: "global-folder", canonicalRoot: "/x" },
      ),
    ).toMatchObject({ directory: "project", bundle: "project/artifact-1a2b3c4d.octant.json" });
  });
});

describe("deciding whether a revision may be materialized", () => {
  it("skips rather than fails when nothing was asked for", () => {
    expect(decideMirrorWrite(writeFacts({ destination: { kind: "internal-only" } }))).toEqual({
      decision: "skip",
    });
  });

  it("writes when the destination is resolved and approved", () => {
    expect(decideMirrorWrite(writeFacts())).toEqual({ decision: "write" });
  });

  it("refuses to write files in Plan mode", () => {
    expect(decideMirrorWrite(writeFacts({ planMode: true }))).toEqual({
      decision: "refuse",
      reason: "plan-mode-is-read-only",
    });
  });

  it("refuses a folder outside a bound root until that is approved", () => {
    expect(decideMirrorWrite(writeFacts({ outsideRootApproved: false }))).toEqual({
      decision: "refuse",
      reason: "destination-unauthorized",
    });
  });

  it("needs no second grant to write inside the repository the Project already bound", () => {
    expect(
      decideMirrorWrite(
        writeFacts({
          destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
          outsideRootApproved: false,
        }),
      ),
    ).toEqual({ decision: "write" });
  });

  it("refuses a repository destination in a Project that binds none", () => {
    expect(
      decideMirrorWrite(
        writeFacts({
          destination: { kind: "project-repository", relativeDirectory: "docs/artifacts" },
          projectBindsRepository: false,
        }),
      ),
    ).toEqual({ decision: "refuse", reason: "project-not-bound" });
  });

  it("says why in words the user can act on", () => {
    expect(mirrorRefusalText("destination-unauthorized")).toContain("approved");
    expect(reimportRefusalText("file-unchanged")).toContain("nothing to import");
  });
});

describe("taking an edited file back in", () => {
  it("appends a version and can express no other outcome", () => {
    expect(decideArtifactReimport(reimportFacts())).toEqual({ decision: "append-version" });
  });

  it("refuses when the artifact moved since the caller looked", () => {
    expect(
      decideArtifactReimport(
        reimportFacts({ currentVersionId: "30000000-0000-4000-8000-00000000000f" }),
      ),
    ).toEqual({ decision: "refuse", reason: "stale-version" });
  });

  it("refuses a bundle that belongs to another artifact", () => {
    expect(
      decideArtifactReimport(
        reimportFacts({
          file: {
            status: "read",
            bundleForCanvasId: "aaaaaaaa-0000-4000-8000-000000000009",
            changed: true,
          },
        }),
      ),
    ).toEqual({ decision: "refuse", reason: "file-not-a-bundle" });
  });

  it("refuses a file that is not a bundle at all", () => {
    expect(
      decideArtifactReimport(
        reimportFacts({ file: { status: "read", bundleForCanvasId: undefined, changed: true } }),
      ),
    ).toEqual({ decision: "refuse", reason: "file-not-a-bundle" });
  });

  it("does nothing when the file already matches the current version", () => {
    expect(
      decideArtifactReimport(
        reimportFacts({ file: { status: "read", bundleForCanvasId: canvasId, changed: false } }),
      ),
    ).toEqual({ decision: "refuse", reason: "file-unchanged" });
  });

  it.each(["missing", "unreadable"] as const)("refuses a %s file", (status) => {
    expect(decideArtifactReimport(reimportFacts({ file: { status } }))).toMatchObject({
      decision: "refuse",
    });
  });
});

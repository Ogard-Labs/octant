import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decidePreviewRelease,
  gitPeelTagToCommitArgv,
  githubOutputLines,
  githubReleaseListArgv,
  parseGitHubReleaseListJson,
  resolveGitTagCommit,
  type ListedGitHubRelease,
} from "./decide-preview-release";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PREVIOUS = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TAG_OBJECT = "cccccccccccccccccccccccccccccccccccccccc";

const publishedPreview: ListedGitHubRelease = {
  tagName: "v0.1.0-preview.20260908.12",
  isPrerelease: true,
  isDraft: false,
};

function neverResolve(): Promise<string> {
  throw new Error("a tag should not be resolved when there is no published preview");
}

describe("deciding whether to build a preview release", () => {
  it("builds when there is no previous published preview", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [],
      resolveTagCommit: neverResolve,
    });

    expect(decision).toEqual({ kind: "build", reason: "no-previous-preview" });
    expect(githubOutputLines(decision)).toEqual(["build=true"]);
  });

  it("builds when the listed window contains no published prerelease", async () => {
    // Listing is newest-first and bounded at 30. A preview older than that
    // window is not compared, so the honest answer is to build rather than skip.
    const stables: ReadonlyArray<ListedGitHubRelease> = Array.from({ length: 30 }, (_, index) => ({
      tagName: `v1.0.${String(index)}`,
      isPrerelease: false,
      isDraft: false,
    }));

    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => stables,
      resolveTagCommit: neverResolve,
    });

    expect(decision).toEqual({ kind: "build", reason: "no-previous-preview" });
  });

  it("skips when HEAD is the same commit as the latest published preview tag", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [publishedPreview],
      resolveTagCommit: async () => HEAD,
    });

    expect(decision).toEqual({
      kind: "skip",
      reason: "same-commit",
      previousTag: publishedPreview.tagName,
      previousCommit: HEAD,
    });
    expect(githubOutputLines(decision)).toEqual([`build=false`, `previous-commit=${HEAD}`]);
  });

  it("builds when HEAD is a different commit from the latest published preview", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [publishedPreview],
      resolveTagCommit: async () => PREVIOUS,
    });

    expect(decision).toEqual({
      kind: "build",
      reason: "head-moved",
      previousTag: publishedPreview.tagName,
      previousCommit: PREVIOUS,
    });
    expect(githubOutputLines(decision)).toEqual([`build=true`, `previous-commit=${PREVIOUS}`]);
  });

  it("builds when forced even if HEAD matches the latest published preview", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: true,
      listReleases: async () => [publishedPreview],
      resolveTagCommit: async () => HEAD,
    });

    expect(decision).toEqual({
      kind: "build",
      reason: "forced",
      previousTag: publishedPreview.tagName,
      previousCommit: HEAD,
    });
    expect(githubOutputLines(decision)).toEqual([`build=true`, `previous-commit=${HEAD}`]);
  });

  it("ignores a stable release and uses a later published prerelease", async () => {
    const olderPreview: ListedGitHubRelease = {
      tagName: "v0.1.0-preview.20260901.3",
      isPrerelease: true,
      isDraft: false,
    };
    const resolved: string[] = [];

    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [
        { tagName: "v1.0.0", isPrerelease: false, isDraft: false },
        olderPreview,
      ],
      resolveTagCommit: async (tagName) => {
        resolved.push(tagName);
        return PREVIOUS;
      },
    });

    expect(resolved).toEqual([olderPreview.tagName]);
    expect(decision).toEqual({
      kind: "build",
      reason: "head-moved",
      previousTag: olderPreview.tagName,
      previousCommit: PREVIOUS,
    });
  });

  it("ignores a draft prerelease", async () => {
    const published: ListedGitHubRelease = {
      tagName: "v0.1.0-preview.published",
      isPrerelease: true,
      isDraft: false,
    };
    const resolved: string[] = [];

    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [
        { tagName: "v0.1.0-preview.draft", isPrerelease: true, isDraft: true },
        published,
      ],
      resolveTagCommit: async (tagName) => {
        resolved.push(tagName);
        return HEAD;
      },
    });

    expect(resolved).toEqual([published.tagName]);
    expect(decision.kind).toBe("skip");
  });

  it("fails when listing releases fails instead of treating it as empty history", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => {
        throw new Error('Unknown JSON field: "targetCommitish"');
      },
      resolveTagCommit: neverResolve,
    });

    expect(decision.kind).toBe("failed");
    expect(decision.kind === "failed" ? decision.reason : undefined).toBe("list-unavailable");
    expect(decision.kind === "failed" ? decision.message : undefined).toContain("targetCommitish");
  });

  it("fails when the preview tag cannot be resolved to a commit", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [publishedPreview],
      resolveTagCommit: async () => {
        throw new Error(`fatal: Needed a single revision`);
      },
    });

    expect(decision.kind).toBe("failed");
    expect(decision.kind === "failed" ? decision.reason : undefined).toBe("tag-unresolvable");
  });

  it("fails when the latest published preview has no tag name", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [{ tagName: "  ", isPrerelease: true, isDraft: false }],
      resolveTagCommit: neverResolve,
    });

    expect(decision.kind).toBe("failed");
    expect(decision.kind === "failed" ? decision.reason : undefined).toBe("tag-unresolvable");
  });

  it("peels a lightweight tag to the commit it names", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [{ tagName: "preview-light", isPrerelease: true, isDraft: false }],
      resolveTagCommit: async (tagName) => {
        expect(gitPeelTagToCommitArgv(tagName).at(-1)).toBe("refs/tags/preview-light^{commit}");
        return HEAD;
      },
    });

    expect(decision.kind).toBe("skip");
    expect(decision.kind === "skip" ? decision.previousCommit : undefined).toBe(HEAD);
  });

  it("peels an annotated tag to the commit, not the tag object", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => [
        { tagName: "preview-annotated", isPrerelease: true, isDraft: false },
      ],
      resolveTagCommit: async (tagName) => {
        expect(gitPeelTagToCommitArgv(tagName).at(-1)).toBe("refs/tags/preview-annotated^{commit}");
        return HEAD;
      },
    });

    expect(decision.kind).toBe("skip");
    expect(decision.kind === "skip" ? decision.previousCommit : undefined).not.toBe(TAG_OBJECT);
  });

  it("does not ask GitHub for unsupported release-list JSON fields", () => {
    const argv = githubReleaseListArgv();
    const jsonFields = argv[argv.lastIndexOf("--json") + 1];

    expect(jsonFields).toBe("tagName,isPrerelease,isDraft");
    expect(jsonFields).not.toContain("targetCommitish");
    expect(argv).toContain("--exclude-drafts");
  });

  it("fails closed when the release list is not valid JSON instead of treating it as empty history", async () => {
    const decision = await decidePreviewRelease({
      headCommit: HEAD,
      force: false,
      listReleases: async () => parseGitHubReleaseListJson("not-json"),
      resolveTagCommit: neverResolve,
    });

    expect(decision.kind).toBe("failed");
    expect(decision.kind === "failed" ? decision.reason : undefined).toBe("list-unavailable");
  });
});

describe("peeling preview tags with git", () => {
  let repo = "";
  let commit = "";
  let annotatedTagObject = "";

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "octant-preview-tag-"));
    git(repo, ["-c", "init.defaultBranch=main", "init"]);
    git(repo, ["config", "user.email", "octant@example.invalid"]);
    git(repo, ["config", "user.name", "Octant"]);
    git(repo, ["commit", "--allow-empty", "-m", "preview-head"]);
    commit = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["tag", "preview-light"]);
    git(repo, ["tag", "-a", "preview-annotated", "-m", "annotated preview"]);
    annotatedTagObject = git(repo, ["rev-parse", "refs/tags/preview-annotated"]);
  });

  afterAll(async () => {
    if (repo !== "") await rm(repo, { recursive: true, force: true });
  });

  it("resolves a lightweight tag to the commit it names", () => {
    expect(resolveGitTagCommit("preview-light", { cwd: repo })).toBe(commit);
  });

  it("resolves an annotated tag to the commit, not the tag object", () => {
    expect(annotatedTagObject).not.toBe(commit);
    expect(resolveGitTagCommit("preview-annotated", { cwd: repo })).toBe(commit);
    expect(resolveGitTagCommit("preview-annotated", { cwd: repo })).not.toBe(annotatedTagObject);
  });
});

function git(cwd: string, args: ReadonlyArray<string>): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  }
  return result.stdout.trim();
}

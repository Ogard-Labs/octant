import { describe, expect, it, vi } from "vitest";
import { createArtifactMirrorCommitPort } from "./artifactMirrorCommitPort";

function gitAt(
  observations: ReadonlyArray<{
    readonly changedPaths: ReadonlyArray<string>;
    readonly stagedSummary: ReadonlyArray<{ readonly path: string }>;
  }>,
) {
  let read = 0;
  const observe = vi.fn(async () => {
    const current = observations[Math.min(read++, observations.length - 1)];
    return {
      status: "ready" as const,
      checkoutRoot: "/repos/storefront",
      changedPaths: current?.changedPaths ?? [],
      stagedSummary: current?.stagedSummary ?? [],
      stateToken: `token-${read}`,
    };
  });
  const stage = vi.fn(async (_input: { readonly paths: readonly string[] }) => ({
    status: "applied" as const,
  }));
  const commit = vi.fn(async (_input: { readonly message: string }) => ({
    status: "applied" as const,
  }));
  return { observe, stage, commit } as unknown as Parameters<
    typeof createArtifactMirrorCommitPort
  >[0] & { observe: typeof observe; stage: typeof stage; commit: typeof commit };
}

const written = ["docs/artifacts/launch-plan-1a2b3c4d.octant.json"];

describe("committing the files the mirror wrote", () => {
  it("commits exactly the artifact files and nothing else", async () => {
    const git = gitAt([
      { changedPaths: written, stagedSummary: [] },
      { changedPaths: written, stagedSummary: [{ path: written[0] as string }] },
    ]);

    const outcome = await createArtifactMirrorCommitPort(git)({
      checkoutRoot: "/repos/storefront",
      paths: written,
      message: "Update mirrored artifact: Launch plan",
    });

    expect(outcome).toEqual({ status: "committed" });
    expect(git.stage.mock.calls[0]?.[0]).toMatchObject({ paths: written });
    expect(git.commit.mock.calls[0]?.[0]).toMatchObject({
      message: "Update mirrored artifact: Launch plan",
    });
  });

  it("refuses rather than sweeping someone's staged work into the commit", async () => {
    const git = gitAt([
      { changedPaths: [...written, "src/app.ts"], stagedSummary: [{ path: "src/app.ts" }] },
    ]);

    const outcome = await createArtifactMirrorCommitPort(git)({
      checkoutRoot: "/repos/storefront",
      paths: written,
      message: "Update mirrored artifact: Launch plan",
    });

    expect(outcome).toEqual({ status: "refused", reason: "index-holds-other-work" });
    expect(git.stage).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("makes no commit when the rewrite changed nothing", async () => {
    const git = gitAt([{ changedPaths: [], stagedSummary: [] }]);

    const outcome = await createArtifactMirrorCommitPort(git)({
      checkoutRoot: "/repos/storefront",
      paths: written,
      message: "Update mirrored artifact: Launch plan",
    });

    expect(outcome).toEqual({ status: "refused", reason: "nothing-to-commit" });
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("reports a refused commit rather than retrying it", async () => {
    const git = gitAt([
      { changedPaths: written, stagedSummary: [] },
      { changedPaths: written, stagedSummary: [{ path: written[0] as string }] },
    ]);
    git.commit.mockResolvedValueOnce({ status: "rejected" } as never);

    const outcome = await createArtifactMirrorCommitPort(git)({
      checkoutRoot: "/repos/storefront",
      paths: written,
      message: "Update mirrored artifact: Launch plan",
    });

    expect(outcome).toEqual({ status: "refused", reason: "commit-rejected" });
    expect(git.commit).toHaveBeenCalledOnce();
  });
});

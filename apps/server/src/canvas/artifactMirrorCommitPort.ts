import type { ArtifactMirrorCommitOutcome } from "@octant/contracts/artifact-mirror";
import type { GitService } from "../code/gitService";

/**
 * Committing what the mirror just wrote.
 *
 * Auto-commit commits the artifact files and nothing else. Anything already in
 * the index belongs to whoever staged it, so a commit that would carry it is
 * refused rather than made — a person who staged half a change and then saw an
 * artifact revision land would otherwise get a commit they never wrote.
 *
 * Nothing here pushes. Reaching a remote stays an act the user takes.
 */
export type ArtifactMirrorCommitPort = (input: {
  readonly checkoutRoot: string;
  readonly paths: ReadonlyArray<string>;
  readonly message: string;
}) => Promise<ArtifactMirrorCommitOutcome>;

export function createArtifactMirrorCommitPort(
  git: Pick<GitService, "observe" | "stage" | "commit">,
): ArtifactMirrorCommitPort {
  return async (input) => {
    const before = await git.observe(input.checkoutRoot);
    if (before.status !== "ready") return { status: "refused", reason: "commit-unavailable" };
    if (before.stagedSummary.length > 0) {
      return { status: "refused", reason: "index-holds-other-work" };
    }
    // A rewrite that changed nothing leaves the checkout clean; there is no
    // commit to make, and an empty one would be noise in the user's history.
    const changed = new Set(before.changedPaths);
    const paths = input.paths.filter((path) => changed.has(path));
    if (paths.length === 0) return { status: "refused", reason: "nothing-to-commit" };

    const staged = await git.stage({
      checkoutId: input.checkoutRoot,
      checkoutRoot: input.checkoutRoot,
      paths,
      expectedStateToken: before.stateToken,
    });
    if (staged.status !== "applied") return { status: "refused", reason: "commit-rejected" };

    // Re-read rather than assuming: the commit is authorized against the index
    // as it actually stands, so anything that changed underneath refuses here
    // instead of being committed unseen.
    const after = await git.observe(input.checkoutRoot);
    if (after.status !== "ready") return { status: "refused", reason: "commit-unavailable" };
    const committed = await git.commit({
      checkoutId: input.checkoutRoot,
      checkoutRoot: input.checkoutRoot,
      message: input.message,
      expectedStateToken: after.stateToken,
      stagedSummary: after.stagedSummary,
    });
    return committed.status === "applied"
      ? { status: "committed" }
      : { status: "refused", reason: "commit-rejected" };
  };
}

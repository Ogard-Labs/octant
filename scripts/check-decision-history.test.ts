import { describe, expect, it } from "vitest";
import { findHistoryViolations, type RepositoryState, resolveBase } from "./check-decision-history";

const ACCEPTED = "# 0001. Plugin architecture\n\n**Status:** Accepted\n\n## Decision\n\nWhat.\n";
const PATH = "docs/legacy/decisions/0001-plugin-architecture.md";
const FORMER_PATH = "docs/decisions/0001-plugin-architecture.md";

function reasons(
  current: Readonly<Record<string, string>>,
  base: ReadonlyArray<{ readonly path: string; readonly content: string }> = [
    { path: PATH, content: ACCEPTED },
  ],
): ReadonlyArray<string> {
  return findHistoryViolations(base, (path) => current[path]).map((violation) => violation.reason);
}

function repository(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return {
    isRepository: true,
    isShallow: false,
    hasCommits: true,
    candidates: [{ ref: "origin/main", mergeBase: "abc123" }],
    ...overrides,
  };
}

describe("resolveBase", () => {
  it("compares against the first base ref that resolves", () => {
    expect(
      resolveBase(
        repository({
          candidates: [
            { ref: "origin/main", mergeBase: undefined },
            { ref: "main", mergeBase: "def456" },
          ],
        }),
      ),
    ).toEqual({ status: "resolved", ref: "main", commit: "def456" });
  });

  it("skips a shallow clone rather than answering from truncated history", () => {
    // A depth-1 CI checkout is the common case, and `git merge-base` on grafted
    // history answers from the commits it happens to have. A wrong base reports
    // every record as replaced, which is worse than not running.
    const resolution = resolveBase(repository({ isShallow: true }));
    expect(resolution.status).toBe("unanswerable");
    expect(resolution.status === "unanswerable" && resolution.reason).toContain("shallow");
  });

  it("skips a clone with no base ref instead of failing it", () => {
    const resolution = resolveBase(
      repository({ candidates: [{ ref: "origin/main", mergeBase: undefined }] }),
    );
    expect(resolution.status).toBe("unanswerable");
    expect(resolution.status === "unanswerable" && resolution.reason).toContain(
      "OCTANT_DECISIONS_BASE",
    );
  });

  it("skips a directory that is not a git repository", () => {
    expect(resolveBase(repository({ isRepository: false })).status).toBe("unanswerable");
  });

  it("skips a repository with no commits to compare against", () => {
    expect(resolveBase(repository({ hasCommits: false })).status).toBe("unanswerable");
  });
});

describe("findHistoryViolations", () => {
  it("accepts an archived record left exactly as it was", () => {
    expect(reasons({ [PATH]: ACCEPTED })).toEqual([]);
  });

  it("refuses an edit to an archived record's wording", () => {
    expect(reasons({ [PATH]: ACCEPTED.replace("What.", "Something else.") })).toEqual([
      "was edited; the decision archive is closed, so its records keep their wording and status. Change the owning specification instead",
    ]);
  });

  it("refuses a status change, which used to be how a record retired", () => {
    expect(reasons({ [PATH]: ACCEPTED.replace("Accepted", "Superseded by 0002") })).toHaveLength(1);
  });

  it("refuses an edit to a record that was only ever proposed", () => {
    const proposed = ACCEPTED.replace("Accepted", "Proposed");
    expect(
      reasons({ [PATH]: proposed.replace("What.", "Revised.") }, [
        { path: PATH, content: proposed },
      ]),
    ).toHaveLength(1);
  });

  it("accepts a record moved unchanged from the archive's former folder", () => {
    expect(reasons({ [PATH]: ACCEPTED }, [{ path: FORMER_PATH, content: ACCEPTED }])).toEqual([]);
  });

  it("accepts a moved record whose outward links gained one level", () => {
    const linked = `${ACCEPTED}\nSee [the model](../security/model.md).\n`;
    expect(
      reasons({ [PATH]: linked.replace("](../", "](../../") }, [
        { path: FORMER_PATH, content: linked },
      ]),
    ).toEqual([]);
  });

  it("refuses a record edited while it moved", () => {
    expect(
      reasons({ [PATH]: ACCEPTED.replace("What.", "Changed.") }, [
        { path: FORMER_PATH, content: ACCEPTED },
      ]),
    ).toHaveLength(1);
  });

  it("refuses a record left behind in the former folder", () => {
    expect(
      reasons({ [FORMER_PATH]: ACCEPTED }, [{ path: FORMER_PATH, content: ACCEPTED }]),
    ).toEqual(["is gone; the decision archive is closed, so its records keep their paths"]);
  });

  it("refuses removing or renaming an archived record", () => {
    expect(reasons({ "docs/legacy/decisions/0001-plugin-seams.md": ACCEPTED })).toEqual([
      "is gone; the decision archive is closed, so its records keep their paths",
    ]);
  });
});

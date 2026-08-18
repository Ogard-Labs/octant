import { describe, expect, it } from "vitest";
import {
  findHistoryViolations,
  type RecordIdentity,
  type RepositoryState,
  resolveBase,
} from "./check-decision-history";

function identity(
  number: string,
  slug: string,
  title: string,
  status = "Accepted",
): RecordIdentity {
  return { number, path: `docs/decisions/${number}-${slug}.md`, title, status };
}

function reasons(
  base: ReadonlyArray<RecordIdentity>,
  head: ReadonlyArray<RecordIdentity>,
  renames: ReadonlyArray<{ readonly from: string; readonly to: string }> = [],
): ReadonlyArray<string> {
  return findHistoryViolations(base, head, renames).map((violation) => violation.reason);
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
  it("accepts a number that still holds the record it held", () => {
    const record = identity("0001", "plugin-architecture", "Plugin architecture");
    expect(reasons([record], [record])).toEqual([]);
  });

  it("rejects an accepted record swapped for a different one under its number", () => {
    // The hole this gate exists for: delete the record, add a well-formed one
    // under the same number, fix the index row, and the tree gate sees a
    // contiguous, internally consistent set.
    expect(
      reasons(
        [identity("0001", "plugin-architecture", "Plugin architecture")],
        [identity("0001", "replacement", "Something else entirely")],
      ),
    ).toEqual([
      'held "Plugin architecture" in docs/decisions/0001-plugin-architecture.md and now holds "Something else entirely"; supersede the accepted record instead of replacing it, or stage the rename so git can see it is the same record',
    ]);
  });

  it("accepts a slug change git recognizes as the same document", () => {
    expect(
      reasons(
        [identity("0001", "plugin-architecture", "Plugin architecture")],
        [identity("0001", "plugin-seams", "Plugin seams")],
        [
          {
            from: "docs/decisions/0001-plugin-architecture.md",
            to: "docs/decisions/0001-plugin-seams.md",
          },
        ],
      ),
    ).toEqual([]);
  });

  it("accepts a record rewritten as history when it declares a supersession that resolves", () => {
    expect(
      reasons(
        [identity("0001", "plugin-architecture", "Plugin architecture")],
        [
          identity(
            "0001",
            "plugin-architecture",
            "Plugin architecture (historical)",
            "Superseded by 0020",
          ),
          identity("0020", "plugin-seams", "Plugin seams"),
        ],
      ),
    ).toEqual([]);
  });

  it("rejects a replacement dressed as a supersession that points at nothing", () => {
    expect(
      reasons(
        [identity("0001", "plugin-architecture", "Plugin architecture")],
        [identity("0001", "plugin-architecture", "Something else", "Superseded by 0042")],
      ),
    ).toEqual([
      'held "Plugin architecture" and now holds "Something else"; supersede the accepted record instead of retitling it',
    ]);
  });

  it("rejects deleting an accepted record outright", () => {
    expect(reasons([identity("0001", "plugin-architecture", "Plugin architecture")], [])).toEqual([
      "was Accepted and is gone; an accepted record is superseded, never removed",
    ]);
  });

  it("rejects renumbering an accepted record", () => {
    expect(
      reasons(
        [identity("0001", "plugin-architecture", "Plugin architecture")],
        [identity("0020", "plugin-architecture", "Plugin architecture")],
        [
          {
            from: "docs/decisions/0001-plugin-architecture.md",
            to: "docs/decisions/0020-plugin-architecture.md",
          },
        ],
      ),
    ).toEqual([
      "was Accepted and became docs/decisions/0020-plugin-architecture.md; a record keeps its number for as long as it exists",
    ]);
  });

  it("lets a proposal be revised in place", () => {
    // `docs/decisions/README.md` says a Proposed record is still being agreed,
    // so there is no history for this gate to protect yet.
    expect(
      reasons(
        [identity("0001", "plugin-architecture", "Plugin architecture", "Proposed")],
        [identity("0001", "plugin-seams", "Plugin seams", "Proposed")],
      ),
    ).toEqual([]);
  });
});

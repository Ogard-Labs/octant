import { describe, expect, it } from "vitest";
import { forgeShellChanges, forgeShellHardLine } from "./forgeShellChangePolicy";

const threads = { ownBranch: "feature/mine", otherThreadBranches: ["feature/theirs"] };
const lineOf = (command: string) => forgeShellHardLine(forgeShellChanges(command), threads);

describe("forge changes a shell command makes", () => {
  it("reads pushes, merges, and pull-request changes, and nothing else", () => {
    expect(forgeShellChanges("git status && git log --oneline")).toEqual([]);
    expect(forgeShellChanges("gh pr view 12 && gh pr list")).toEqual([]);
    expect(forgeShellChanges("echo 'git push --force' > notes.txt")).toEqual([]);
    expect(forgeShellChanges("git push origin feature/x # then main")).toMatchObject([
      { kind: "push", branches: ["feature/x"] },
    ]);
    expect(forgeShellChanges("# git push --force\nbun test")).toEqual([]);
    expect(forgeShellChanges("git push")).toMatchObject([
      { kind: "push", branches: [], force: "none" },
    ]);
    expect(forgeShellChanges("git -C ../app push origin HEAD:refs/heads/feature/x")).toMatchObject([
      { kind: "push", branches: ["feature/x"] },
    ]);
    expect(forgeShellChanges("gh pr create --fill")).toMatchObject([{ kind: "pull-request" }]);
    expect(forgeShellChanges("gh -R o/r pr merge 7 --squash --auto")).toMatchObject([
      { kind: "merge" },
    ]);
    expect(forgeShellChanges("gh api -X PUT repos/o/r/pulls/7/merge")).toMatchObject([
      { kind: "merge" },
    ]);
    expect(forgeShellChanges("gh api repos/o/r/pulls/7")).toEqual([]);
    expect(forgeShellChanges("gh api repos/o/r/pulls -f title=x -f head=y")).toMatchObject([
      { kind: "pull-request" },
    ]);
    expect(
      forgeShellChanges(
        `gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'`,
      ),
    ).toMatchObject([{ kind: "merge" }]);
  });

  it("finds a push hidden inside a nested shell or after a separator", () => {
    expect(forgeShellChanges(`bash -c "git push --force origin main"`)).toMatchObject([
      { kind: "push", force: "plain", branches: ["main"] },
    ]);
    expect(forgeShellChanges("bun test; FOO=1 git push -fu origin feature/mine")).toMatchObject([
      { kind: "push", force: "plain" },
    ]);
  });

  it("reads a push or merge behind a shell flag cluster, a compound command, or a wrapper", () => {
    for (const command of [
      "bash -lc 'git push -f origin main'",
      "sh -ec 'git push -f origin main'",
      "if true; then git push -f origin main; fi",
      "for b in a; do git push -f origin main; done",
      "{ git push -f origin main; }",
      "timeout 60 git push -f origin main",
      "xargs -n 1 git push -f",
      "\\git push -f origin main",
    ]) {
      expect(lineOf(command), command).toBe("force-push-not-asked");
    }
    expect(lineOf("! gh pr merge 5")).toBe("merge-not-asked");
  });

  it("does not mistake an option value, a read of the merge state, or a message for a forge change", () => {
    expect(forgeShellChanges("git push -ofoo origin feature/mine")).toMatchObject([
      { kind: "push", force: "none", deletes: false },
    ]);
    expect(forgeShellChanges("gh api repos/o/r/pulls/1/merge")).toEqual([]);
    expect(
      forgeShellChanges(
        "git commit -F - <<'EOF'\nDo not run gh pr merge 5\ngit push -f\nEOF\nbun test",
      ),
    ).toEqual([]);
    expect(
      forgeShellChanges("cat <<EOF > notes\ngh pr merge 1\nEOF\ngit push origin feature/mine"),
    ).toMatchObject([{ kind: "push", branches: ["feature/mine"] }]);
  });

  it("marks a push whose target hides behind an expansion as unreadable", () => {
    expect(forgeShellChanges('git push origin "$BRANCH"')).toMatchObject([
      { kind: "push", unreadable: true },
    ]);
  });
});

describe("hard lines on a shell command nothing else reviews", () => {
  it("lets ordinary pushes and pull-request changes through", () => {
    expect(lineOf("git push")).toBeUndefined();
    expect(lineOf("git push -u origin feature/mine")).toBeUndefined();
    expect(lineOf("git push --force-with-lease origin feature/mine")).toBeUndefined();
    expect(lineOf("gh pr create --fill && gh pr edit --add-label ready")).toBeUndefined();
  });

  it("refuses a merge the person did not ask for, however it is spelled", () => {
    expect(lineOf("gh pr merge 7 --squash")).toBe("merge-not-asked");
    expect(lineOf("gh api --method PUT repos/o/r/pulls/7/merge")).toBe("merge-not-asked");
    expect(lineOf('gh pr merge "$N"')).toBe("merge-not-asked");
  });

  it("refuses a plain force-push, and a forced or deleting push off the thread's own branch", () => {
    expect(lineOf("git push --force")).toBe("force-push-not-asked");
    expect(lineOf("git push origin +feature/mine")).toBe("force-push-not-asked");
    expect(lineOf("git push --force-with-lease origin main")).toBe("force-push-not-asked");
    expect(lineOf("git push origin :release")).toBe("force-push-not-asked");
  });

  it("refuses a push to another thread's branch, named or swept in with every branch", () => {
    expect(lineOf("git push origin feature/theirs")).toBe("other-thread-branch");
    expect(lineOf("git push origin HEAD:refs/heads/feature/theirs")).toBe("other-thread-branch");
    expect(lineOf("git push --all origin")).toBe("other-thread-branch");
    expect(
      forgeShellHardLine(forgeShellChanges("git push --all origin"), {
        ownBranch: "feature/mine",
        otherThreadBranches: [],
      }),
    ).toBeUndefined();
  });

  it("does not count a branch another thread shares with this one as someone else's", () => {
    expect(
      forgeShellHardLine(forgeShellChanges("git push origin feature/mine"), {
        ownBranch: "feature/mine",
        otherThreadBranches: ["feature/mine"],
      }),
    ).toBeUndefined();
  });

  it("does not refuse a push whose target it cannot read", () => {
    expect(lineOf('git push origin "$BRANCH"')).toBeUndefined();
  });
});

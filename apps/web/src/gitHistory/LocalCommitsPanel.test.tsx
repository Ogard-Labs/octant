import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeGitHistoryQuery, decodeGitHistoryResult } from "@octant/contracts/git-history";
import { LocalCommitsPanel } from "./LocalCommitsPanel";

const scope = decodeGitHistoryQuery({
  kind: "local-commits",
  threadId: "11111111-1111-4111-8111-111111111111",
  checkoutId: "22222222-2222-4222-8222-222222222222",
});
const commit = {
  oid: "a".repeat(40),
  parents: [],
  subject: "Save the first note",
  author: "Octant Test",
  authoredAt: "2026-09-09T12:00:00Z",
};
const listing = (
  commits: ReadonlyArray<typeof commit>,
  comparedWith?: string,
  commitsTruncated?: boolean,
) =>
  decodeGitHistoryResult({
    status: "history",
    threadId: scope.threadId,
    checkoutId: scope.checkoutId,
    commits,
    ...(comparedWith === undefined ? {} : { comparedWith }),
    ...(commitsTruncated === true ? { commitsTruncated } : {}),
    refs: [],
    head: commit.oid,
    branch: "feature/notes",
    shallow: false,
    refsTruncated: false,
    nextCursor: null,
  });
const detail = decodeGitHistoryResult({
  status: "commit",
  threadId: scope.threadId,
  checkoutId: scope.checkoutId,
  commit,
  message: commit.subject,
  parent: null,
  files: 1,
  insertions: 1,
  deletions: 0,
  truncated: false,
  diff: "diff --git a/note.txt b/note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+Hello\n",
});

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Local commits panel", () => {
  it("names what the commits are measured against and opens one to its diff", async () => {
    const read = vi.fn(async (query: { kind: string }) =>
      query.kind === "local-commits" ? listing([commit], "origin/feature/notes") : detail,
    );
    const user = userEvent.setup();
    render(
      <LocalCommitsPanel
        reader={{ read }}
        threadId={scope.threadId}
        checkoutId={scope.checkoutId}
      />,
    );

    expect(await screen.findByText(/1 local commit · not on origin\/feature\/notes/)).toBeVisible();
    expect(read).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText(/Save the first note/));

    expect(await screen.findByText("Hello")).toBeVisible();
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "commit", oid: commit.oid, parent: 0 }),
      expect.any(AbortSignal),
    );
  });

  it("says so when nothing is unpushed, and when there is nothing to compare against", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(listing([], "origin/main"))
      .mockResolvedValueOnce(listing([]));
    const user = userEvent.setup();
    render(
      <LocalCommitsPanel
        reader={{ read }}
        threadId={scope.threadId}
        checkoutId={scope.checkoutId}
      />,
    );

    expect(
      await screen.findByText("Every commit on this branch is already on origin/main."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText("There is no upstream or base branch to compare against."),
    ).toBeVisible();
  });

  it("says the list is cut when older local commits are not shown", async () => {
    const read = vi.fn(async () => listing([commit], "origin/main", true));
    render(
      <LocalCommitsPanel
        reader={{ read }}
        threadId={scope.threadId}
        checkoutId={scope.checkoutId}
      />,
    );

    expect(await screen.findByText(/1\+ local commit · not on origin\/main/)).toBeVisible();
    expect(screen.getByRole("note")).toHaveTextContent(
      "Showing the newest 1. Older local commits are not listed.",
    );
  });

  it("rereads a commit with whitespace ignored and remembers the choice", async () => {
    const read = vi.fn(async (query: { kind: string }) =>
      query.kind === "local-commits" ? listing([commit], "origin/main") : detail,
    );
    const user = userEvent.setup();
    render(
      <LocalCommitsPanel
        reader={{ read }}
        threadId={scope.threadId}
        checkoutId={scope.checkoutId}
      />,
    );
    await user.click(await screen.findByText(/Save the first note/));
    await screen.findByText("Hello");

    await user.click(screen.getByRole("checkbox", { name: "Ignore whitespace" }));

    await vi.waitFor(() =>
      expect(read).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "commit", ignoreWhitespace: true }),
        expect.any(AbortSignal),
      ),
    );
    expect(localStorage.getItem("octant.code.diff-ignore-whitespace.v1")).toBe("true");
  });

  it("keeps a second mounted view in step when the whitespace choice changes", async () => {
    const read = vi.fn(async () => listing([commit], "origin/main"));
    const user = userEvent.setup();
    render(
      <>
        <LocalCommitsPanel
          reader={{ read }}
          threadId={scope.threadId}
          checkoutId={scope.checkoutId}
        />
        <LocalCommitsPanel
          reader={{ read }}
          threadId={scope.threadId}
          checkoutId={scope.checkoutId}
        />
      </>,
    );
    const [first, second] = await screen.findAllByRole("checkbox", { name: "Ignore whitespace" });

    await user.click(first!);

    expect(second).toBeChecked();
  });
});

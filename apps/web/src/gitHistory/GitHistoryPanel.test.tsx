import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeGitHistoryQuery, decodeGitHistoryResult } from "@octant/contracts/git-history";
import { GitHistoryPanel } from "./GitHistoryPanel";

vi.mock("../code/MonacoDiffAdapter", () => ({
  MonacoDiffAdapter: (props: {
    readonly modelUriBase: string;
    readonly original: string;
    readonly modified: string;
  }) => {
    if (new URL(props.modelUriBase).protocol !== "octant-code:")
      throw new Error("Monaco refuses non-Octant model identities");
    return (
      <section aria-label="Historical comparison">
        <pre>{props.original}</pre>
        <pre>{props.modified}</pre>
      </section>
    );
  },
}));

const scope = decodeGitHistoryQuery({
  kind: "history",
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
const page = decodeGitHistoryResult({
  status: "history",
  threadId: scope.threadId,
  checkoutId: scope.checkoutId,
  commits: [commit],
  refs: [],
  head: commit.oid,
  branch: "main",
  shallow: false,
  refsTruncated: false,
  nextCursor: null,
});
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(480);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(640);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Git history panel", () => {
  it("opens an exact commit and returns to the loaded history", async () => {
    const read = vi.fn(async (query: { kind: string }) =>
      query.kind === "history"
        ? page
        : decodeGitHistoryResult({
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
          }),
    );
    const user = userEvent.setup();
    render(
      <GitHistoryPanel reader={{ read }} threadId={scope.threadId} checkoutId={scope.checkoutId} />,
    );
    await user.click(await screen.findByRole("button", { name: /Save the first note/ }));
    expect(await screen.findByText("Hello")).toBeVisible();
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "commit", oid: commit.oid, parent: 0 }),
      expect.any(AbortSignal),
    );
    await user.click(screen.getByRole("button", { name: "Side by side" }));
    expect(await screen.findByRole("region", { name: "Historical comparison" })).toHaveTextContent(
      "Hello",
    );
    await user.click(screen.getByRole("button", { name: "Back to history" }));
    expect(screen.getByRole("button", { name: /Save the first note/ })).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Save the first note/ })).toHaveFocus(),
    );
  });

  it("discards an old checkout response after the selected thread changes", async () => {
    let resolve: ((value: typeof page) => void) | undefined;
    const reader = {
      read: vi.fn(
        () =>
          new Promise<typeof page>((done) => {
            resolve = done;
          }),
      ),
    };
    const view = render(
      <GitHistoryPanel reader={reader} threadId={scope.threadId} checkoutId={scope.checkoutId} />,
    );
    const old = resolve;
    view.rerender(
      <GitHistoryPanel
        reader={reader}
        threadId={scope.threadId}
        checkoutId={"33333333-3333-4333-8333-333333333333" as typeof scope.checkoutId}
      />,
    );
    old?.(page);
    await waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /Save the first note/ })).toBeNull();
  });
});

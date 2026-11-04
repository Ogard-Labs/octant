import { Schema } from "effect";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeCodeCheckoutId,
  CodeGitOperationId,
  decodeCodeOperationId,
  decodeCodeOperationResult,
  decodeCodeThreadId,
} from "@octant/contracts";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { CodeSelectedHunks, type CodeSelectedHunksProps } from "./CodeSelectedHunks";
import { CodeDiffPane } from "./CodeDiffPane";

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const threadId = decodeCodeThreadId(id(1));
const checkoutId = decodeCodeCheckoutId(id(2));
const patch =
  "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old value\n+new value\n";
function comparison(
  scope: "unstaged" | "staged",
  operationId = decodeCodeOperationId(id(3)),
  empty = false,
) {
  return decodeCodeOperationResult({
    kind: "git-hunks",
    operationId,
    threadId,
    checkoutId,
    gitOperationId: id(4),
    scope,
    stateToken: "a".repeat(64),
    digest: "b".repeat(64),
    rootDigest: "e".repeat(64),
    diff: { contentId: id(5), digest: "c".repeat(64), byteLength: patch.length },
    hunks: empty
      ? []
      : [
          {
            id: "d".repeat(64),
            path: "file.txt",
            index: 0,
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
          },
        ],
    unavailable: [],
  });
}
function fixture() {
  let next = 20;
  let changed = false;
  const executeOperation = vi.fn<CodeClient["executeOperation"]>(async (command) => {
    if (command.kind === "prepare-git-hunks")
      return comparison(command.scope, command.operationId, changed);
    changed = true;
    return decodeCodeOperationResult({
      kind: "git-mutation-state",
      operationId: command.operationId,
      gitOperationId: id(4),
      mutation:
        command.kind === "stage-git-hunks"
          ? "stage-hunks"
          : command.kind === "unstage-git-hunks"
            ? "unstage-hunks"
            : "reverse-hunks",
      state: "completed",
    });
  });
  const operationContent = vi.fn<CodeClient["operationContent"]>(async () =>
    new TextEncoder().encode(patch),
  );
  const props: CodeSelectedHunksProps = {
    client: { executeOperation, operationContent },
    threadId,
    checkoutId,
    executionPolicy: "full-access",
    createOperationId: () => decodeCodeOperationId(id(next++)),
    createGitOperationId: () => Schema.decodeUnknownSync(CodeGitOperationId)(id(next++)),
  };
  return { props, executeOperation, operationContent };
}
async function compare(scope = "unstaged") {
  fireEvent.click(screen.getByText("Select Git hunks"));
  fireEvent.click(screen.getByRole("button", { name: `Compare ${scope} hunks` }));
  return screen.findByRole("checkbox");
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("selected hunks in current Review", () => {
  it.each(["unstaged", "staged"])(
    "renders exact %s comparison, sends host IDs only, then rereads updated index/diff",
    async (scope) => {
      const h = fixture();
      render(<CodeSelectedHunks {...h.props} />);
      const checkbox = await compare(scope);
      expect(
        screen.getByText(scope === "staged" ? "HEAD → Index" : "Index → Working tree"),
      ).toBeVisible();
      expect(screen.getByText("new value")).toBeVisible();
      fireEvent.click(checkbox);
      fireEvent.click(
        screen.getByRole("button", {
          name: scope === "staged" ? "Unstage selected hunks" : "Stage selected hunks",
        }),
      );
      await waitFor(() => expect(h.executeOperation).toHaveBeenCalledTimes(3));
      expect(h.executeOperation.mock.calls[1]![0]).toEqual(
        expect.objectContaining({
          kind: scope === "staged" ? "unstage-git-hunks" : "stage-git-hunks",
          threadId,
          checkoutId,
          comparisonOperationId: h.executeOperation.mock.calls[0]![0].operationId,
          selected: ["d".repeat(64)],
        }),
      );
      expect(h.executeOperation.mock.calls[1]![0]).not.toHaveProperty("patch");
      expect(await screen.findByText("No selectable text hunks in this comparison.")).toBeVisible();
    },
  );
  it("requires explicit reversal confirmation and keeps the selection on Cancel", async () => {
    const h = fixture();
    render(<CodeSelectedHunks {...h.props} />);
    fireEvent.click(await compare());
    fireEvent.click(screen.getByRole("button", { name: "Reverse selected hunks…" }));
    expect(screen.getByRole("dialog", { name: "Reverse selected hunks?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep changes" }));
    expect(h.executeOperation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Reverse selected hunks…" }));
    fireEvent.click(screen.getByRole("button", { name: "Reverse hunks" }));
    await waitFor(() => expect(h.executeOperation).toHaveBeenCalledTimes(3));
    expect(h.executeOperation.mock.calls[1]![0].kind).toBe("reverse-git-hunks");
  });
  it("does not dispatch a mutation when ordinary approval is declined", async () => {
    const h = fixture();
    const approval = vi.fn(async () => undefined);
    render(
      <CodeSelectedHunks
        {...h.props}
        executionPolicy="approval-gated"
        requestApproval={approval}
      />,
    );
    fireEvent.click(await compare());
    fireEvent.click(screen.getByRole("button", { name: "Stage selected hunks" }));
    await screen.findByText("No hunks were changed. Approval was not given.");
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: "stage-git-hunks" }));
    expect(h.executeOperation).toHaveBeenCalledTimes(1);
  });
  it("does not install an old client's late comparison after the source scope changes", async () => {
    const h = fixture();
    const held = Promise.withResolvers<Awaited<ReturnType<CodeClient["executeOperation"]>>>();
    h.executeOperation.mockReturnValueOnce(held.promise);
    const rendered = render(<CodeSelectedHunks {...h.props} />);
    fireEvent.click(screen.getByText("Select Git hunks"));
    fireEvent.click(screen.getByRole("button", { name: "Compare unstaged hunks" }));
    const replacement = fixture();
    rendered.rerender(
      <CodeSelectedHunks {...replacement.props} threadId={decodeCodeThreadId(id(90))} />,
    );
    await act(async () => held.resolve(comparison("unstaged")));
    expect(h.operationContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare unstaged hunks" })).toBeEnabled();
  });
  it("recovers from a held prepare deadline and ignores its late answer without fetching or enabling mutations", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const held = Promise.withResolvers<Awaited<ReturnType<CodeClient["executeOperation"]>>>();
    h.executeOperation.mockReturnValueOnce(held.promise);
    render(<CodeSelectedHunks {...h.props} />);
    fireEvent.click(screen.getByText("Select Git hunks"));
    fireEvent.click(screen.getByRole("button", { name: "Compare unstaged hunks" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(screen.getByText(/host did not finish in time/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Compare unstaged hunks" })).toBeEnabled();
    await act(async () => held.resolve(comparison("unstaged")));
    expect(h.operationContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("keeps Plan read-only and never exposes actions on a captured run comparison", async () => {
    const h = fixture();
    const rendered = render(<CodeSelectedHunks {...h.props} executionPolicy="plan" />);
    expect(await compare()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stage selected hunks" })).toBeDisabled();
    rendered.unmount();
    const run = decodeCodeOperationResult({
      kind: "run-reviewed",
      operationId: id(30),
      gitOperationId: id(31),
      outcome: {
        branch: "feature/hunks",
        baseRef: "main",
        head: "a".repeat(40),
        uncommittedPaths: [],
        mergeability: "clean",
        ahead: 1,
        behind: 0,
        changedPaths: ["file.txt"],
        diff: { contentId: id(5), digest: "c".repeat(64), byteLength: patch.length },
      },
    });
    if (run.kind !== "run-reviewed") throw Error("Wrong fixture");
    render(
      <CodeDiffPane
        client={h.props.client}
        diff={{ state: "run", threadId, checkoutId, run }}
        executionPolicy="full-access"
        createOperationId={h.props.createOperationId}
        createGitOperationId={h.props.createGitOperationId}
      />,
    );
    expect(screen.queryByText("Select Git hunks")).not.toBeInTheDocument();
  });
});

it("reports uncertain native failure without implying no effect or automatically retrying", async () => {
  const h = fixture();
  render(<CodeSelectedHunks {...h.props} />);
  fireEvent.click(await compare());
  h.executeOperation.mockImplementationOnce(async (command) =>
    decodeCodeOperationResult({
      kind: "git-mutation-state",
      operationId: command.operationId,
      gitOperationId: id(4),
      mutation: "stage-hunks",
      state: "failed",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stage selected hunks" }));
  expect(
    await screen.findByText(/Git did not confirm this write.*checkout may have changed/i),
  ).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(h.executeOperation).toHaveBeenCalledTimes(2);
});

it("bounds a held write and never installs its late success as a fresh comparison", async () => {
  const h = fixture();
  render(<CodeSelectedHunks {...h.props} />);
  fireEvent.click(await compare());
  const held = Promise.withResolvers<Awaited<ReturnType<CodeClient["executeOperation"]>>>();
  h.executeOperation.mockReturnValueOnce(held.promise);
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Stage selected hunks" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_001);
  });
  expect(screen.getByText(/host did not finish in time/i)).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  await act(async () =>
    held.resolve(
      decodeCodeOperationResult({
        kind: "git-mutation-state",
        operationId: id(22),
        gitOperationId: id(4),
        mutation: "stage-hunks",
        state: "completed",
      }),
    ),
  );
  expect(h.executeOperation).toHaveBeenCalledTimes(2);
  expect(h.operationContent).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Compare unstaged hunks" })).toBeEnabled();
});

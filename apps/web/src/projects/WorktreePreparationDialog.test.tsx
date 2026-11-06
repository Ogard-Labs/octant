import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { decodeProjectTerminalCommand, decodeProjectTerminalResult } from "@octant/contracts";
import { WorktreePreparationDialog } from "./WorktreePreparationDialog";
vi.mock("../ui/base/OctantSelect", () => ({
  OctantSelectField: (props: {
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  }) => (
    <select
      aria-label="Checkout to prepare"
      value={props.value}
      onChange={(event) => props.onValueChange(event.currentTarget.value)}
    >
      {props.options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
afterEach(cleanup);
it.each(["retry", "skip", "cancel"] as const)(
  "sends %s to the child checkout whose setup is displayed",
  async (action) => {
    const decoded = decodeProjectTerminalCommand({
      kind: "worktree-preparation",
      projectId: "90000000-0000-4000-8000-000000000001",
      thread: {
        threadId: "90000000-0000-4000-8000-000000000002",
        checkoutId: "90000000-0000-4000-8000-000000000003",
      },
      action: "inspect",
    });
    if (decoded.kind !== "worktree-preparation") throw Error("Invalid target");
    const childRequestId = "90000000-0000-4000-8000-000000000004";
    const execute = vi.fn(async () =>
      decodeProjectTerminalResult({
        kind: "worktree-preparation",
        receiptId: "90000000-0000-4000-8000-000000000006",
        preparation: {
          state: action === "cancel" ? "running" : "failed",
          recipe: {
            id: "90000000-0000-4000-8000-000000000007",
            name: "Setup",
            command: "bun run setup",
            directory: ".",
          },
          reason: "Fixture",
          startedAt: "2026-11-06T10:00:00.000Z",
          attemptId: "90000000-0000-4000-8000-000000000005",
        },
        output: "",
        outputTruncated: false,
      }),
    );
    render(
      <WorktreePreparationDialog
        client={{ execute }}
        target={decoded}
        runs={{
          parentSummary: vi
            .fn()
            .mockResolvedValue({
              entries: [{ requestId: childRequestId, task: "Selected child" }],
            }),
        }}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Child: Selected child" });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Checkout to prepare" }),
      childRequestId,
    );
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ action: "inspect", childRequestId }),
        expect.any(AbortSignal),
      ),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name:
          action === "retry" ? "Retry setup" : action === "skip" ? "Skip setup" : "Cancel setup",
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action, childRequestId, thread: decoded.thread }),
    );
  },
);

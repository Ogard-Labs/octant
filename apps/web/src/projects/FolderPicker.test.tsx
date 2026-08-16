import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { FolderBrowseResult, FolderCandidate } from "@octant/contracts/folder-browse";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolderPicker } from "./FolderPicker";

const hostId = "00000000-0000-4000-8000-000000000001";

describe("FolderPicker", () => {
  it("lets the user select a plain (non-git) folder as a Code root", async () => {
    const user = userEvent.setup();
    const home = browseResult([
      candidate({
        candidateId: "80000000-0000-4000-8000-000000000020" as never,
        displayName: "Dev",
        isGitRepository: false,
        isSelectable: true,
      }),
    ]);
    const browse = vi.fn().mockResolvedValueOnce(home);
    const select = vi.fn(async () => ({
      receiptId: "receipt-1",
      displayName: "Dev",
      selectedAt: "2026-07-27T12:00:00.000Z",
    }));
    const onSelect = vi.fn();

    render(
      <FolderPicker
        client={{ browse, select } as unknown as FolderBrowseClient}
        hostId={hostId}
        mode="code"
        onCancel={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "Add folder" })).toBeVisible();
    expect(
      screen.getByText("Navigate into a folder, then Select the directory to bind."),
    ).toBeVisible();
    expect(screen.getByText("Dev")).toBeVisible();
    expect(screen.getByText("Not a git repo")).toBeVisible();
    expect(screen.getByRole("option")).toHaveAttribute("aria-disabled", "false");

    await user.click(screen.getByRole("button", { name: "Select" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("receipt-1", "Dev"));
    expect(select.mock.calls[0]?.[0]).toMatchObject({
      candidateId: "80000000-0000-4000-8000-000000000020",
    });
  });
});

function browseResult(candidates: ReadonlyArray<FolderCandidate>): FolderBrowseResult {
  return {
    breadcrumbs: [
      { label: "/" },
      { label: "Users", candidateId: "80000000-0000-4000-8000-000000000010" as never },
      { label: "example", candidateId: "80000000-0000-4000-8000-000000000011" as never },
    ],
    candidates,
    hasMore: false,
    browsedAt: "2026-07-27T12:00:00.000Z" as never,
  };
}

function candidate(
  input: Pick<FolderCandidate, "candidateId" | "displayName" | "isGitRepository" | "isSelectable"> &
    Partial<Pick<FolderCandidate, "unselectableReason">>,
): FolderCandidate {
  return {
    candidateId: input.candidateId as never,
    displayName: input.displayName,
    isGitRepository: input.isGitRepository,
    isSelectable: input.isSelectable,
    ...(input.unselectableReason === undefined
      ? {}
      : { unselectableReason: input.unselectableReason }),
  };
}

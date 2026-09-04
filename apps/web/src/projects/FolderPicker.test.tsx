import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type {
  FolderBrowseRequest,
  FolderBrowseResult,
  FolderCandidate,
  FolderCandidateId,
} from "@octant/contracts/folder-browse";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolderPicker } from "./FolderPicker";

const hostId = "00000000-0000-4000-8000-000000000001";
const homeCandidateId = "80000000-0000-4000-8000-000000000010" as FolderCandidateId;
const projectsCandidateId = "80000000-0000-4000-8000-000000000011" as FolderCandidateId;
const alphaCandidateId = "80000000-0000-4000-8000-000000000020" as FolderCandidateId;
const betaCandidateId = "80000000-0000-4000-8000-000000000021" as FolderCandidateId;

describe("FolderPicker", () => {
  it("lets the user select a plain (non-git) folder as a Code root", async () => {
    const user = userEvent.setup();
    const home = browseResult({
      candidates: [
        candidate({
          candidateId: alphaCandidateId,
          displayName: "Dev",
          isGitRepository: false,
          isSelectable: true,
        }),
      ],
    });
    const browse = vi.fn().mockResolvedValueOnce(home);
    const select = vi.fn(async (_input: unknown) => ({
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
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith("receipt-1", "Dev", { initializeGit: true }),
    );
    expect(select.mock.calls[0]?.[0]).toMatchObject({
      candidateId: alphaCandidateId,
    });
  });

  it("sends the search term and keeps the current parent folder", async () => {
    const user = userEvent.setup();
    const browse = vi.fn(async (input: FolderBrowseRequest) => {
      if (input.parentCandidateId === projectsCandidateId && input.search === "alp") {
        return browseResult({
          breadcrumbs: nestedBreadcrumbs(),
          candidates: [
            candidate({
              candidateId: alphaCandidateId,
              displayName: "alpha",
              isGitRepository: false,
              isSelectable: true,
            }),
          ],
        });
      }
      if (input.parentCandidateId === projectsCandidateId) {
        return browseResult({
          breadcrumbs: nestedBreadcrumbs(),
          candidates: [
            candidate({
              candidateId: alphaCandidateId,
              displayName: "alpha",
              isGitRepository: false,
              isSelectable: true,
            }),
            candidate({
              candidateId: betaCandidateId,
              displayName: "beta",
              isGitRepository: false,
              isSelectable: true,
            }),
          ],
        });
      }
      return browseResult({
        breadcrumbs: [{ label: "example" }],
        candidates: [
          candidate({
            candidateId: projectsCandidateId,
            displayName: "projects",
            isGitRepository: false,
            isSelectable: true,
          }),
        ],
      });
    });

    renderPicker(browse);

    const list = await screen.findByRole("listbox", { name: "Folders" });
    await within(list).findByText("projects");
    await user.click(within(list).getByRole("button", { name: "projects" }));
    expect(await screen.findByText("alpha")).toBeVisible();
    expect(screen.getByText("beta")).toBeVisible();

    await user.type(screen.getByRole("searchbox", { name: "Search folders" }), "alp");
    await waitFor(() =>
      expect(browse).toHaveBeenCalledWith(
        expect.objectContaining({
          parentCandidateId: projectsCandidateId,
          search: "alp",
        }),
      ),
    );
    expect(screen.getByText("alpha")).toBeVisible();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    expect(browse.mock.calls.some((call) => "path" in (call[0] as object))).toBe(false);
  });

  it("navigates breadcrumbs only through server-issued candidates", async () => {
    const user = userEvent.setup();
    const browse = vi.fn(async (input: FolderBrowseRequest) => {
      if (input.parentCandidateId === homeCandidateId) {
        return browseResult({
          breadcrumbs: [{ label: "example" }],
          candidates: [
            candidate({
              candidateId: projectsCandidateId,
              displayName: "projects",
              isGitRepository: false,
              isSelectable: true,
            }),
          ],
        });
      }
      return browseResult({
        breadcrumbs: nestedBreadcrumbs(),
        candidates: [
          candidate({
            candidateId: alphaCandidateId,
            displayName: "alpha",
            isGitRepository: false,
            isSelectable: true,
          }),
        ],
      });
    });

    renderPicker(browse);
    expect(await screen.findByText("alpha")).toBeVisible();

    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).queryByRole("button", { name: "app" })).toBeNull();
    expect(within(nav).getByText("app").closest("[aria-current='page']")).not.toBeNull();

    await user.click(within(nav).getByRole("button", { name: "example" }));
    await waitFor(() => expect(screen.getByText("projects")).toBeVisible());
    expect(browse).toHaveBeenCalledWith(
      expect.objectContaining({ parentCandidateId: homeCandidateId }),
    );
  });

  it("keeps keyboard navigation usable when search matches nothing", async () => {
    const user = userEvent.setup();
    const browse = vi.fn(async (input: FolderBrowseRequest) => {
      if (input.search === "missing") {
        return browseResult({ candidates: [] });
      }
      return browseResult({
        candidates: [
          candidate({
            candidateId: alphaCandidateId,
            displayName: "alpha",
            isGitRepository: false,
            isSelectable: true,
          }),
        ],
      });
    });
    const onCancel = vi.fn();
    render(
      <div style={{ width: 320 }}>
        <FolderPicker
          client={{ browse, select: vi.fn() } as unknown as FolderBrowseClient}
          hostId={hostId}
          mode="work"
          onCancel={onCancel}
          onSelect={vi.fn()}
        />
      </div>,
    );

    expect(await screen.findByText("alpha")).toBeVisible();
    const search = screen.getByRole("searchbox", { name: "Search folders" });
    await user.type(search, "missing");
    expect(await screen.findByText("No folders found.")).toBeVisible();
    expect(search).toBeEnabled();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();

    await user.clear(search);
    expect(await screen.findByText("alpha")).toBeVisible();

    const cancel = screen.getAllByRole("button", { name: "Cancel" }).at(-1);
    expect(cancel).toBeDefined();
    cancel?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it("dismisses the Add folder dialog when the user presses Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <FolderPicker
        client={
          {
            browse: vi.fn(async () => browseResult({ candidates: [] })),
            select: vi.fn(),
          } as unknown as FolderBrowseClient
        }
        hostId={hostId}
        mode="code"
        onCancel={onCancel}
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "Add folder" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });
});

function renderPicker(browse: FolderBrowseClient["browse"]) {
  render(
    <FolderPicker
      client={{ browse, select: vi.fn() } as unknown as FolderBrowseClient}
      hostId={hostId}
      mode="work"
      onCancel={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
}

function nestedBreadcrumbs(): FolderBrowseResult["breadcrumbs"] {
  return [
    { label: "example", candidateId: homeCandidateId as never },
    { label: "projects", candidateId: projectsCandidateId as never },
    { label: "app" },
  ];
}

function browseResult(input: {
  readonly candidates: ReadonlyArray<FolderCandidate>;
  readonly breadcrumbs?: FolderBrowseResult["breadcrumbs"];
}): FolderBrowseResult {
  return {
    breadcrumbs: input.breadcrumbs ?? nestedBreadcrumbs(),
    candidates: input.candidates,
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

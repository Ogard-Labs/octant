import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectId } from "@octant/contracts/projects";
import type { OctantHostBridge } from "../shell/hostBridge";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectCreateDialog } from "./ProjectCreateDialog";

const projectId = "80000000-0000-4000-8000-000000000304" as ProjectId;

function folderBrowseClient(): FolderBrowseClient {
  return {
    browse: vi.fn(async () => ({
      candidates: [
        {
          candidateId: "80000000-0000-4000-8000-000000000305" as never,
          displayName: "knowledge",
          isGitRepository: false,
          isSelectable: true,
        },
      ],
      breadcrumbs: [{ label: "Home" }],
      hasMore: false,
      browsedAt: "2026-07-26T22:00:00.000Z" as never,
    })),
    select: vi.fn(async () => ({
      receiptId: "R".repeat(43),
      displayName: "knowledge",
      selectedAt: "2026-07-26T22:00:01.000Z" as never,
    })),
  };
}

describe("ProjectCreateDialog web folder parity", () => {
  it("opens the FolderPicker for Work without a name-first form when native bridge is absent", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    const client = folderBrowseClient();

    render(
      <ProjectCreateDialog
        folderBrowseClient={client}
        hostId="local"
        mode="work"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );

    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Add folder" })).toBeVisible();
    await screen.findByText("knowledge");
    await user.click(screen.getByRole("button", { name: "Select" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("work", "knowledge", "R".repeat(43)));
    expect(onCreated).toHaveBeenCalledWith(projectId, "work", "knowledge");
  });

  it("shows a closed failure when neither native bridge nor folder browse client is available", () => {
    render(
      <ProjectCreateDialog
        hostId="local"
        mode="code"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByText(/Folder selection is unavailable/i)).toBeVisible();
    expect(screen.queryByLabelText("Project name")).toBeNull();
  });

  it("uses the filled button recipe for Chat Project confirm without a site class", () => {
    render(
      <ProjectCreateDialog mode="chat" onClose={vi.fn()} onCreate={vi.fn()} onCreated={vi.fn()} />,
    );

    const confirm = screen.getByRole("button", { name: "Create Project" });
    expect(confirm.className).toContain("btn-primary");
    expect(confirm.className).not.toContain("project-button");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.className).toContain("btn-ghost");
    expect(cancel.className).not.toContain("project-button");
  });

  it("restores native retry and cancellation after a safe picker failure", async () => {
    const user = userEvent.setup();
    const selectProjectRoot = vi
      .fn()
      .mockRejectedValueOnce(new Error("Choose an accessible directory."))
      .mockResolvedValueOnce({ kind: "cancelled" });
    const hostBridge = { selectProjectRoot } as unknown as OctantHostBridge;
    const onClose = vi.fn();

    render(
      <ProjectCreateDialog
        hostBridge={hostBridge}
        mode="code"
        onClose={onClose}
        onCreate={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText("Choose an accessible directory.")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Create Project" })).toHaveClass(
      "octant-dialog__popup",
      "project-dialog",
    );
    expect(screen.queryByText("CODE")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose a folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    // Backing out of the chooser leaves the dialog as it was: no folder, no
    // complaint. Cancelling a file dialog is not an error to report.
    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await waitFor(() => expect(selectProjectRoot).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Choose a folder" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

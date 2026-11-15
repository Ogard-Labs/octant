import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { CodeProjectCoordinatorWorkerListing } from "./CodeProjectCoordinatorWorkerListing";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const otherProjectId = decodeProjectId("10000000-0000-4000-8000-000000000002");

function controller(settings: Record<string, unknown>) {
  const updateSettings = vi.fn(async () => true);
  return {
    updateSettings,
    controller: {
      status: "ready" as const,
      updateSettings,
      bootstrap: {
        settings: {
          defaultExecutionPolicy: "approval-gated",
          defaultPermissionPersistence: "current-session",
          version: 1,
          updatedAt: "2026-11-15T12:00:00.000Z",
          ...settings,
        },
      },
    } as never,
  };
}

describe("CodeProjectCoordinatorWorkerListing", () => {
  it("uses Settings by default and shows what Settings chose", () => {
    const { controller: code } = controller({
      coordinatorWorkerListing: { sidebar: true, board: false },
    });
    render(<CodeProjectCoordinatorWorkerListing controller={code} projectId={projectId} />);
    expect(screen.getByRole("checkbox", { name: "Use Settings" })).toBeChecked();
    const group = screen.getByRole("group", { name: "Show workers in this Project" });
    expect(within(group).getByRole("checkbox", { name: "In the sidebar" })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "In the sidebar" })).toBeDisabled();
    expect(within(group).getByRole("checkbox", { name: "On the board" })).not.toBeChecked();
  });

  it("gives this Project its own choice that wins over Settings, keeping other Projects' choices", async () => {
    const { controller: code, updateSettings } = controller({
      coordinatorWorkerListing: { sidebar: true, board: false },
      coordinatorWorkerListingByProject: { [otherProjectId]: { sidebar: false, board: true } },
    });
    render(<CodeProjectCoordinatorWorkerListing controller={code} projectId={projectId} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Use Settings" }));
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        coordinatorWorkerListingByProject: {
          [otherProjectId]: { sidebar: false, board: true },
          [projectId]: { sidebar: true, board: false },
        },
      }),
    );
  });

  it("returns to Use Settings by removing this Project's entry", async () => {
    const { controller: code, updateSettings } = controller({
      coordinatorWorkerListingByProject: { [projectId]: { sidebar: false, board: true } },
    });
    render(<CodeProjectCoordinatorWorkerListing controller={code} projectId={projectId} />);
    expect(screen.getByRole("checkbox", { name: "Use Settings" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "Use Settings" }));
    expect(updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ coordinatorWorkerListingByProject: {} }),
    );
  });
});

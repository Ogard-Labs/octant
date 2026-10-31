import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MoveThreadToProjectDialog } from "./MoveThreadToProjectDialog";

const project = (id: string, name: string, folder: string, type: "work" | "code" = "work") =>
  ({
    id,
    name,
    type,
    lifecycle: "active",
    binding: { canonicalRoot: folder },
  }) as never;

const projects = [
  project("p-current", "Reports", "/Users/me/Docs/Reports"),
  project("p-same", "Reports (2)", "/Users/me/Docs/Reports"),
  project("p-parent", "All docs", "/Users/me/Docs"),
  project("p-other", "Taxes", "/Users/me/Taxes"),
  project("p-inside", "Q3", "/Users/me/Docs/Reports/Q3"),
  project("p-code", "App", "/Users/me/Docs/Reports", "code"),
];

function open(overrides: Partial<Parameters<typeof MoveThreadToProjectDialog>[0]> = {}) {
  const onMove = vi.fn(async () => ({ status: "ok" }) as const);
  const onClose = vi.fn();
  render(
    <MoveThreadToProjectDialog
      currentProjectId="p-current"
      mode="work"
      onClose={onClose}
      onMove={onMove}
      projects={projects}
      threadTitle="Draft brief"
      {...overrides}
    />,
  );
  return { onMove, onClose };
}

describe("moving a Work or Code thread to another Project", () => {
  it("offers the Projects of its own kind whose folder is the thread's folder or contains it", async () => {
    const { onMove, onClose } = open();

    expect(screen.getByRole("button", { name: /Reports \(2\)/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /All docs/ })).toBeEnabled();
    expect(screen.queryByText("Reports", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /App/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /All docs/ }));

    expect(onMove).toHaveBeenCalledWith("p-parent");
    expect(onClose).toHaveBeenCalled();
  });

  it("disables a Project bound to a different folder and says why", () => {
    open();

    for (const name of [/Taxes/, /Q3/]) {
      const choice = screen.getByRole("button", { name });
      expect(choice).toBeDisabled();
      expect(choice).toHaveAccessibleDescription(/different folder/);
    }
  });

  it("offers a Code thread only the Projects bound to its own repository folder", () => {
    open({
      mode: "code",
      projects: [
        project("p-current", "App", "/Users/me/app", "code"),
        project("p-same", "App again", "/Users/me/app", "code"),
        project("p-parent", "Everything", "/Users/me", "code"),
      ],
    });

    expect(screen.getByRole("button", { name: /App again/ })).toBeEnabled();
    const parent = screen.getByRole("button", { name: /Everything/ });
    expect(parent).toBeDisabled();
    expect(parent).toHaveAccessibleDescription(/same repository folder/);
  });

  it("keeps the dialog open and shows the host's reason when it refuses the move", async () => {
    const { onClose } = open({
      onMove: vi.fn(async () => ({
        status: "refused" as const,
        message: "Wait for the running turn to finish before moving this thread.",
      })),
    });

    await userEvent.click(screen.getByRole("button", { name: /All docs/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/running turn/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says so when no other Project can take the thread", () => {
    open({ projects: [projects[0]!, projects[5]!] });

    expect(screen.getByText(/no other Work Project/i)).toBeVisible();
  });
});

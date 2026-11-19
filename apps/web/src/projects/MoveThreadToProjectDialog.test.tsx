import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MoveThreadToProjectDialog } from "./MoveThreadToProjectDialog";
import { ProjectIconContext } from "./ProjectIcon";
import { iconSourceFor } from "./projectIcon.test-support";

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

describe("move dialog Project icons", () => {
  it("draws a Project's own icon in its row and the folder glyph for one without", async () => {
    const { source } = iconSourceFor(["p-other"]);
    const onMove = vi.fn(async () => ({ status: "ok" }) as const);
    const { container } = render(
      <ProjectIconContext.Provider value={source}>
        <MoveThreadToProjectDialog
          currentProjectId="p-current"
          mode="work"
          onClose={vi.fn()}
          onMove={onMove}
          projects={projects}
          threadTitle="Draft brief"
        />
      </ProjectIconContext.Provider>,
    );
    await waitFor(() =>
      expect(container.ownerDocument.querySelectorAll("img.project-icon")).toHaveLength(1),
    );
    expect(
      screen.getByRole("button", { name: /Taxes/ }).querySelector("img.project-icon"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /All docs/ }).querySelector("svg.octant-icon-folder"),
    ).not.toBeNull();
  });
});

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

describe("moving a busy thread", () => {
  it("defaults to moving after the current turn and sends that choice", async () => {
    const onMove = vi.fn(async () => ({ status: "ok" }) as const);
    open({ busy: true, onMove });

    expect(screen.getByRole("radio", { name: "Move after this turn" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /All docs/ }));

    expect(onMove).toHaveBeenCalledWith("p-parent", "after-turn");
  });

  it("sends stop-now only when the person picks it", async () => {
    const onMove = vi.fn(async () => ({ status: "ok" }) as const);
    open({ busy: true, onMove });

    await userEvent.click(screen.getByRole("radio", { name: "Stop and move now" }));
    await userEvent.click(screen.getByRole("button", { name: /All docs/ }));

    expect(onMove).toHaveBeenCalledWith("p-parent", "stop-now");
  });

  it("keeps the queued move visible, drops it on Cancel, and shows a refusal on dispatch", async () => {
    let resolveSettled: (outcome: never) => void = () => undefined;
    const cancel = vi.fn(() => resolveSettled({ status: "cancelled" } as never));
    const settled = new Promise((resolve) => {
      resolveSettled = resolve as never;
    });
    const onMove = vi.fn(async () => ({ status: "deferred", settled, cancel }) as never);
    const { onClose } = open({ busy: true, onMove });

    await userEvent.click(screen.getByRole("button", { name: /All docs/ }));
    expect(await screen.findByText(/queued for when this turn finishes/)).toBeVisible();
    expect(screen.getByRole("button", { name: /All docs/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel move" }));
    expect(cancel).toHaveBeenCalledOnce();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("drops the queued move when the dialog is dismissed without cancelling first", async () => {
    const cancel = vi.fn();
    const onMove = vi.fn(
      async () => ({ status: "deferred", settled: new Promise(() => {}), cancel }) as never,
    );
    const { onClose } = open({ busy: true, onMove });

    await userEvent.click(screen.getByRole("button", { name: /All docs/ }));
    expect(await screen.findByText(/queued for when this turn finishes/)).toBeVisible();

    await userEvent.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces the host's refusal when the deferred move dispatches", async () => {
    let resolveSettled: (outcome: never) => void = () => undefined;
    const settled = new Promise((resolve) => {
      resolveSettled = resolve as never;
    });
    const onMove = vi.fn(async () => ({ status: "deferred", settled, cancel: vi.fn() }) as never);
    const { onClose } = open({ busy: true, onMove });

    await userEvent.click(screen.getByRole("button", { name: /All docs/ }));
    resolveSettled({
      status: "refused",
      message: "The thread started another turn; move it when it is idle.",
    } as never);

    expect(await screen.findByRole("alert")).toHaveTextContent(/started another turn/);
    expect(onClose).not.toHaveBeenCalled();
  });
});

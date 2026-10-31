import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatThreadActionsMenu } from "./ChatThreadActionsMenu";

const view = {
  thread: { id: "00000000-0000-4000-8000-000000000901", title: "Launch plan" },
} as never;

describe("handing off a Chat thread from its actions menu", () => {
  it("shows why the host refused and hands nothing to the shell", async () => {
    const user = userEvent.setup();
    const handOffThread = vi.fn(async () => ({ kind: "refused", reason: "turn-running" }) as const);
    const onHandedOff = vi.fn();
    render(
      <ChatThreadActionsMenu
        handOffClient={{ handOffThread }}
        onHandedOff={onHandedOff}
        view={view}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Hand off…" }));
    expect(
      await screen.findByText("Wait for the running turn to finish before handing off."),
    ).toBeVisible();
    expect(handOffThread).toHaveBeenCalledWith({
      mode: "chat",
      threadId: "00000000-0000-4000-8000-000000000901",
    });
    expect(onHandedOff).not.toHaveBeenCalled();
  });

  it("tells the shell which Canvas the host wrote so it can open beside the transcript", async () => {
    const user = userEvent.setup();
    const outcome = {
      kind: "handed-off",
      canvasId: "30000000-0000-4000-8000-000000000001",
      versionId: "30000000-0000-4000-8000-000000000002",
      projectId: "20000000-0000-4000-8000-000000000001",
      title: "Hand-off: Launch plan",
    } as const;
    const onHandedOff = vi.fn();
    render(
      <ChatThreadActionsMenu
        handOffClient={{ handOffThread: vi.fn(async () => outcome as never) }}
        onHandedOff={onHandedOff}
        view={view}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Hand off…" }));
    expect(await screen.findByText("Hand-off: Launch plan is open in the dock.")).toBeVisible();
    expect(onHandedOff).toHaveBeenCalledWith(outcome);
  });

  it("offers no Hand off when this window resolves no hand-off client", async () => {
    const user = userEvent.setup();
    render(<ChatThreadActionsMenu view={view} />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(await screen.findByRole("menuitemradio", { name: "Copy conversation" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "Hand off…" })).toBeNull();
  });
});

describe("moving a No-project Chat thread into a Project from its actions menu", () => {
  const projectId = "20000000-0000-4000-8000-000000000001" as never;
  const projects = [{ id: projectId, name: "Trip planning" }];

  it("moves the thread into the Project the person picks and says it gains no folder access", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn(async () => true);
    render(<ChatThreadActionsMenu moveToProject={{ projects, onMove }} view={view} />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Move to Project…" }));
    expect(await screen.findByText(/gains no folder access/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Trip planning" }));
    expect(onMove).toHaveBeenCalledWith(projectId);
  });

  it("creates a Project and moves the thread into it", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn(async () => true);
    const onCreateProject = vi.fn(async () => projectId);
    render(
      <ChatThreadActionsMenu
        moveToProject={{ projects: [], onCreateProject, onMove }}
        view={view}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Move to Project…" }));
    await user.type(await screen.findByLabelText("New Project name"), "Garden");
    await user.click(screen.getByRole("button", { name: "Create and move" }));
    expect(onCreateProject).toHaveBeenCalledWith("Garden");
    expect(onMove).toHaveBeenCalledWith(projectId);
  });

  it("keeps the dialog open and says nothing changed when the host refuses the move", async () => {
    const user = userEvent.setup();
    render(
      <ChatThreadActionsMenu moveToProject={{ projects, onMove: async () => false }} view={view} />,
    );
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Move to Project…" }));
    await user.click(screen.getByRole("button", { name: "Trip planning" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing changed");
  });

  it("offers no move for a thread that already lives in a Project", async () => {
    const user = userEvent.setup();
    const filed = {
      thread: { ...(view as { thread: object }).thread, projectId },
    } as never;
    render(
      <ChatThreadActionsMenu moveToProject={{ projects, onMove: async () => true }} view={filed} />,
    );
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(await screen.findByRole("menuitemradio", { name: "Copy conversation" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "Move to Project…" })).toBeNull();
  });
});

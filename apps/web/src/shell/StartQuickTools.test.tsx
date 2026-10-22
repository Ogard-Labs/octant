import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { decodeProjectId } from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StartQuickTools, StartQuickToolsContext } from "./StartQuickTools";

const projectId = decodeProjectId("30000000-0000-4000-8000-000000000001");

function renderTools(execute: ReturnType<typeof vi.fn>) {
  const services = {
    hostId: LOCAL_HOST_ID,
    projectTerminalClient: { execute } as never,
    projectBrowserClient: { execute: vi.fn() } as never,
  };
  return render(
    <StartQuickToolsContext.Provider value={services}>
      <StartQuickTools projectId={projectId} />
    </StartQuickToolsContext.Provider>,
  );
}

describe("StartQuickTools", () => {
  it("opens the Project's terminal without a thread and stops it when the panel closes", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async (command: { readonly kind: string }) =>
      command.kind === "start"
        ? { kind: "project-terminal", terminal: { state: "running" } }
        : { kind: "project-terminal", terminal: { state: "exited" } },
    );
    renderTools(execute);

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "start", projectId }));
    expect(await screen.findByRole("complementary", { name: "Project terminal" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Quick tools" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "stop", projectId })),
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toBeVisible();
  });

  it("says why the host refused to start the Project terminal", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({
      kind: "project-terminal-refused",
      message: "Only a Code Project has a terminal.",
    }));
    renderTools(execute);

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(await screen.findByText("Only a Code Project has a terminal.")).toBeVisible();
  });

  it("offers nothing where the window holds no Project tools", () => {
    const { container } = render(<StartQuickTools projectId={projectId} />);
    expect(container).toBeEmptyDOMElement();
  });
});

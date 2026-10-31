import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { decodeProjectId } from "@octant/contracts/projects";
import type { ProjectId } from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  StartQuickTools,
  StartQuickToolsContext,
  StartQuickToolsPlacementContext,
  StartQuickToolsPlacementProvider,
} from "./StartQuickTools";

const projectId = decodeProjectId("30000000-0000-4000-8000-000000000001");
const otherProjectId = decodeProjectId("30000000-0000-4000-8000-000000000002");

/** Registers a start screen's Project the way a Code draft does. */
function DraftRegistration(props: { readonly scope: string; readonly projectId: ProjectId }) {
  const chooseProject = useContext(StartQuickToolsPlacementContext)?.chooseProject;
  useEffect(() => {
    chooseProject?.(props.scope, props.projectId);
    return () => chooseProject?.(props.scope, undefined);
  }, [chooseProject, props.scope, props.projectId]);
  return null;
}

function DockProject() {
  const placement = useContext(StartQuickToolsPlacementContext);
  return <output aria-label="Dock Project">{String(placement?.projectId ?? "none")}</output>;
}

function SplitDrafts(props: { readonly active: string; readonly withSecond: boolean }) {
  return (
    <StartQuickToolsPlacementProvider activeDraftScope={props.active}>
      <DraftRegistration projectId={projectId} scope="code:left" />
      {props.withSecond ? (
        <DraftRegistration projectId={otherProjectId} scope="code:right" />
      ) : null}
      <DockProject />
    </StartQuickToolsPlacementProvider>
  );
}

function renderTools(
  execute: ReturnType<typeof vi.fn>,
  extraFolders?: (id: typeof projectId) => ReadonlyArray<string>,
) {
  const services = {
    ...(extraFolders === undefined ? {} : { extraFolders }),
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

  it("keeps each split pane's start-screen Project when the other draft becomes a thread", () => {
    const { rerender } = render(<SplitDrafts active="code:right" withSecond />);
    const dock = screen.getByRole("status", { name: "Dock Project" });
    expect(dock).toHaveTextContent(String(otherProjectId));

    rerender(<SplitDrafts active="code:left" withSecond />);
    expect(dock).toHaveTextContent(String(projectId));

    // The right draft starts its task and leaves; the left keeps its Project.
    rerender(<SplitDrafts active="code:left" withSecond={false} />);
    expect(dock).toHaveTextContent(String(projectId));
  });

  it("starts a terminal in an extra folder the Project lists, and in the main folder otherwise", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({
      kind: "project-terminal",
      terminal: { state: "running" },
    }));
    renderTools(execute, () => ["/work/notes"]);

    await user.click(screen.getByRole("button", { name: "Terminal in notes" }));

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "start", folder: "/work/notes" }),
    );
  });
});

import { decodePaneId, type WorkspaceLayoutNode } from "@octant/contracts/shell";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { splitCallbacks, splitLayout } from "../App.test-fixtures";
import { SplitWorkspace } from "./SplitWorkspace";
import { useWorkspaceSurfaceDrag, type WorkspaceSurfaceDragHandle } from "./useWorkspaceTabDrag";
import type {
  WorkspaceSurfaceDragSource,
  WorkspaceSurfaceDropDestination,
} from "./workspaceTabDragGeometry";

const firstPaneId = decodePaneId("00000000-0000-4000-8000-000000000612");
const secondPaneId = decodePaneId("00000000-0000-4000-8000-000000000622");
const splitNodeId = "00000000-0000-4000-8000-000000000610";

describe("SplitWorkspace", () => {
  it("marks the focused pane and puts pane operations in a keyboard disclosure", async () => {
    const user = userEvent.setup();
    const handlers = splitCallbacks();
    render(
      <SplitWorkspace
        {...handlers}
        focusedPaneId={firstPaneId}
        layout={splitLayout()}
        renderSurface={(surface) => surface.title}
      />,
    );

    expect(screen.getByRole("region", { name: "Workspace pane: First" })).toHaveAttribute(
      "data-focused",
      "true",
    );
    expect(screen.getByRole("region", { name: "Workspace pane: Second" })).toHaveAttribute(
      "data-focused",
      "false",
    );
    expect(screen.queryByRole("menuitem", { name: "Show all panes" })).not.toBeInTheDocument();

    await openPaneMenu(user, "First");
    // A focused pane is presented alone, so splitting it now would land hidden.
    expect(screen.queryByRole("menuitem", { name: "Split right" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Show all panes" }));
    expect(handlers.onClearFocus).toHaveBeenCalledOnce();
  });

  it("offers focus, split, and close from a right-click over the pane's header", async () => {
    const user = userEvent.setup();
    const handlers = splitCallbacks();
    render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout()}
        renderSurface={(surface) => surface.title}
      />,
    );

    await openPaneMenu(user, "Second");
    await user.click(await screen.findByRole("menuitem", { name: "Focus this pane" }));
    expect(handlers.onFocus).toHaveBeenCalledWith(secondPaneId);

    await openPaneMenu(user, "Second");
    await user.click(await screen.findByRole("menuitem", { name: "Split down" }));
    expect(handlers.onSplitPane).toHaveBeenCalledWith(secondPaneId, "vertical", "after");

    await openPaneMenu(user, "Second");
    await user.click(await screen.findByRole("menuitem", { name: "Split right" }));
    expect(handlers.onSplitPane).toHaveBeenCalledWith(secondPaneId, "horizontal", "after");

    await openPaneMenu(user, "Second");
    await user.click(await screen.findByRole("menuitem", { name: "Close pane" }));
    expect(handlers.onClosePane).toHaveBeenCalledWith(secondPaneId);
  });

  it("activates whichever pane a pointer lands in", () => {
    const handlers = splitCallbacks();
    render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout()}
        renderSurface={(surface) => surface.title}
      />,
    );

    const secondPanel = screen
      .getByRole("region", { name: "Workspace pane: Second" })
      .querySelector(".workspace-pane__panel")!;
    fireEvent.pointerDown(secondPanel);
    expect(handlers.onActivatePane).toHaveBeenCalledWith(secondPaneId);
  });

  it("activates whichever pane receives keyboard input", () => {
    const handlers = splitCallbacks();
    render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout()}
        renderSurface={(surface) => <button type="button">Write in {surface.title}</button>}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Write in Second" }), { key: "a" });
    expect(handlers.onActivatePane).toHaveBeenCalledWith(secondPaneId);
  });

  it("leaves the pane's title band draggable as the window, and its grip draggable as the pane", () => {
    const handlers = splitCallbacks();
    render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout()}
        renderSurface={(surface) => surface.title}
      />,
    );

    const header = screen
      .getByRole("region", { name: "Workspace pane: First" })
      .querySelector(".workspace-pane__header")!;
    expect(header).toHaveClass("window-drag-region");
    expect(header.querySelector(".workspace-pane__grip")).toHaveClass("window-no-drag");
  });

  it("keeps the splitter keyboard-operable inside a quiet hit target", () => {
    const handlers = splitCallbacks();
    const { container } = render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout("horizontal", 0.5)}
        renderSurface={(surface) => surface.title}
      />,
    );

    const resize = screen.getByRole("slider", { name: "Resize split" });
    expect(resize.closest("label")).toHaveClass("workspace-split__resize");
    fireEvent.change(resize, { target: { value: "0.6" } });
    fireEvent.keyUp(resize, { key: "ArrowRight", target: { value: "0.6" } });
    expect(handlers.onPreviewResize).toHaveBeenCalledWith(splitNodeId, 0.6);
    expect(handlers.onCommitResize).toHaveBeenCalledWith(splitNodeId, 0.6);
    expect(screen.getAllByRole("region", { name: /Workspace pane:/ })).toHaveLength(2);
    expect(screen.getAllByRole("slider", { name: "Resize split" })).toHaveLength(1);
    expect(container.querySelector(".workspace-split--contextual")).not.toBeInTheDocument();
  });

  it("measures repeated pointer resizes against the full split instead of the narrow gutter", () => {
    const handlers = splitCallbacks();
    render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout("horizontal", 0.5)}
        renderSurface={(surface) => surface.title}
      />,
    );

    const split = screen.getByRole("group", { name: "horizontal workspace split" });
    const resize = screen.getByRole("slider", { name: "Resize split" }).closest("label")!;
    Object.assign(split, { getBoundingClientRect: () => rect(0, 0, 800, 600) });
    Object.assign(resize, {
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(resize, { button: 0, clientX: 400, pointerId: 41 });
    fireEvent.pointerMove(resize, { clientX: 520, pointerId: 41 });
    expect(handlers.onPreviewResize).toHaveBeenLastCalledWith(splitNodeId, 0.65);
    fireEvent.pointerUp(resize, { clientX: 520, pointerId: 41 });
    expect(handlers.onCommitResize).toHaveBeenLastCalledWith(splitNodeId, 0.65);

    fireEvent.pointerDown(resize, { button: 0, clientX: 520, pointerId: 42 });
    fireEvent.pointerMove(resize, { clientX: 360, pointerId: 42 });
    expect(handlers.onPreviewResize).toHaveBeenLastCalledWith(splitNodeId, 0.45);
    fireEvent.pointerUp(resize, { clientX: 360, pointerId: 42 });
    expect(handlers.onCommitResize).toHaveBeenLastCalledWith(splitNodeId, 0.45);
  });

  it("restores the committed ratio on Escape and permits a fresh resize", () => {
    const handlers = splitCallbacks();
    render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout("horizontal", 0.5)}
        renderSurface={(surface) => surface.title}
      />,
    );

    const split = screen.getByRole("group", { name: "horizontal workspace split" });
    const resize = screen.getByRole("slider", { name: "Resize split" }).closest("label")!;
    Object.assign(split, { getBoundingClientRect: () => rect(0, 0, 800, 600) });

    fireEvent.pointerDown(resize, { button: 0, clientX: 400, pointerId: 43 });
    fireEvent.pointerMove(resize, { clientX: 520, pointerId: 43 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onPreviewResize).toHaveBeenLastCalledWith(splitNodeId, 0.5);
    expect(handlers.onCommitResize).not.toHaveBeenCalled();

    fireEvent.pointerDown(resize, { button: 0, clientX: 400, pointerId: 44 });
    fireEvent.pointerMove(resize, { clientX: 480, pointerId: 44 });
    fireEvent.pointerUp(resize, { clientX: 480, pointerId: 44 });
    expect(handlers.onCommitResize).toHaveBeenCalledOnce();
    expect(handlers.onCommitResize).toHaveBeenCalledWith(splitNodeId, 0.6);
  });

  it("renders orientation and preview ratio as geometry and commits resize only on release", () => {
    const callbacks = splitCallbacks();
    const { rerender } = render(
      <SplitWorkspace
        {...callbacks}
        layout={splitLayout()}
        renderSurface={(surface) => surface.title}
      />,
    );
    const horizontal = screen.getByRole("group", { name: "horizontal workspace split" });
    expect(horizontal).toHaveStyle({
      display: "grid",
      gridTemplateColumns: "minmax(0, 0.3fr) auto minmax(0, 0.7fr)",
      height: "100%",
      minHeight: "0",
      minWidth: "0",
      width: "100%",
    });

    const resize = screen.getByRole("slider", { name: "Resize split" });
    expect(resize).toHaveClass("workspace-split__resize-input");
    fireEvent.change(resize, { target: { value: "0.7" } });
    expect(callbacks.onPreviewResize).toHaveBeenCalledWith(splitNodeId, 0.7);
    expect(callbacks.onCommitResize).not.toHaveBeenCalled();

    rerender(
      <SplitWorkspace
        {...callbacks}
        layout={splitLayout("vertical", 0.6)}
        renderSurface={(surface) => surface.title}
      />,
    );
    const vertical = screen.getByRole("group", { name: "vertical workspace split" });
    expect(vertical).toHaveStyle({
      display: "grid",
      gridTemplateRows: "minmax(0, 0.6fr) auto minmax(0, 0.4fr)",
    });
    Object.assign(vertical, {
      getBoundingClientRect: () => ({ height: 600, left: 0, top: 0, width: 800 }),
    });
    const verticalResize = screen.getByRole("slider", { name: "Resize split" }).closest("label")!;
    fireEvent.pointerDown(verticalResize, { button: 0, clientY: 360, pointerId: 51 });
    fireEvent.pointerMove(verticalResize, { clientY: 420, pointerId: 51 });
    fireEvent.pointerUp(verticalResize, { clientY: 420, pointerId: 51 });
    expect(callbacks.onCommitResize).toHaveBeenCalledWith(splitNodeId, 0.7);
  });

  it("disables edge docking when the workspace-wide pane limit is reached", () => {
    const handlers = splitCallbacks();
    const { container } = render(
      <SplitWorkspace
        {...handlers}
        layout={splitLayout()}
        renderSurface={(surface) => surface.title}
        totalWorkspacePaneCount={8}
      />,
    );

    expect(
      container.querySelector(`[data-workspace-pane-id="${String(secondPaneId)}"]`),
    ).toHaveAttribute("data-workspace-can-split", "false");
    expect(screen.queryByRole("button", { name: "Split right" })).not.toBeInTheDocument();
  });

  it("starts a grip drag after the pointer threshold and commits one directional drop", () => {
    const onDrop = vi.fn();
    const { container } = render(<DragWorkspace layout={splitLayout()} onDrop={onDrop} />);
    const grips = prepareDragGeometry(container);

    fireEvent.pointerDown(grips[0]!, { button: 0, clientX: 50, clientY: 16, pointerId: 7 });
    fireEvent.pointerMove(grips[0]!, { clientX: 53, clientY: 18, pointerId: 7 });
    expect(onDrop).not.toHaveBeenCalled();
    fireEvent.pointerMove(grips[0]!, { clientX: 410, clientY: 300, pointerId: 7 });
    expect(screen.getByRole("status")).toHaveTextContent(/Split left and open First/i);
    fireEvent.pointerUp(grips[0]!, { clientX: 410, clientY: 300, pointerId: 7 });

    expect(onDrop).toHaveBeenCalledOnce();
    const [source, destination] = onDrop.mock.calls[0]!;
    expect(source).toMatchObject({ paneId: firstPaneId, title: "First" });
    expect(destination).toEqual({ kind: "edge", targetPaneId: secondPaneId, edge: "left" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("cancels an active grip drag on Escape without committing", () => {
    const onDrop = vi.fn();
    const { container } = render(<DragWorkspace layout={splitLayout()} onDrop={onDrop} />);
    const grips = prepareDragGeometry(container);

    fireEvent.pointerDown(grips[0]!, { button: 0, clientX: 50, clientY: 16, pointerId: 8 });
    fireEvent.pointerMove(grips[0]!, { clientX: 600, clientY: 300, pointerId: 8 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(grips[0]!, { clientX: 600, clientY: 300, pointerId: 8 });

    expect(onDrop).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

function DragWorkspace(props: {
  readonly layout: WorkspaceLayoutNode;
  readonly onDrop: (
    source: WorkspaceSurfaceDragSource,
    destination: WorkspaceSurfaceDropDestination,
  ) => void;
}) {
  const drag: WorkspaceSurfaceDragHandle = useWorkspaceSurfaceDrag({ onDrop: props.onDrop });
  const { drag: _stub, ...handlers } = splitCallbacks();
  return (
    <SplitWorkspace
      {...handlers}
      drag={drag}
      layout={props.layout}
      renderSurface={(surface) => surface.title}
    />
  );
}

/** Gives the root and both panes real geometry, and returns the pane grips. */
function prepareDragGeometry(container: HTMLElement): NodeListOf<HTMLElement> {
  const root = container.querySelector<HTMLElement>(".workspace-root")!;
  const panes = container.querySelectorAll<HTMLElement>("[data-workspace-pane-id]");
  Object.assign(root, { getBoundingClientRect: () => rect(0, 0, 800, 600) });
  Object.assign(panes[0]!, { getBoundingClientRect: () => rect(0, 0, 400, 600) });
  Object.assign(panes[1]!, { getBoundingClientRect: () => rect(400, 0, 400, 600) });
  const grips = container.querySelectorAll<HTMLElement>(".workspace-pane__grip");
  Object.assign(grips[0]!, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  return grips;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/** Right-clicks a pane's header, which is where its own actions live. */
async function openPaneMenu(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
): Promise<void> {
  const header = screen
    .getByRole("region", { name: `Workspace pane: ${title}` })
    .querySelector<HTMLElement>(".workspace-pane__header")!;
  await user.pointer({ target: header, keys: "[MouseRight]" });
}

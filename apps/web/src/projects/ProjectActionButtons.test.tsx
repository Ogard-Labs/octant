import { decodeProjectAction } from "@octant/contracts/projects";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectActionButtons } from "./ProjectActionButtons";

const action = (name: string) =>
  decodeProjectAction({
    id: crypto.randomUUID(),
    name,
    command: `bun run ${name.toLowerCase()}`,
    directory: ".",
  });

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function slot() {
  const host = document.createElement("span");
  host.setAttribute("data-octant-project-actions", "");
  document.body.append(host);
  return host;
}

describe("Project action buttons", () => {
  it("runs the action whose button the person presses", async () => {
    const onRun = vi.fn();
    const dev = action("Dev");
    const host = slot();
    render(<ProjectActionButtons actions={[dev, action("Test")]} onRun={onRun} />);

    await userEvent.click(within(host).getByRole("button", { name: "Dev" }));

    expect(onRun).toHaveBeenCalledWith(dev);
  });

  it("moves actions past the third into a menu", () => {
    const host = slot();
    render(
      <ProjectActionButtons actions={["Run", "Test", "Dev", "Lint"].map(action)} onRun={vi.fn()} />,
    );

    expect(within(host).queryByRole("button", { name: "Lint" })).toBeNull();
    expect(within(host).getByRole("button", { name: "More Project actions" })).toBeVisible();
  });

  it("draws nothing where the header has no slot for it", () => {
    const { container } = render(
      <ProjectActionButtons actions={[action("Dev")]} onRun={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("group", { name: "Project actions" })).toBeNull();
  });

  it("offers a folder choice only when the Project has an extra folder, and runs there", async () => {
    const onRun = vi.fn();
    const dev = action("Dev");
    const host = slot();
    const { rerender } = render(
      <ProjectActionButtons actions={[dev]} mainFolder="/work/app" onRun={onRun} />,
    );
    expect(within(host).queryByRole("button", { name: "Folder to run actions in" })).toBeNull();

    rerender(
      <ProjectActionButtons
        actions={[dev]}
        extraFolders={["/work/notes"]}
        mainFolder="/work/app"
        onRun={onRun}
      />,
    );
    await userEvent.click(within(host).getByRole("button", { name: "Dev" }));
    expect(onRun).toHaveBeenLastCalledWith(dev);

    await userEvent.click(within(host).getByRole("button", { name: "Folder to run actions in" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "notes" }));
    await userEvent.click(within(host).getByRole("button", { name: "Dev" }));
    expect(onRun).toHaveBeenLastCalledWith(dev, "/work/notes");
  });
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceTabLauncher } from "./WorkspaceTabLauncher";
import type { WorkspaceSurfaceCatalog } from "@octant/contracts";

const catalog: WorkspaceSurfaceCatalog = {
  chat: [
    { kind: "thread", label: "Thread", available: true },
    { kind: "side-chat", label: "Side Chat", available: true },
    { kind: "browser", label: "Browser", available: false, unavailableReason: "Open a Project." },
  ],
  work: [
    { kind: "thread", label: "Thread", available: true },
    { kind: "side-chat", label: "Side Chat", available: true },
    { kind: "browser", label: "Browser", available: true },
  ],
  code: [
    { kind: "thread", label: "Thread", available: true },
    { kind: "side-chat", label: "Side Chat", available: true },
    { kind: "browser", label: "Browser", available: true },
    { kind: "files", label: "Files", available: true },
    { kind: "terminal", label: "Terminal", available: true },
  ],
};

describe("WorkspaceTabLauncher", () => {
  it("lists only available surfaces for the active mode and opens one on selection", () => {
    const onOpenSurface = vi.fn();
    render(<WorkspaceTabLauncher catalog={catalog} mode="work" onOpenSurface={onOpenSurface} />);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    const items = screen
      .getAllByRole("button")
      .filter(
        (el) =>
          el.textContent !== null &&
          el.textContent.trim() !== "" &&
          el.textContent.trim() !== "New tab",
      );
    expect(items.map((el) => el.textContent?.trim())).toEqual(["Thread", "Side Chat", "Browser"]);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(onOpenSurface).toHaveBeenCalledWith("browser");
  });

  it("disables the trigger when no surfaces are available", () => {
    const onOpenSurface = vi.fn();
    const empty: WorkspaceSurfaceCatalog = {
      chat: [
        { kind: "thread", label: "Thread", available: false, unavailableReason: "Unavailable." },
      ],
      work: [],
      code: [],
    };
    render(<WorkspaceTabLauncher catalog={empty} mode="chat" onOpenSurface={onOpenSurface} />);
    expect(screen.getByRole("button", { name: "New tab" })).toBeDisabled();
  });

  it("does not offer Browser without an exact owning thread", () => {
    render(
      <WorkspaceTabLauncher
        catalog={catalog}
        mode="code"
        onOpenSurface={vi.fn()}
        owningThreadAvailable={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(screen.queryByRole("button", { name: "Browser" })).not.toBeInTheDocument();
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("WorkspaceTabLauncher", () => {
  it("opens its disclosure into the workspace instead of under the clipped sidebar edge", () => {
    const rule = styles.match(/\.workspace-tab-launcher__disclosure\s*{([^}]*)}/)?.[1] ?? "";
    expect(rule).toContain("left: 0;");
    expect(rule).toContain("right: auto;");
  });

  it("lists only available surfaces for the active mode and opens one on selection", () => {
    const onOpenSurface = vi.fn();
    render(<WorkspaceTabLauncher catalog={catalog} mode="work" onOpenSurface={onOpenSurface} />);
    fireEvent.click(screen.getByRole("button", { name: "Open surface" }));
    const items = screen
      .getAllByRole("button")
      .filter(
        (el) =>
          el.textContent !== null &&
          el.textContent.trim() !== "" &&
          el.textContent.trim() !== "Open surface",
      );
    expect(items.map((el) => el.textContent?.trim())).toEqual(["Thread", "Side Chat", "Browser"]);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(onOpenSurface).toHaveBeenCalledWith("browser");
  });

  it("offers the Code thread's own surfaces beside the ones the host catalogs", () => {
    const onOpenThreadSurface = vi.fn();
    render(
      <WorkspaceTabLauncher
        catalog={catalog}
        mode="code"
        onOpenSurface={vi.fn()}
        onOpenThreadSurface={onOpenThreadSurface}
        threadSurfaces={[
          { kind: "code-diff", label: "Changes" },
          { kind: "code-terminal", label: "Terminal" },
          { kind: "code-test", label: "Tests" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open surface" }));
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(onOpenThreadSurface).toHaveBeenCalledWith("code-test");
  });

  it("offers no thread surfaces when the pane is not showing a Code thread", () => {
    render(
      <WorkspaceTabLauncher
        catalog={catalog}
        mode="code"
        onOpenSurface={vi.fn()}
        threadSurfaces={[{ kind: "code-diff", label: "Changes" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open surface" }));
    expect(screen.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Open surface" })).toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: "Open surface" }));
    expect(screen.queryByRole("button", { name: "Browser" })).not.toBeInTheDocument();
  });
});

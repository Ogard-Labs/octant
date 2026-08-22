import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RIGHT_UTILITY_DOCK_SURFACES } from "./rightUtilityDockModel";
import { RightUtilityDockSurface } from "./RightUtilityDockSurface";

const browser = surface("browser");
const terminal = surface("terminal");

function surface(id: "browser" | "terminal") {
  const found = RIGHT_UTILITY_DOCK_SURFACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${id} dock surface.`);
  return found;
}

describe("the right sidebar surface", () => {
  it("keeps the summary and launcher visible with no utility tab open", () => {
    render(
      <RightUtilityDockSurface
        launchableSurfaces={[browser, terminal]}
        navigator={null}
        onCloseTab={vi.fn()}
        onOpenTab={vi.fn()}
        onSelectSurface={vi.fn()}
        projectMemory={null}
        resolution={{ kind: "closed", reason: "no-surface" }}
        summary={<p>Thread context summary</p>}
        tabs={[]}
      />,
    );

    expect(screen.getByText("Thread context summary")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add utility tab" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No utility open" })).toBeVisible();
  });

  it("selects and closes open tabs without hiding the sidebar launcher", async () => {
    const user = userEvent.setup();
    const onCloseTab = vi.fn();
    const onSelectSurface = vi.fn();
    render(
      <RightUtilityDockSurface
        browser={<p>Live Browser</p>}
        launchableSurfaces={[browser, terminal]}
        navigator={null}
        onCloseTab={onCloseTab}
        onOpenTab={vi.fn()}
        onSelectSurface={onSelectSurface}
        projectMemory={null}
        resolution={{ kind: "surface", surface: browser }}
        summary={<p>Thread context summary</p>}
        tabs={[browser, terminal]}
      />,
    );

    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Live Browser")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(onSelectSurface).toHaveBeenCalledWith("terminal");
    await user.click(screen.getByRole("button", { name: "Close Browser tab" }));
    expect(onCloseTab).toHaveBeenCalledWith("browser");
    expect(screen.getByRole("button", { name: "Add utility tab" })).toBeVisible();
  });

  it("never renders the previous tab's content for an unavailable active thread", () => {
    render(
      <RightUtilityDockSurface
        browser={<p>Previous thread Browser</p>}
        launchableSurfaces={[browser]}
        navigator={null}
        onCloseTab={vi.fn()}
        onOpenTab={vi.fn()}
        onSelectSurface={vi.fn()}
        projectMemory={null}
        resolution={{ kind: "unavailable", reason: "thread-required", surface: browser }}
        summary={<p>New thread summary</p>}
        tabs={[browser]}
      />,
    );

    expect(screen.queryByText("Previous thread Browser")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Browser has nothing to describe here" }),
    ).toBeVisible();
  });
});

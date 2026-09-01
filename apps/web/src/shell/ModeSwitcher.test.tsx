import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModeSwitcher } from "./ModeSwitcher";

const modeStyles = readFileSync(resolve(process.cwd(), "src/styles/octant.css"), "utf8");

function cssRule(selector: string): string {
  const match = modeStyles.match(
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
  );
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("ModeSwitcher", () => {
  it("renders ordered compact buttons, omits unavailable modes, and avoids redundant commands", async () => {
    const user = userEvent.setup();
    const onSelectMode = vi.fn();
    render(
      <ModeSwitcher
        activeMode="code"
        modes={["code", "chat"]}
        onSelectMode={onSelectMode}
        presentation="buttons"
      />,
    );

    const group = screen.getByRole("group", { name: "Workspace mode" });
    const buttons = screen.getAllByRole("button");
    expect(group).toHaveClass("modeswitch", "window-no-drag");
    expect(group).toHaveAttribute("data-oct-modeswitch", "icons");
    expect(buttons.map((button) => button.textContent)).toEqual(["Chat", "Code"]);
    expect(screen.queryByRole("button", { name: "Work" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Octant")).toHaveClass("mode-switcher__brand");
    expect(screen.getByRole("button", { name: "Chat" })).not.toHaveAttribute("aria-current");
    const iconFrames = group.querySelectorAll(".mode__icon-frame");
    expect(iconFrames).toHaveLength(2);
    for (const frame of iconFrames) {
      expect(frame).toContainElement(frame.querySelector("svg.icon"));
    }
    expect(cssRule(".mode__icon-frame")).toContain("place-items: center;");
    expect(cssRule(".mode__icon-frame")).toContain("width: 20px;");
    expect(cssRule(".mode__icon-frame")).toContain("height: 20px;");
    expect(cssRule(".mode__icon-frame > .icon")).toContain("width: 16px;");
    expect(cssRule(".mode__icon-frame > .icon")).toContain("height: 16px;");

    await user.click(screen.getByRole("button", { name: "Code" }));
    expect(onSelectMode).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(onSelectMode).toHaveBeenCalledOnce();
    expect(onSelectMode).toHaveBeenCalledWith("chat");
  });

  it("renders the active mode trigger and truthful ordered radio items", async () => {
    const user = userEvent.setup();
    const onSelectMode = vi.fn();
    render(
      <ModeSwitcher
        activeMode="code"
        modes={["code", "chat", "work"]}
        onSelectMode={onSelectMode}
        presentation="dropdown"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Workspace mode, Code" });
    expect(trigger).toHaveTextContent(/Octant.*Code/);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveClass("mode-trigger", "window-no-drag");
    trigger.focus();
    await user.keyboard("{Enter}");

    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/Chat.*Conversation with shared virtual context/),
      expect.stringMatching(/Work.*Work with local files and documents/),
      expect.stringMatching(/Code.*Build, debug, and ship software/),
    ]);
    expect(screen.getByRole("menuitemradio", { name: "Code" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // The name is the visible label alone; the one-line help is a description.
    expect(screen.getByRole("menuitemradio", { name: "Work" })).toHaveAccessibleDescription(
      "Work with local files and documents",
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Code" }).querySelector(".octant-menu__indicator"),
    ).toBeVisible();

    await user.click(screen.getByRole("menuitemradio", { name: "Code" }));
    expect(onSelectMode).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitemradio", { name: "Chat" }));
    expect(onSelectMode).toHaveBeenCalledOnce();
    expect(onSelectMode).toHaveBeenCalledWith("chat");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("omits unavailable modes from the dropdown", async () => {
    const user = userEvent.setup();
    render(
      <ModeSwitcher
        activeMode="code"
        modes={["code"]}
        onSelectMode={vi.fn()}
        presentation="dropdown"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Workspace mode, Code" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menuitemradio", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Work" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Code" })).toBeVisible();
  });

  it("places optional chrome actions beside the mode switcher", () => {
    render(
      <ModeSwitcher
        actions={<button type="button">Search</button>}
        activeMode="code"
        modes={["code", "chat"]}
        onSelectMode={vi.fn()}
        presentation="buttons"
      />,
    );

    const chrome = screen.getByRole("group", { name: "Workspace mode" }).parentElement;
    expect(chrome).toHaveClass("sidebar__chrome");
    expect(chrome).toContainElement(screen.getByRole("button", { name: "Search" }));
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DockToolButtons } from "./DockToolButtons";
import type { DockToolButton, DockToolButtonsModel } from "./dockToolButtonsModel";

function button(
  id: DockToolButton["id"],
  label: string,
  overrides: Partial<DockToolButton> = {},
): DockToolButton {
  return { id, label, pressed: false, open: false, press: { kind: "open-beside" }, ...overrides };
}

const model = (overrides: Partial<DockToolButtonsModel> = {}): DockToolButtonsModel => ({
  buttons: [
    button("environment", "Environment"),
    button("terminal", "Terminal"),
    button("files", "Files", { pressed: true }),
  ],
  more: [button("plan", "Plan"), button("tests", "Tests", { pressed: true })],
  ...overrides,
});

describe("the title band's tool buttons", () => {
  it("names each button for its tool and reports whether the tool is on screen", () => {
    render(<DockToolButtons model={model()} onPress={vi.fn()} />);
    const toolbar = screen.getByRole("toolbar", { name: "Tools" });
    expect(within(toolbar).getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(toolbar).getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(toolbar).getByRole("button", { name: "More tools" })).toBeInTheDocument();
  });

  it("describes a tool that is open but off screen", () => {
    render(
      <DockToolButtons
        model={model({ buttons: [button("files", "Files", { open: true })], more: [] })}
        onPress={vi.fn()}
      />,
    );
    const files = screen.getByRole("button", { name: "Files" });
    expect(files).toHaveAttribute("aria-pressed", "false");
    expect(files).toHaveAttribute("aria-description", "Open");
  });

  it("hands a press to the dock with the button as the opener", async () => {
    const onPress = vi.fn();
    render(<DockToolButtons model={model()} onPress={onPress} />);
    const terminal = screen.getByRole("button", { name: "Terminal" });
    await userEvent.click(terminal);
    expect(onPress).toHaveBeenCalledWith("terminal", terminal);
  });

  it("keeps a disabled button focusable, says why, and ignores a press", async () => {
    const onPress = vi.fn();
    render(
      <DockToolButtons
        model={model({
          buttons: [
            button("environment", "Environment", {
              disabledReason: "Available once the task starts",
              press: { kind: "refused" },
            }),
          ],
          more: [],
        })}
        onPress={onPress}
      />,
    );
    const environment = screen.getByRole("button", { name: "Environment" });
    expect(environment).toHaveAttribute("aria-disabled", "true");
    expect(environment).toHaveAttribute("aria-description", "Available once the task starts");
    await userEvent.click(environment);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("is one Tab stop whose arrow keys move between the buttons", async () => {
    const user = userEvent.setup();
    render(<DockToolButtons model={model()} onPress={vi.fn()} />);
    const buttons = within(screen.getByRole("toolbar")).getAllByRole("button");
    expect(buttons.map((item) => item.tabIndex)).toEqual([0, -1, -1, -1]);

    await user.tab();
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    expect(buttons.map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1]);
    await user.keyboard("{End}");
    expect(buttons[3]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(buttons[3]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(buttons[0]).toHaveFocus();
  });

  it("lists the other tools in More, checked while shown, and toggles one on a press", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    render(<DockToolButtons model={model()} onPress={onPress} />);
    const more = screen.getByRole("button", { name: "More tools" });
    expect(more).toHaveAttribute("data-dock-tools-shown", "true");
    await user.click(more);
    const menu = await screen.findByRole("menu", { name: "More tools" });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Tests" })).toBeChecked();
    const plan = within(menu).getByRole("menuitemcheckbox", { name: "Plan" });
    expect(plan).not.toBeChecked();
    // Two groups: headed, and parted by a hairline.
    expect(within(menu).getByText("Thread tools")).toBeVisible();
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    await user.click(plan);
    expect(onPress).toHaveBeenCalledWith("plan", more);
  });

  it("lists a single group of tools without a heading or a hairline", async () => {
    const user = userEvent.setup();
    render(
      <DockToolButtons
        model={model({ more: [button("plan", "Plan"), button("side-chat", "Side Chat")] })}
        onPress={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "More tools" }));
    const menu = await screen.findByRole("menu", { name: "More tools" });
    expect(within(menu).queryByText("Thread tools")).toBeNull();
    expect(within(menu).queryByRole("separator")).toBeNull();
  });

  it("renders nothing when no tool is available", () => {
    render(<DockToolButtons model={{ buttons: [], more: [] }} onPress={vi.fn()} />);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });
});

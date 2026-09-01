import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  OctantMenu,
  OctantMenuCheckboxItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuSub,
  OctantMenuSubPopup,
  OctantMenuSubTrigger,
  OctantMenuTrigger,
} from "./OctantMenu";

describe("OctantMenu", () => {
  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
    ["ArrowUp", "{ArrowUp}"],
  ])("opens from the trigger with %s", async (_keyName, key) => {
    const user = userEvent.setup();
    render(
      <OctantMenu
        items={[
          { label: "First", value: "first" },
          { label: "Second", value: "second" },
        ]}
        onValueChange={vi.fn()}
        trigger={<span>First</span>}
        triggerLabel="Choose item, First"
        value="first"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Choose item, First" });

    trigger.focus();
    await user.keyboard(key);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", {
          name: key === "{ArrowUp}" ? "Second" : "First",
        }),
      ).toHaveFocus(),
    );
  });

  it("exposes radio selection, keyboard navigation, dismissal, and restored trigger focus", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <OctantMenu
        items={[
          { description: "First description", label: "First", value: "first" },
          { description: "Second description", label: "Second", value: "second" },
          { description: "Third description", label: "Third", value: "third" },
        ]}
        onValueChange={onValueChange}
        trigger={<span>First</span>}
        triggerLabel="Choose item, First"
        value="first"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Choose item, First" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "First" })).toHaveFocus());
    await user.keyboard("{End}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Third" })).toHaveFocus());
    await user.keyboard("{Home}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "First" })).toHaveFocus());
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Third" })).toHaveFocus());
    await user.keyboard(" ");
    expect(onValueChange).toHaveBeenCalledWith("third");
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitemradio", { name: "First" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowDown}");
    await user.click(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body).toHaveFocus();
  });

  it("exposes checkbox, separator, and submenu items to keyboard and assistive tech", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const onValueChange = vi.fn();
    render(
      <OctantMenuRoot>
        <OctantMenuTrigger aria-label="More actions">Open</OctantMenuTrigger>
        <OctantMenuPortal>
          <OctantMenuPositioner>
            <OctantMenuPopup>
              <OctantMenuCheckboxItem checked={false} onCheckedChange={onCheckedChange}>
                Show empty Projects
              </OctantMenuCheckboxItem>
              <OctantMenuSeparator />
              <OctantMenuSub>
                <OctantMenuSubTrigger>Group by</OctantMenuSubTrigger>
                <OctantMenuSubPopup>
                  <OctantMenuRadioGroup onValueChange={onValueChange} value="project">
                    <OctantMenuRadioItem closeOnClick={false} value="project">
                      Project
                    </OctantMenuRadioItem>
                    <OctantMenuRadioItem closeOnClick={false} value="none">
                      None
                    </OctantMenuRadioItem>
                  </OctantMenuRadioGroup>
                </OctantMenuSubPopup>
              </OctantMenuSub>
            </OctantMenuPopup>
          </OctantMenuPositioner>
        </OctantMenuPortal>
      </OctantMenuRoot>,
    );

    const trigger = screen.getByRole("button", { name: "More actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("menuitemcheckbox", { name: "Show empty Projects" })).toHaveFocus(),
    );
    expect(screen.getByRole("separator")).toBeInTheDocument();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Group by" })).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Project" })).toHaveFocus(),
    );
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");
    expect(onValueChange).toHaveBeenCalledWith("none", expect.anything());
  });
});

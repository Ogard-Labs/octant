import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantMenu } from "./OctantMenu";

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
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: /First.*First description/i }),
      ).toHaveFocus(),
    );
    await user.keyboard("{End}");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: /Third.*Third description/i }),
      ).toHaveFocus(),
    );
    await user.keyboard("{Home}");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: /First.*First description/i }),
      ).toHaveFocus(),
    );
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: /Third.*Third description/i }),
      ).toHaveFocus(),
    );
    await user.keyboard(" ");
    expect(onValueChange).toHaveBeenCalledWith("third");
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("menuitemradio", { name: /First.*First description/i }),
    ).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowDown}");
    await user.click(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body).toHaveFocus();
  });
});

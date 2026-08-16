import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsNavigation, type SettingsNavigationItem } from "./SettingsNavigation";

describe("SettingsNavigation", () => {
  it("lists only implemented visible sections in the supplied order", () => {
    const sections: SettingsNavigationItem[] = [
      { id: "general", label: "General" },
      { id: "appearance", label: "Appearance" },
      { id: "chat", label: "Chat" },
      { id: "providers", label: "Providers" },
    ];
    render(
      <SettingsNavigation sections={sections} activeSection="appearance" onSelect={vi.fn()} />,
    );

    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    const buttons = within(navigation).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "General",
      "Appearance",
      "Chat",
      "Providers",
    ]);
    expect(screen.queryByRole("button", { name: /theme|typography|extensions/i })).toBeNull();
  });

  it("marks the active section with aria-current and switches on click", () => {
    const sections: SettingsNavigationItem[] = [
      { id: "general", label: "General" },
      { id: "appearance", label: "Appearance" },
    ];
    const onSelect = vi.fn();
    render(<SettingsNavigation sections={sections} activeSection="general" onSelect={onSelect} />);

    const general = screen.getByRole("button", { name: "General" });
    const appearance = screen.getByRole("button", { name: "Appearance" });
    expect(general).toHaveAttribute("aria-current", "true");
    expect(appearance).not.toHaveAttribute("aria-current");

    fireEvent.click(appearance);
    expect(onSelect).toHaveBeenCalledWith("appearance");
  });

  it("stays absent when search leaves no implemented section", () => {
    const { container } = render(
      <SettingsNavigation sections={[]} activeSection="general" onSelect={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

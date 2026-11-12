import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OctantTabs, OctantTabsList, OctantTabsPanel, OctantTabsTab } from "./OctantTabs";

describe("OctantTabs", () => {
  it("carries the selected look on the tab that is selected, by the attribute the library writes", async () => {
    render(
      <OctantTabs defaultValue="one">
        <OctantTabsList aria-label="Sections">
          <OctantTabsTab value="one">One</OctantTabsTab>
          <OctantTabsTab value="two">Two</OctantTabsTab>
        </OctantTabsList>
        <OctantTabsPanel value="one">First</OctantTabsPanel>
        <OctantTabsPanel value="two">Second</OctantTabsPanel>
      </OctantTabs>,
    );
    const one = screen.getByRole("tab", { name: "One" });
    const two = screen.getByRole("tab", { name: "Two" });
    // The recipe's selected utilities key on one state attribute; that is the
    // attribute the selected tab carries, and the other tab does not.
    const keyed = /(?:^|\s)data-([a-z-]+):bg-muted(?:\s|$)/.exec(one.className)?.[1];
    expect(keyed).toBeDefined();
    const attribute = `data-${String(keyed)}`;
    expect(one).toHaveAttribute(attribute);
    expect(two).not.toHaveAttribute(attribute);
    await userEvent.setup().click(two);
    expect(two).toHaveAttribute(attribute);
    expect(one).not.toHaveAttribute(attribute);
  });
});

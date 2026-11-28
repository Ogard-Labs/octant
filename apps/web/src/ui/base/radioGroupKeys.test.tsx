import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { OctantButton } from "./OctantButton";
import { moveWithinTabList } from "./radioGroupKeys";

function PageTabs() {
  const [value, setValue] = useState("one");
  return (
    <div aria-label="Pages" onKeyDown={moveWithinTabList} role="tablist">
      {["one", "two", "three"].map((page) => (
        <span key={page} role="presentation">
          <OctantButton
            aria-selected={value === page}
            onClick={() => setValue(page)}
            role="tab"
            tabIndex={value === page ? 0 : -1}
            type="button"
          >
            {page}
          </OctantButton>
          <OctantButton type="button">{`Close ${page}`}</OctantButton>
        </span>
      ))}
    </div>
  );
}

describe("moveWithinTabList", () => {
  it("moves between tabs past their close buttons, selects the tab reached, and keeps one tab stop", async () => {
    const user = userEvent.setup();
    render(<PageTabs />);
    screen.getByRole("tab", { name: "one" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "two" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "two" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "two" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "one" })).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "three" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "one" })).toHaveFocus();
  });
});

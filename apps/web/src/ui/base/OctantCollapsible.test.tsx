import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OctantCollapsible } from "./OctantCollapsible";

describe("OctantCollapsible", () => {
  it("opens and closes from its summary and reports its open state on the native disclosure", async () => {
    const user = userEvent.setup();
    render(
      <OctantCollapsible summary="Commit message">
        <p>Body text</p>
      </OctantCollapsible>,
    );
    const summary = screen.getByText("Commit message", { selector: "summary" });
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    // jsdom has no keyboard activation for <summary>; a browser's Enter and
    // Space activate it the same way this click does.
    await user.click(summary);
    expect(disclosure).toHaveAttribute("open");
    await user.click(summary);
    expect(disclosure).not.toHaveAttribute("open");
  });
});

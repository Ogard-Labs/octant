import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OctantCollapsible } from "./OctantCollapsible";

describe("OctantCollapsible", () => {
  it("opens and closes from the keyboard and reports its open state", async () => {
    const user = userEvent.setup();
    render(
      <OctantCollapsible summary="Commit message">
        <p>Body text</p>
      </OctantCollapsible>,
    );
    const summary = screen.getByText("Commit message", { selector: "summary" });
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    summary.focus();
    await user.keyboard("{Enter}");
    expect(disclosure).toHaveAttribute("open");
    await user.keyboard(" ");
    expect(disclosure).not.toHaveAttribute("open");
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserAnnotateBar, type AnnotateTool } from "./BrowserAnnotateBar";

function tool(overrides: Partial<AnnotateTool> & Pick<AnnotateTool, "id" | "label">): AnnotateTool {
  return { icon: null, onPress: vi.fn(), group: "point", ...overrides };
}

describe("the page's annotation toolbar", () => {
  it("draws the tools it is given as one toolbar of named buttons, each with its tooltip", () => {
    const onPress = vi.fn();
    render(
      <BrowserAnnotateBar
        tools={[
          tool({ id: "pick", label: "Pick element", hint: "Adds it to the message", onPress }),
          tool({ id: "pen", label: "Draw on page", group: "draw" }),
          tool({ id: "end", label: "Cancel", group: "end", disabled: true }),
        ]}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Page tools" });
    expect(within(bar).getAllByRole("button")).toHaveLength(3);
    const pick = within(bar).getByRole("button", { name: "Pick element" });
    expect(pick).toHaveAttribute("title", "Pick element. Adds it to the message");
    fireEvent.click(pick);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(within(bar).getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("shows an armed tool as pressed and says what it waits for", () => {
    render(
      <BrowserAnnotateBar
        status="Click the thing you mean"
        tools={[tool({ id: "note", label: "Cancel pointing", pressed: true })]}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel pointing" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Click the thing you mean");
  });

  it("reports the host's refusal in the band, where it adds no height", () => {
    render(
      <BrowserAnnotateBar
        status="There is nothing at that spot to point at."
        tools={[tool({ id: "note", label: "Point at something" })]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("There is nothing at that spot");
  });

  it("counts the notes and opens their list from the count", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <BrowserAnnotateBar
        notes={{ count: 0, included: 0, open: false, onToggle }}
        tools={[tool({ id: "note", label: "Point at something" })]}
      />,
    );
    expect(screen.queryByRole("button", { name: /note/ })).toBeNull();
    rerender(
      <BrowserAnnotateBar
        notes={{ count: 1, included: 1, open: false, onToggle }}
        tools={[tool({ id: "note", label: "Point at something" })]}
      />,
    );
    const count = screen.getByRole("button", { name: "1 note" });
    // The count says the notes travel with the next message.
    expect(count).toHaveAttribute("title", "1 note goes with your next message");
    expect(count).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(count);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

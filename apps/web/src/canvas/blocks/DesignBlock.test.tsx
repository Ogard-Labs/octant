import { fireEvent, render, screen, within } from "@testing-library/react";
import { launchDeckExampleBlock, onboardingFlowExampleBlock } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";

function frames(container: HTMLElement): ReadonlyArray<HTMLIFrameElement> {
  return Array.from(container.querySelectorAll("iframe"));
}

describe("design block", () => {
  it("draws every screen in a frame that runs nothing and loads nothing", () => {
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [onboardingFlowExampleBlock] }} />,
    );

    const design = screen.getByRole("region", { name: "Onboarding, Phone design" });
    expect(within(design).getByText("Phone · 2 screens")).toBeVisible();
    const pages = frames(design);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      // An empty sandbox grants no script, form, popup, or same-origin access.
      expect(page.getAttribute("sandbox")).toBe("");
      expect(page).toHaveAttribute("tabindex", "-1");
      expect(page.srcdoc).toContain(
        `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"`,
      );
    }
    expect(pages[0]?.srcdoc).toContain("Dinner from the places your street already loves.");
    expect(pages[0]?.srcdoc).not.toContain("Where should we deliver?");
    expect(pages[0]).toHaveAttribute("title", "Welcome, Phone screen");
  });

  it("plays the whole flow from the screen a person picks, so its links work", () => {
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [onboardingFlowExampleBlock] }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Play from Address" }));

    const player = screen.getByRole("dialog", { name: "Playing Onboarding" });
    const prototype = within(player).getByTitle("Onboarding, prototype") as HTMLIFrameElement;
    expect(prototype.getAttribute("sandbox")).toBe("");
    expect(prototype).not.toHaveAttribute("tabindex");
    // Both screens are in one page so `href="#address"` can reach the other.
    expect(prototype.srcdoc).toContain('<div class="octant-frame" id="welcome">');
    expect(prototype.srcdoc).toContain('<div class="octant-frame" id="address" data-start>');
    // A bare `#address` in a srcdoc page resolves against Octant's own address
    // and blanks the frame; the link must name the page itself.
    expect(prototype.srcdoc).toContain('href="about:srcdoc#address"');
    expect(prototype.srcdoc).not.toContain('href="#address"');
  });

  it("presents slides in order and moves with the arrow keys", () => {
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [launchDeckExampleBlock] }} />);

    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    const player = screen.getByRole("dialog", { name: "Presenting Launch plan" });
    expect(within(player).getByText("1 / 2")).toBeVisible();
    expect(within(player).getByRole("button", { name: "Previous slide" })).toBeDisabled();

    fireEvent.keyDown(within(player).getByRole("button", { name: "Next slide" }), {
      key: "ArrowRight",
    });
    expect(within(player).getByText("2 / 2")).toBeVisible();
    expect(within(player).getByTitle("Goals, slide 2")).toHaveAttribute("tabindex", "-1");
    expect(within(player).getByRole("button", { name: "Next slide" })).toBeDisabled();
  });
});

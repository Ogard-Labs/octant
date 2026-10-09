import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import { CanvasView } from "../CanvasView";
import { canvasFixture } from "../test-fixtures";
import { MathBlock } from "./MathBlock";

const display = {
  blockId: "bayes",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "math",
  layout: "display",
  source: "P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}",
  caption: "Bayes' theorem",
} as const;

const inline = {
  blockId: "area",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "math",
  layout: "inline",
  runs: [
    { text: "A circle of radius " },
    { math: "r" },
    { text: " covers " },
    { math: "\\pi r^2" },
  ],
} as const;

function definition(blocks: ReadonlyArray<unknown>) {
  return { ...canvasFixture, blocks };
}

function mathBlock(value: unknown) {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "math") throw new Error("expected a math block");
  return block;
}

describe("math block", () => {
  it("draws a display formula as MathML that carries its source, under its caption", () => {
    const { container } = render(<CanvasView input={definition([display])} />);

    const region = screen.getByRole("region", { name: "Bayes' theorem" });
    expect(region).toHaveAttribute("tabindex", "0");
    const math = region.querySelector("math");
    expect(math).not.toBeNull();
    expect(math?.getAttribute("display")).toBe("block");
    expect(math?.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      display.source,
    );
    // The drawn glyphs are hidden from assistive technology; the MathML is read.
    expect(region.querySelector(".katex-html")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Bayes' theorem", { selector: "figcaption" })).toBeInTheDocument();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("offers the source as plain text under View source", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition([display])} />);

    const summary = screen.getByText("View source");
    await user.click(summary);
    const details = summary.closest("details");
    expect(details).toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText(display.source)).toBeInTheDocument();
  });

  it("draws a paragraph's prose and formulas in reading order, each formula inline", () => {
    const { container } = render(<CanvasView input={definition([inline])} />);

    const paragraph = container.querySelector(".canvas-block__math-paragraph");
    expect(paragraph).not.toBeNull();
    const formulas = paragraph?.querySelectorAll("math") ?? [];
    expect(formulas).toHaveLength(2);
    expect(Array.from(formulas, (formula) => formula.getAttribute("display"))).toEqual([
      null,
      null,
    ]);
    expect(paragraph?.textContent).toMatch(/^A circle of radius .*r.* covers .*π.*$/);
    const source = container.querySelector(".canvas-block__math-source");
    expect(source?.textContent).toBe("View sourceA circle of radius r covers \\pi r^2");
  });

  it("shows a formula the typesetter refuses as its source with a plain note", () => {
    const { container } = render(
      <MathBlock block={mathBlock({ ...display, source: "\\frac{1}{" })} />,
    );

    const note = screen.getByRole("note");
    expect(within(note).getByText("\\frac{1}{")).toBeInTheDocument();
    expect(within(note).getByText("This formula could not be drawn.")).toBeInTheDocument();
    // KaTeX's own error text is coloured inline, which no theme can repaint.
    expect(container.querySelector(".katex-error, [style*='color']")).toBeNull();
  });

  it("draws no link, frame, or script even for a formula that bypassed the policy", () => {
    const { container } = render(
      <MathBlock
        block={mathBlock({
          ...display,
          source: "\\href{javascript:alert(1)}{x} + \\htmlId{hijack}{y}",
        })}
      />,
    );

    expect(
      container.querySelector("a, iframe, script, object, embed, [href], [src], #hijack"),
    ).toBeNull();
    // The source still reads as text, so the reader sees what was written.
    expect(screen.getByRole("note")).toHaveTextContent("\\href{javascript:alert(1)}{x}");
  });
});

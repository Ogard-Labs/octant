import { describe, expect, it } from "vitest";
import { canvasMathRenderOptions, canvasMathSourceRefusal } from "./canvasMathPolicy";

describe("Canvas math source policy", () => {
  it("draws ordinary math markup, including escaped symbols and line breaks", () => {
    for (const source of [
      "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
      "\\{ x \\in \\mathbb{R} : x > 0 \\}",
      "50\\% \\text{ of } n",
      "\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}",
      "a \\\\letter",
    ]) {
      expect(canvasMathSourceRefusal(source)).toBeUndefined();
    }
  });

  it("names the refused command and what it would have done", () => {
    expect(canvasMathSourceRefusal("x + \\def\\y{1}")).toBe("uses \\def, which defines a macro.");
    expect(canvasMathSourceRefusal("\\url{https://example.com}")).toBe(
      "uses \\url, which links, embeds, or writes markup.",
    );
    expect(canvasMathSourceRefusal("\\colorbox{yellow}{x}")).toBe(
      "uses \\colorbox, which sets its own colour.",
    );
    expect(canvasMathSourceRefusal("\\@tempa")).toBe("uses the internal command \\@tempa.");
  });

  it("does not read a longer command name as a refused one it begins with", () => {
    expect(canvasMathSourceRefusal("\\left( x \\right)")).toBeUndefined();
    expect(canvasMathSourceRefusal("\\colon")).toBeUndefined();
    expect(canvasMathSourceRefusal("\\lettered")).toBeUndefined();
  });

  it("renders without trust, strictly, and with a fresh macro table each time", () => {
    const first = canvasMathRenderOptions(true, "mathml");
    const second = canvasMathRenderOptions(false, "htmlAndMathml");
    expect(first).toMatchObject({ trust: false, strict: "error", throwOnError: true });
    expect(first.displayMode).toBe(true);
    expect(second.displayMode).toBe(false);
    expect(first.macros).not.toBe(second.macros);
  });
});

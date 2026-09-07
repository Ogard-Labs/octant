import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders the syntax the two parsers it replaced each only half supported", () => {
    render(
      <Markdown
        body={[
          "A **bold** and an _italic_ and a ~~struck~~ word.",
          "",
          "- outer",
          "  - nested",
          "",
          "| Head |",
          "| ---- |",
          "| Cell |",
        ].join("\n")}
      />,
    );

    // One parser had lists and links but no italics; the other had italics but
    // no lists, quotes, or links. Neither had nesting, tables, or strikethrough.
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    expect(screen.getByText("struck").tagName).toBe("DEL");
    expect(screen.getByText("nested").closest("ul")?.parentElement?.tagName).toBe("LI");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Cell" })).toBeInTheDocument();
  });

  it("sends a fenced block to the shared code block, with its language", () => {
    render(<Markdown body={"```ts\nconst x = 1;\n```"} />);

    expect(screen.getByText("ts")).toBeInTheDocument();
    expect(screen.getByText(/const x = 1;/)).toBeInTheDocument();
    // An inline span is not a block, and must not become one.
    expect(screen.queryByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("keeps an inline code span inline", () => {
    render(<Markdown body="Run `bun test` first." />);

    expect(screen.getByText("bun test").tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("links only to http and https, and leaves anything else as text", () => {
    render(
      <Markdown body="[safe](https://example.com) and [unsafe](javascript:alert(1)) and [file](file:///etc/passwd)" />,
    );

    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
    expect(screen.queryByRole("link", { name: "unsafe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "file" })).not.toBeInTheDocument();
    // A refused link keeps its text; it just stops being a link.
    expect(screen.getByText(/unsafe/)).toBeInTheDocument();
    expect(screen.getByText(/file/)).toBeInTheDocument();
  });

  it("does not render raw HTML, whatever the source claims", () => {
    render(<Markdown body={'Before <img src="x" onerror="alert(1)"> after'} />);

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/Before/)).toBeInTheDocument();
  });

  it("keeps its DOM across a re-render, so a selection in it survives", () => {
    // The parts must keep one identity for the life of the renderer. Building
    // them per render makes each one a new component type, so React remounts
    // every node and drops whatever pointed at them — a half-made text
    // selection, the focus, the scroll position.
    const { rerender } = render(<Markdown body="Here is the summary." transformText={(t) => t} />);
    const before = screen.getByText("Here is the summary.").firstChild;

    rerender(<Markdown body="Here is the summary." transformText={(t) => t} />);

    expect(screen.getByText("Here is the summary.").firstChild).toBe(before);
  });

  it("applies the text transform to prose but not to a code span or a URL", () => {
    render(
      <Markdown
        body={"See #12 in `#34` at https://example.com/#56"}
        transformText={(text) => text.replaceAll(/#(\d+)/g, "TICKET-$1")}
      />,
    );

    expect(screen.getByText(/See TICKET-12 in/)).toBeInTheDocument();
    // A code span is not prose, so its text survives verbatim.
    expect(screen.getByText("#34").tagName).toBe("CODE");
  });
});

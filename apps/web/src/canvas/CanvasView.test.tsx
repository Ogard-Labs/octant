import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanvasDocument } from "./CanvasDocument";
import { CanvasView } from "./CanvasView";
import { canvasFixture, unsafeLinkFixture } from "./test-fixtures";

describe("CanvasView safe first-party renderer", () => {
  it("renders the validated title and its first-party blocks", () => {
    render(<CanvasView input={canvasFixture} />);
    expect(screen.getByRole("heading", { name: "Signed Q3 report" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Q3 Overview" })).toBeVisible();
  });

  it("denies invalid or unsafe input without rendering content", () => {
    render(<CanvasView input={{ schemaVersion: 99, title: "junk" }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(within(alert).getByText(/unable to render canvas/i)).toBeInTheDocument();
    expect(screen.queryByText("Signed Q3 report")).not.toBeInTheDocument();
  });

  it("renders no arbitrary HTML and no executable script payloads", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("[dangerouslySetInnerHTML]")).toBeNull();
    expect(screen.queryByText("<script")).toBeNull();
  });
});

describe("Canvas accessibility basics", () => {
  it("maps heading blocks to semantic heading levels", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const heading = screen.getByRole("heading", { name: "Q3 Overview" });
    expect(heading.tagName).toBe("H1");
    expect(heading).toHaveAttribute("aria-level");
  });

  it("renders a link block as a safe external anchor", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const link = screen.getByRole("link", { name: "Sources" });
    expect(link).toHaveAttribute("href", "https://reports.octant.example/q3");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("fails closed for an unsafe link payload and never renders an anchor", () => {
    render(<CanvasView input={unsafeLinkFixture} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("Signed Q3 report")).not.toBeInTheDocument();
  });

  it("exposes the table with a real table structure and column headers", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["Name", "Count"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("cell", { name: "Octant" })).toBeInTheDocument();
  });

  it("exposes progress as a real progress element with a value", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("max", "1");
    expect(progress).toHaveAttribute("value", "0.75");
  });

  it("exposes status blocks through a status live region", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const status = screen.getByRole("status", { name: /Ready/i });
    expect(status).toHaveTextContent("Ready");
  });

  it("renders charts as accessible images with an aria label", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const chart = screen.getByRole("img", { name: /line chart/i });
    expect(chart.querySelector("svg")).not.toBeNull();
  });

  it("renders key-value blocks as a semantic definition list", () => {
    const { container } = render(<CanvasDocument definition={canvasFixture} />);
    const dl = container.querySelector("dl");
    expect(dl).not.toBeNull();
    const terms = Array.from(dl!.querySelectorAll("dt")).map((n) => n.textContent);
    const definitions = Array.from(dl!.querySelectorAll("dd")).map((n) => n.textContent);
    expect(terms).toEqual(["Mode", "Reviewed"]);
    expect(definitions).toEqual(["Chat", "Yes"]);
  });

  it("renders images as safe placeholders with alt text and never fetches a src", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const img = screen.getByRole("img", { name: "A bounded diagram" });
    expect(img).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[src]")).toBeNull();
  });

  it("renders callouts through a note landmark", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Numbers are preliminary.");
    expect(note).toHaveTextContent("Note");
  });

  it("says a diagram in words for a reader who cannot see the drawing", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    // The names are on the boxes; what a reader cannot get from the drawing is
    // which of them connects to which.
    expect(
      screen.getByRole("img", { name: /Diagram with 2 nodes and 1 edges/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ingest to Report")).toBeInTheDocument();
  });

  it("annotates diff line kinds for assistive technology", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    expect(screen.getByLabelText("added line")).toHaveTextContent("+added line");
    expect(screen.getByLabelText("removed line")).toHaveTextContent("-removed line");
  });
});

describe("CanvasDocument structure", () => {
  it("labels the canvas region with its title", () => {
    const { container } = render(<CanvasDocument definition={canvasFixture} />);
    expect(container.querySelector("article")).toHaveAttribute("aria-label", "Signed Q3 report");
  });
});

describe("Hostile content and authority confinement", () => {
  it("escapes HTML and never creates executable DOM nodes from hostile text", () => {
    const hostile = {
      ...canvasFixture,
      blocks: [
        {
          schemaVersion: 1,
          blockId: "hostile-text",
          kind: "rich-text",
          text: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>',
        } as never,
      ],
    } as typeof canvasFixture;
    render(<CanvasDocument definition={hostile} />);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
    expect(screen.getByText(/<img/)).toBeInTheDocument();
  });

  it("renders reference blocks inert with no remote source fetching or navigation", () => {
    render(<CanvasDocument definition={canvasFixture} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("[src]")).toBeNull();
    const links = Array.from(document.querySelectorAll("a"));
    const navTargets = links
      .map((anchor) => anchor.getAttribute("href"))
      .filter((href) => href && !href.startsWith("http"));
    expect(navTargets).toEqual([]);
  });

  it("denies an unsupported schema version before any content is exposed", () => {
    render(<CanvasView input={canvasFixture} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    render(<CanvasView input={{ schemaVersion: 2, title: "future" }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

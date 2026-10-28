import { CANVAS_HTML_IMPORT_MAX_BYTES } from "@octant/contracts/canvas-cards";
import { CANVAS_MAX_DESIGN_MARKUP_LENGTH } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { importCanvasHtmlPage, type CanvasHtmlImport } from "./canvasHtmlImport";
import { canvasDesignMarkupRefusal, canvasDesignStylesheetRefusal } from "./canvasDesignPolicy";

function imported(html: string): Extract<CanvasHtmlImport, { status: "imported" }> {
  const result = importCanvasHtmlPage(html);
  if (result.status !== "imported") throw new Error(`refused: ${result.message}`);
  return result;
}

function refused(html: string): Extract<CanvasHtmlImport, { status: "refused" }> {
  const result = importCanvasHtmlPage(html);
  if (result.status !== "refused") throw new Error("expected a refusal");
  return result;
}

function frameHtml(result: Extract<CanvasHtmlImport, { status: "imported" }>): string {
  const frame = result.block.frames[0];
  if (frame === undefined) throw new Error("no frame");
  return frame.html;
}

/** A page shaped like an assistant's single-file HTML artifact: a CDN script, web fonts, a widget. */
const ARTIFACT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Habit &amp; Streak Tracker</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <style>
    @import url("https://example.test/reset.css");
    body { font-family: Inter, system-ui, sans-serif; background: #f8fafc; }
    .hero { background-image: url('https://images.example.test/hero.jpg'); }
    .dot { background-image: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }
  </style>
</head>
<body class="min-h-screen" onload="greet()">
  <!-- generated layout -->
  <main class="hero">
    <h1>Streaks</h1>
    <img src="https://images.example.test/logo.png" alt="Logo">
    <a href="https://example.test/docs">Docs</a>
    <a href="#today">Today</a>
    <button type="button" onclick="add()">Add</button>
    <output id="count">0</output>
  </main>
  <script>
    let count = 0;
    function add() { count += 1; document.getElementById("count").textContent = String(count); }
    function greet() {}
  </script>
</body>
</html>`;

describe("importing an HTML page into a design", () => {
  it("draws a page with no script as a static document frame in its own look", () => {
    const result = imported(
      "<!doctype html><html><head><title>Plain</title><style>h1 { color: #123; }</style></head>" +
        '<body><h1 id="top">Hello</h1><p><a href="#top">Back up</a></p></body></html>',
    );
    expect(result.frame).toBe("static");
    expect(result.block.runsScript).toBeUndefined();
    expect(result.block.size).toBe("document");
    expect(result.block.theme).toBe("none");
    expect(result.block.styles).toContain("h1 { color: #123; }");
    expect(frameHtml(result)).toBe('<h1 id="top">Hello</h1><p><a href="#top">Back up</a></p>');
    expect(result.pageTitle).toBe("Plain");
    expect(result.dropped).toEqual([]);
  });

  it("makes a page whose script survives a design that runs script, under the running design policy", () => {
    const result = imported(ARTIFACT_PAGE);
    expect(result.frame).toBe("running");
    expect(result.block.runsScript).toBe(true);
    const html = frameHtml(result);
    expect(html).toContain("function add()");
    expect(html).toContain('onclick="add()"');
    // The design policy a running design is held to admits what is left.
    expect(canvasDesignMarkupRefusal(html, new Set(), true)).toBeUndefined();
    expect(canvasDesignStylesheetRefusal(result.block.styles ?? "")).toBeUndefined();
    // And nothing the page would have loaded from the network is still there.
    expect(`${html}${result.block.styles ?? ""}`).not.toMatch(/https?:\/\//);
  });

  it("says what it took out of an assistant artifact, kind by kind", () => {
    const result = imported(ARTIFACT_PAGE);
    const byKind = Object.fromEntries(result.dropped.map((drop) => [drop.kind, drop]));
    expect(byKind["script-file"]).toEqual({
      kind: "script-file",
      count: 1,
      examples: ["https://cdn.tailwindcss.com"],
    });
    expect(byKind.stylesheet?.count).toBe(2);
    expect(byKind.file?.examples).toEqual([
      "https://images.example.test/hero.jpg",
      "https://images.example.test/logo.png",
    ]);
    expect(byKind.link?.examples).toEqual(["https://example.test/docs"]);
    // A preconnect is a page setting; the charset and viewport the host
    // writes itself are not worth reporting.
    expect(byKind["page-setting"]).toEqual({
      kind: "page-setting",
      count: 1,
      examples: ["preconnect"],
    });
  });

  it("keeps a data image and a fragment link, and carries the body's look and load handler", () => {
    const result = imported(ARTIFACT_PAGE);
    const html = frameHtml(result);
    expect(result.block.styles).toContain('url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")');
    expect(html).toContain('<a href="#today">Today</a>');
    expect(html).toContain("<a>Docs</a>");
    expect(html.startsWith('<div class="min-h-screen">')).toBe(true);
    expect(html).toContain('window.addEventListener("load", function (event) { greet() });');
    expect(html).not.toContain("<!--");
    expect(result.pageTitle).toBe("Habit & Streak Tracker");
  });

  it("draws a page whose only script was a file as a static frame", () => {
    const result = imported(
      '<html><head><script src="https://unpkg.test/lib.js"></script></head><body><p>Hi</p></body></html>',
    );
    expect(result.frame).toBe("static");
    expect(result.block.runsScript).toBeUndefined();
    expect(frameHtml(result)).toBe("<p>Hi</p>");
    expect(result.dropped).toEqual([
      { kind: "script-file", count: 1, examples: ["https://unpkg.test/lib.js"] },
    ]);
  });

  it("makes a page with only an event handler a design that runs script", () => {
    const result = imported("<button onclick=\"this.textContent = 'ok'\">Go</button>");
    expect(result.frame).toBe("running");
    expect(result.block.runsScript).toBe(true);
  });

  it("takes out embedded pages, form destinations, and SVG animation", () => {
    const result = imported(
      '<form action="https://collect.test/x"><input name="q"><button formaction="/go">Send</button></form>' +
        '<iframe src="https://video.test/embed"><p>inside</p></iframe>' +
        '<svg viewBox="0 0 10 10"><circle r="4"><animate attributeName="r" values="1;4" dur="1s"/></circle></svg>' +
        '<base href="https://x.test/"><meta http-equiv="refresh" content="0;url=https://x.test">',
    );
    const kinds = result.dropped.map((drop) => drop.kind).toSorted();
    expect(kinds).toEqual(["embedded-document", "form-target", "page-setting", "svg-animation"]);
    const html = frameHtml(result);
    expect(html).not.toContain("inside");
    expect(html).not.toContain("animate");
    expect(html).toContain("<form><input");
    expect(canvasDesignMarkupRefusal(html)).toBeUndefined();
  });

  it("never draws a page that holds script, a page setting, or a way out as a static frame", () => {
    // Each page either runs as a running design, is refused, or is drawn
    // static with nothing in it a browser would run, follow, or load.
    const live =
      /<(?:script|meta|base|link|iframe|frame|object|embed|set|animate)\b|[\s"'/]on[a-z]+\s*=|[\s"'/](?:xlink:)?href\s*=\s*"(?!#)/i;
    for (const page of [
      "<svg onload=alert(1)><rect/></svg>",
      '<a href="javascript:alert(1)">x</a>',
      '<a href="jav&#x09;ascript:alert(1)">x</a>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe><p>x</p>',
      '<object data="https://x.test/a.swf"></object><p>x</p>',
      '<p style="width:expression(alert(1))">x</p>',
      '<p style="background:url(javascript:alert(1))">x</p>',
      '<p style="background:ur&#108;(https://x.test/a.png)">x</p>',
      '<img src="data:image/png;base64,AA" o&#110;error="alert(1)">',
      "<template><img src=x onerror=alert(1)></template><p>x</p>",
      "<noscript><style></noscript><img src=x onerror=alert(1)></style></noscript>",
      "<SCRIPT>alert(1)</SCRIPT>",
      '<IMG SRC="data:image/png;base64,AA" ONERROR="alert(1)">',
      '<img\nsrc="data:image/png;base64,AA"\nonerror\n=\n"alert(1)">',
      '<img/src="data:image/png;base64,AA"/onerror=alert(1)>',
      "<svg><script>alert(1)</script></svg>",
      "<svg><script href=data:,alert(1) /></svg>",
      "<svg><title><img src=x onerror=alert(1)></title></svg>",
      "<svg><style><img src=x onerror=alert(1)></style></svg>",
      "<svg><style><meta http-equiv=refresh content=0;url=https://x.test/></style></svg>",
      "<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>",
      "<?x><img src=x onerror=alert(1)>?>",
      "<!--><img src=x onerror=alert(1)>-->",
      '<META HTTP-EQUIV=refresh CONTENT="0;url=https://x.test/"><p>x</p>',
      "<svg><a><SET attributeName=href to=https://x.test/ /><text>x</text></a></svg>",
      '<svg><use href="https://x.test/s.svg#a"/><image xlink:href="https://x.test/a.png"/></svg>',
      '<style media="screen{}</style><script>alert(1)</script>">p{}</style><p>x</p>',
      // A browser reads a textarea, an xmp, or a CDATA section as text, so the
      // quote inside opens nothing and what follows it is markup.
      '<textarea><x a="</textarea><svg><style><a><set attributeName=href to=https://x.test/ /><text>Go</text></a></style></svg>',
      '<textarea><x a="</textarea><svg><style><meta http-equiv=refresh content=0;url=https://x.test/></style></svg>',
      '<xmp><x a="</xmp><svg><style><meta http-equiv=refresh content=0;url=https://x.test/></style></svg>',
      '<svg><![CDATA[<x a="]]><style><a><set attributeName=href to=https://x.test/ /><text>Go</text></a></style></svg>',
    ]) {
      const result = importCanvasHtmlPage(page);
      if (result.status !== "imported" || result.frame === "running") continue;
      expect(frameHtml(result), page).not.toMatch(live);
    }
  });

  it("names the page by its title, cut to what a design title holds", () => {
    const result = imported(`<title>  ${"A".repeat(200)}  </title><p>x</p>`);
    expect(result.pageTitle?.length).toBe(120);
    expect(result.block.title.length).toBeLessThanOrEqual(120);
  });
});

describe("refusing a page it cannot import", () => {
  it("refuses a page larger than the import bound before reading it", () => {
    const page = `<p>${"x".repeat(CANVAS_HTML_IMPORT_MAX_BYTES)}</p>`;
    expect(refused(page).reason).toBe("too-large");
  });

  it("refuses a page whose remaining markup does not fit one design frame", () => {
    const page = `<p>${"word ".repeat(CANVAS_MAX_DESIGN_MARKUP_LENGTH / 4)}</p>`;
    const refusal = refused(page);
    expect(refusal.reason).toBe("too-large");
    expect(refusal.message).toContain("65,536");
  });

  it("refuses text with no element in it, and binary content, as not HTML", () => {
    expect(refused("Just some notes, no markup.").reason).toBe("not-html");
    expect(refused("\u0089PNG\r\n\u001a\n\u0000\u0000<p>").reason).toBe("not-html");
  });

  it("refuses a page with a tag, comment, or script that never ends", () => {
    expect(refused('<p>ok</p><div class="open').reason).toBe("unparseable");
    expect(refused("<p>ok</p><!-- never closed").reason).toBe("unparseable");
    expect(refused("<p>ok</p><script>let x = 1;").reason).toBe("unparseable");
  });

  it("refuses a page with nothing left to draw", () => {
    expect(
      refused(
        '<html><head><title>T</title><link rel="stylesheet" href="https://x.test/a.css"></head></html>',
      ).reason,
    ).toBe("empty");
  });

  it("refuses markup the design policy still refuses, with the policy's reason", () => {
    const refusal = refused("<p>Write it as url(https://x.test/a.png) in your CSS.</p>");
    expect(refusal.reason).toBe("unsupported");
    expect(refusal.message).toContain("loads a file with url()");
  });
});

import { readBrowserFeedbackElement } from "@octant/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

const point = { x: 170, y: 130, viewportWidth: 640, viewportHeight: 480 };

function select(html: string, selector: string) {
  document.body.innerHTML = html;
  const element = document.querySelector(selector);
  if (element === null) throw new Error("Missing selected test element");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => element });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(160, 120, 64, 48));
  return element;
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.innerHTML = "";
});

describe("the shared host element reader", () => {
  it.each([
    { left: 10, outside: 140, width: 134 },
    { left: -30, outside: 100, width: 94 },
  ])(
    "inspects the viewport-clipped crop beside an editable control ($left)",
    ({ left, outside, width }) => {
      const button = select(
        `<button id="save">Save</button><input value="private value">`,
        "#save",
      );
      vi.mocked(button.getBoundingClientRect).mockReturnValue(new DOMRect(left, 10, 100, 40));
      const field = document.querySelector("input");
      if (field === null) throw Error("Missing adjacent control");
      vi.spyOn(field, "getBoundingClientRect").mockReturnValue(new DOMRect(outside, 10, 20, 20));
      const read = readBrowserFeedbackElement(point);
      expect(read?.cropBlocked).toBe(false);
      expect(read?.cropBounds).toEqual({ x: 0, y: 0, width, height: 74 });
    },
  );

  it("names the document element when the selected point is outside body content", () => {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.documentElement,
    });
    expect(readBrowserFeedbackElement(point)?.element.selector).toBe("html");
  });

  it("reads the selected structure/styles without adjacent page text or form values", () => {
    select(
      `<main><p>Unrelated private page text</p><button id="save" style="font-size:14px;color:rgb(1, 2, 3)">Save<textarea>secret form value</textarea><span contenteditable="true">edited secret</span></button></main>`,
      "#save",
    );
    const result = readBrowserFeedbackElement(point);
    expect(result?.element.selector).toBe("#save");
    expect(result?.element.text).toBe("Save");
    expect(result?.context.ancestors[0]).toBe("main");
    expect(result?.context.children).toEqual(["textarea", "span"]);
    expect(result?.context.styles).toContainEqual({ property: "font-size", value: "14px" });
    expect(result?.context.styles).toContainEqual({ property: "color", value: "rgb(1, 2, 3)" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("Unrelated private");
  });

  it("withholds the crop when a visible editable control intersects its padded region", () => {
    select(`<main><button id="save">Save</button><input value="person's value"></main>`, "#save");
    const input = document.querySelector("input");
    if (input === null) throw new Error("Missing input");
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(210, 120, 60, 40));
    expect(readBrowserFeedbackElement(point)?.cropBlocked).toBe(true);
  });

  it.each([new DOMRect(0, 0, 0, 0), new DOMRect(500, 120, 10, 10)])(
    "withholds editable values overflowing an open shadow host outside the crop",
    (hostBox) => {
      select('<button id="save">Save</button><div id="host"></div>', "#save");
      const host = document.getElementById("host");
      if (host === null) throw Error("Missing host");
      vi.spyOn(host, "getBoundingClientRect").mockReturnValue(hostBox);
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<input type="text" value="fixture-private-token">';
      const input = root.querySelector("input");
      if (input === null) throw Error("Missing shadow input");
      vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(180, 130, 40, 20));
      const result = readBrowserFeedbackElement(point);
      expect(result?.cropBlocked).toBe(true);
      expect(JSON.stringify(result)).not.toContain("fixture-private-token");
    },
  );

  it("includes overflowing contenteditable text bounds in crop protection", () => {
    select(
      '<button id="save">Save</button><div contenteditable="true">fixture-private-text</div>',
      "#save",
    );
    const editor = document.querySelector("[contenteditable]");
    if (editor === null) throw Error("Missing editor");
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, 0));
    const range = document.createRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => [new DOMRect(180, 130, 40, 20)],
    });
    vi.spyOn(document, "createRange").mockReturnValue(range);
    expect(readBrowserFeedbackElement(point)?.cropBlocked).toBe(true);
  });

  it("withholds a parent crop intersecting an opaque frame without inspecting that frame", () => {
    const selected = select(
      `<main id="container"><iframe src="https://other.example/"></iframe></main>`,
      "#container",
    );
    vi.mocked(selected.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 640, 480));
    const frame = document.querySelector("iframe");
    if (frame === null) throw new Error("Missing frame");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 200, 200));
    const result = readBrowserFeedbackElement(point);
    expect(result?.cropBlocked).toBe(true);
    expect(result?.context.omissions).toContain("crop-withheld-for-uninspected-region");
    expect(result?.context.children).toEqual(["iframe"]);
  });

  it("does not resolve a frame hit into that frame's DOM", () => {
    select(`<iframe id="frame"></iframe>`, "#frame");
    expect(readBrowserFeedbackElement(point)).toBeNull();
  });

  it("bounds the neighborhood/text and excludes arbitrary style attributes", () => {
    select(
      `<main><section><article><div><button id="save" style="background-image:url(https://secret.example/token)">${"Visible ".repeat(800)}${"<span>child</span>".repeat(40)}</button></div></article></section></main>`,
      "#save",
    );
    const result = readBrowserFeedbackElement(point);
    expect(result?.element.text?.length).toBeLessThanOrEqual(2_048);
    expect(result?.context.ancestors).toHaveLength(4);
    expect(result?.context.children).toHaveLength(8);
    expect(result?.context.styles).toHaveLength(18);
    expect(JSON.stringify(result)).not.toContain("secret.example");
  });
});

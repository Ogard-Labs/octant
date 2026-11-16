// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserTabName,
  browserTabPageOf,
  cleanPageTitle,
  forgetClosedBrowserTabs,
  livePageOf,
  publishBrowserTabPage,
  resetBrowserTabPages,
  useBrowserTabPages,
} from "./browserTabPages";

function Tab(props: { readonly thread: string; readonly id: string; readonly server?: object }) {
  const pages = useBrowserTabPages();
  return (
    <span data-testid={props.id}>
      {browserTabName(browserTabPageOf(pages, props.thread, props.id), props.server)}
    </span>
  );
}

afterEach(() => resetBrowserTabPages());

describe("a Browser tab's name", () => {
  it("shows its page's title once the pane reports one, and follows later titles", () => {
    render(<Tab id="a" thread="t" />);
    expect(screen.getByTestId("a").textContent).toBe("New tab");
    act(() => publishBrowserTabPage("t", "a", { title: "Docs", url: "https://www.example.org/x" }));
    expect(screen.getByTestId("a").textContent).toBe("Docs");
    act(() =>
      publishBrowserTabPage("t", "a", { title: "Other", url: "https://www.example.org/y" }),
    );
    expect(screen.getByTestId("a").textContent).toBe("Other");
  });

  it("shows the host when the page has an address and no title", () => {
    render(<Tab id="a" thread="t" />);
    act(() => publishBrowserTabPage("t", "a", { url: "https://www.example.org/x" }));
    expect(screen.getByTestId("a").textContent).toBe("www.example.org");
  });

  it("reads New tab with no page, and for an address that does not parse", () => {
    render(<Tab id="a" thread="t" />);
    act(() => publishBrowserTabPage("t", "a", { url: "not an address" }));
    expect(screen.getByTestId("a").textContent).toBe("New tab");
  });

  it("gives two tabs with different pages different names", () => {
    render(
      <>
        <Tab id="a" thread="t" />
        <Tab id="b" thread="t" />
      </>,
    );
    act(() => {
      publishBrowserTabPage("t", "a", { title: "One" });
      publishBrowserTabPage("t", "b", { title: "Two" });
    });
    expect(screen.getByTestId("a").textContent).toBe("One");
    expect(screen.getByTestId("b").textContent).toBe("Two");
  });

  it("shows a messy title as trimmed one-line plain text", () => {
    render(<Tab id="a" thread="t" />);
    act(() => publishBrowserTabPage("t", "a", { title: "  Hello\n\n  <b>world</b>\t " }));
    expect(screen.getByTestId("a").textContent).toBe("Hello <b>world</b>");
    expect(screen.getByTestId("a").querySelector("b")).toBeNull();
    act(() => publishBrowserTabPage("t", "a", { title: "x".repeat(500) }));
    expect(screen.getByTestId("a").textContent).toHaveLength(200);
  });

  it("forgets a closed tab so a new tab with the same id starts empty", () => {
    render(<Tab id="a" thread="t" />);
    act(() => publishBrowserTabPage("t", "a", { title: "Old" }));
    act(() => forgetClosedBrowserTabs("t", []));
    expect(screen.getByTestId("a").textContent).toBe("New tab");
  });

  it("keeps another thread's tab with the same id apart", () => {
    render(
      <>
        <span data-testid="u">
          <Tab id="a" thread="u" />
        </span>
        <span data-testid="t">
          <Tab id="a" thread="t" />
        </span>
      </>,
    );
    act(() => publishBrowserTabPage("t", "a", { title: "Mine" }));
    expect(screen.getByTestId("u").textContent).toBe("New tab");
    act(() => forgetClosedBrowserTabs("u", []));
    expect(screen.getByTestId("t").textContent).toBe("Mine");
  });

  it("keeps a tab's name when a pane that has nothing to report yet publishes", () => {
    render(<Tab id="a" thread="t" />);
    act(() => publishBrowserTabPage("t", "a", { title: "Kept", url: "https://www.example.org/" }));
    act(() => publishBrowserTabPage("t", "a", {}));
    act(() => publishBrowserTabPage("t", "a", { title: "", url: "" }));
    expect(screen.getByTestId("a").textContent).toBe("Kept");
  });

  it("replaces an old title when the page moves and the new page has no title yet", () => {
    render(<Tab id="a" thread="t" />);
    act(() => publishBrowserTabPage("t", "a", { title: "Old", url: "https://old.example/" }));
    act(() => publishBrowserTabPage("t", "a", { title: "", url: "https://new.example/" }));
    expect(screen.getByTestId("a").textContent).toBe("new.example");
  });

  it("keeps a tab the stored list still holds, forgets one it no longer holds, and prunes nothing before the state has loaded", () => {
    render(
      <>
        <span data-testid="x">
          <Tab id="a" thread="t" />
        </span>
        <span data-testid="y">
          <Tab id="b" thread="t" />
        </span>
      </>,
    );
    act(() => {
      publishBrowserTabPage("t", "a", { title: "Alpha" });
      publishBrowserTabPage("t", "b", { title: "Beta" });
    });
    act(() => forgetClosedBrowserTabs("t", undefined));
    expect(screen.getByTestId("x").textContent).toBe("Alpha");
    expect(screen.getByTestId("y").textContent).toBe("Beta");
    act(() =>
      forgetClosedBrowserTabs("t", [
        { id: "a", surface: "browser" },
        { id: "term", surface: "terminal" },
      ]),
    );
    expect(screen.getByTestId("x").textContent).toBe("Alpha");
    expect(screen.getByTestId("y").textContent).toBe("New tab");
  });

  it("uses the server's read when no pane has reported", () => {
    render(<Tab id="a" server={{ title: "From server", url: "https://s.example/" }} thread="t" />);
    expect(screen.getByTestId("a").textContent).toBe("From server");
  });
});

describe("a page title shown in a tab", () => {
  it("drops control and bidi characters so a title cannot reorder the text beside it", () => {
    expect(cleanPageTitle("a\u202Eevil\u202C b\u2066c\u2069\u200Ed\u200F\u0007e")).toBe(
      "aevil bcde",
    );
  });

  it("cuts by code point and never leaves half of a surrogate pair", () => {
    const cut = cleanPageTitle("\u{1F600}".repeat(250));
    expect(Array.from(cut ?? "")).toHaveLength(200);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("is nothing when only controls and spaces are left", () => {
    expect(cleanPageTitle(" \u202E\n\t ")).toBeUndefined();
  });
});

describe("the page a pane reports", () => {
  it("takes the native title even when empty, never the server's older one", () => {
    const page = livePageOf({
      activeContext: true,
      native: { title: "", url: "https://www.example.org/next" },
      observation: { title: "Older page", url: "https://old.example/" },
    });
    expect(page).toEqual({ title: "", url: "https://www.example.org/next" });
    expect(browserTabName(page, undefined)).toBe("www.example.org");
  });

  it("falls to the server's observation when no native page is shown", () => {
    expect(
      livePageOf({
        activeContext: true,
        native: undefined,
        observation: { title: "Remote", url: "https://r.example/" },
      }),
    ).toEqual({ title: "Remote", url: "https://r.example/" });
  });

  it("reports nothing without an active context", () => {
    expect(
      livePageOf({
        activeContext: false,
        native: { title: "T", url: "https://x.example/" },
        observation: { title: "O" },
      }),
    ).toBeUndefined();
  });
});

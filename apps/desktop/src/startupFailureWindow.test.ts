import { describe, expect, it, vi } from "vitest";
import {
  NOTICE_CLOSE_URL,
  STARTUP_FAILURE_QUIT_URL,
  createNotices,
  showStartupFailureWindow,
  startupFailureDocument,
  type StartupFailureWindow,
} from "./startupFailureWindow";

function fakeWindow() {
  const calls: string[] = [];
  let navigate: (url: string, preventDefault: () => void) => void = () => undefined;
  let closed: () => void = () => undefined;
  const window: StartupFailureWindow = {
    load: async (url) => void calls.push(`load ${decodeURIComponent(url)}`),
    show: () => void calls.push("show"),
    onNavigate: (listener) => {
      navigate = listener;
    },
    onClosed: (listener) => {
      closed = listener;
    },
    close: () => {
      calls.push("close");
      closed();
    },
  };
  return {
    calls,
    window,
    navigate: (url: string) => {
      const prevented = vi.fn();
      navigate(url, prevented);
      return prevented;
    },
    close: () => closed(),
  };
}

const show = (
  fake: ReturnType<typeof fakeWindow>,
  quit: () => void = () => undefined,
  quitRequested: () => boolean = () => false,
) =>
  showStartupFailureWindow({
    ready: async () => undefined,
    quitRequested,
    createWindow: () => fake.window,
    title: "Octant could not start",
    message: "The data folder belongs to another install.",
    quit,
  });

describe("the window that shows a failed start", () => {
  it("states what happened and the reason, offers one Quit button and names no log", () => {
    const html = startupFailureDocument({
      title: "Octant could not start",
      message: "The data folder belongs to another install.",
    });

    expect(html).toContain("Octant could not start");
    expect(html).toContain("The data folder belongs to another install.");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`href="${STARTUP_FAILURE_QUIT_URL}"`);
    expect(html).not.toMatch(/log/i);
  });

  it("keeps the heading and Quit in view by bounding the reason in its own scrolling block", () => {
    const html = startupFailureDocument({
      title: "Octant could not start",
      message: "line\n".repeat(200),
    });

    expect(html).toMatch(/\.reason\s*\{[^}]*max-height:\s*\d+px/);
    expect(html).toMatch(/\.reason\s*\{[^}]*overflow-y:\s*auto/);
    const reasonEnd = html.indexOf("</div>", html.indexOf('<div class="reason">'));
    expect(reasonEnd).toBeGreaterThan(-1);
    expect(html.indexOf('<a class="action"')).toBeGreaterThan(reasonEnd);
    expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf('<div class="reason">'));
  });

  it("shows the reason as text, never as markup", () => {
    const html = startupFailureDocument({
      title: "Octant could not start",
      message: '<img src="https://example.test/x"> & "quoted"',
    });

    expect(html).not.toContain("<img");
    expect(html).toContain(
      "&lt;img src=&quot;https://example.test/x&quot;&gt; &amp; &quot;quoted&quot;",
    );
  });

  it("loads no remote content and runs no script", () => {
    const html = startupFailureDocument({ title: "Octant could not start", message: "reason" });

    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<link|<img|<iframe|src=|https?:\/\//);
  });

  it("loads only the built document as a data URL, then shows the window", async () => {
    const fake = fakeWindow();
    await show(fake);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toMatch(/^load data:text\/html;charset=utf-8,/);
    expect(fake.calls[1]).toBe("show");
  });

  it("creates no window when a quit was requested while the app became ready", async () => {
    const createWindow = vi.fn(() => fakeWindow().window);
    await showStartupFailureWindow({
      ready: async () => undefined,
      quitRequested: () => true,
      createWindow,
      title: "Octant could not start",
      message: "reason",
      quit: vi.fn(),
    });

    expect(createWindow).not.toHaveBeenCalled();
  });

  it("ends the app when the person presses Quit and refuses the navigation", async () => {
    const fake = fakeWindow();
    const quit = vi.fn();
    await show(fake, quit);

    const prevented = fake.navigate(STARTUP_FAILURE_QUIT_URL);

    expect(prevented).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("refuses any other navigation without quitting", async () => {
    const fake = fakeWindow();
    const quit = vi.fn();
    await show(fake, quit);

    const prevented = fake.navigate("https://example.test/");

    expect(prevented).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("ends the app when the window is closed", async () => {
    const fake = fakeWindow();
    const quit = vi.fn();
    await show(fake, quit);

    fake.close();

    expect(quit).toHaveBeenCalledOnce();
  });
});

describe("telling a person about a failure while the app keeps running", () => {
  const owner = (state: { visible?: boolean; minimized?: boolean; destroyed?: boolean } = {}) => ({
    isDestroyed: () => state.destroyed ?? false,
    isVisible: () => state.visible ?? true,
    isMinimized: () => state.minimized ?? false,
  });
  const setup = () => {
    const windows: Array<ReturnType<typeof fakeWindow>> = [];
    const showSheet = vi.fn();
    const notices = createNotices({
      createWindow: () => {
        const fake = fakeWindow();
        windows.push(fake);
        return fake.window;
      },
      showSheet,
    });
    return { windows, showSheet, notices };
  };

  it("is a sheet on a visible main window", async () => {
    const { windows, showSheet, notices } = setup();
    const main = owner();

    await notices.notify(main, "Host action unavailable", "reason");

    expect(showSheet).toHaveBeenCalledWith(main, "Host action unavailable", "reason");
    expect(windows).toHaveLength(0);
  });

  it("is a small window with no blocking call when there is no main window, and closing it quits nothing", async () => {
    const { windows, showSheet, notices } = setup();

    await notices.notify(undefined, "Host action unavailable", "reason");

    expect(showSheet).not.toHaveBeenCalled();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.calls.at(-1)).toBe("show");
    expect(windows[0]?.calls[0]).toContain("reason");
    expect(windows[0]?.calls[0]).toContain(NOTICE_CLOSE_URL);

    const prevented = windows[0]?.navigate(NOTICE_CLOSE_URL);
    expect(prevented).toHaveBeenCalledOnce();
    expect(windows[0]?.calls).toContain("close");
    // Nothing in a notice is wired to quit; closing reaches no quit callback.
  });

  it("uses the notice window for a main window that is hidden, minimised or gone", async () => {
    const { windows, showSheet, notices } = setup();

    await notices.notify(owner({ visible: false }), "A", "first");
    await notices.notify(owner({ minimized: true }), "A", "second");
    await notices.notify(owner({ destroyed: true }), "A", "third");

    expect(showSheet).not.toHaveBeenCalled();
    expect(windows).toHaveLength(1);
  });

  it("keeps one notice window and replaces its text with the newer notice", async () => {
    const { windows, notices } = setup();

    await notices.notify(undefined, "A", "first reason");
    await notices.notify(undefined, "A", "newer reason");

    expect(windows).toHaveLength(1);
    expect(windows[0]?.calls.filter((call) => call.startsWith("load"))).toHaveLength(2);
    expect(windows[0]?.calls.findLast((call) => call.startsWith("load"))).toContain("newer reason");
  });

  it("opens a fresh notice window after the previous one was closed", async () => {
    const { windows, notices } = setup();

    await notices.notify(undefined, "A", "first");
    windows[0]?.close();
    await notices.notify(undefined, "A", "second");

    expect(windows).toHaveLength(2);
  });
});

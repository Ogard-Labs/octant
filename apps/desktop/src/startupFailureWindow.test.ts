import { describe, expect, it, vi } from "vitest";
import {
  STARTUP_FAILURE_QUIT_URL,
  showStartupFailureWindow,
  startupFailureDocument,
  type StartupFailureWindow,
} from "./startupFailureWindow";

function fakeWindow() {
  const calls: string[] = [];
  let navigate: (url: string, preventDefault: () => void) => void = () => undefined;
  let closed: () => void = () => undefined;
  const window: StartupFailureWindow = {
    load: async (url) => void calls.push(`load ${url}`),
    show: () => void calls.push("show"),
    onNavigate: (listener) => {
      navigate = listener;
    },
    onClosed: (listener) => {
      closed = listener;
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

const show = (fake: ReturnType<typeof fakeWindow>, quit: () => void = () => undefined) =>
  showStartupFailureWindow({
    createWindow: () => fake.window,
    title: "Octant could not start",
    message: "The data folder belongs to another install.",
    logsDirectory: "/Users/test/Library/Logs/Octant",
    quit,
  });

describe("the window that shows a failed start", () => {
  it("states what happened, the reason, where the log is and offers one Quit button", () => {
    const html = startupFailureDocument({
      title: "Octant could not start",
      message: "The data folder belongs to another install.",
      logsDirectory: "/Users/test/Library/Logs/Octant",
    });

    expect(html).toContain("Octant could not start");
    expect(html).toContain("The data folder belongs to another install.");
    expect(html).toContain("/Users/test/Library/Logs/Octant");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`href="${STARTUP_FAILURE_QUIT_URL}"`);
  });

  it("shows the reason as text, never as markup", () => {
    const html = startupFailureDocument({
      title: "Octant could not start",
      message: '<img src="https://example.test/x"> & "quoted"',
      logsDirectory: undefined,
    });

    expect(html).not.toContain("<img");
    expect(html).toContain(
      "&lt;img src=&quot;https://example.test/x&quot;&gt; &amp; &quot;quoted&quot;",
    );
  });

  it("loads no remote content and runs no script", () => {
    const html = startupFailureDocument({
      title: "Octant could not start",
      message: "reason",
      logsDirectory: undefined,
    });

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

import { render, screen } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { couldNotLoad, LazyPartBoundary, WindowNoticeContext } from "./windowNotice";

describe("a part of the window that loads on first use", () => {
  it("says it could not load where thread notices appear, and leaves the rest drawn", async () => {
    const say = vi.fn();
    const Missing = lazy(() => Promise.reject(new Error("chunk failed")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <WindowNoticeContext.Provider value={say}>
        <p>Sidebar</p>
        <LazyPartBoundary what="this thread's menu">
          <Suspense fallback={null}>
            <Missing />
          </Suspense>
        </LazyPartBoundary>
      </WindowNoticeContext.Provider>,
    );
    await vi.waitFor(() => expect(say).toHaveBeenCalledWith(couldNotLoad("this thread's menu")));
    expect(screen.getByText("Sidebar")).toBeVisible();
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("says so again each time the person asks for a part that failed to load", async () => {
    const say = vi.fn();
    const Missing = lazy(() => Promise.reject(new Error("chunk failed")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const menu = (asked: number) => (
      <WindowNoticeContext.Provider value={say}>
        <LazyPartBoundary asked={asked} what="this Project's menu">
          <Suspense fallback={null}>
            <Missing />
          </Suspense>
        </LazyPartBoundary>
      </WindowNoticeContext.Provider>
    );
    const { rerender } = render(menu(1));
    await vi.waitFor(() => expect(say).toHaveBeenCalledTimes(1));
    rerender(menu(1));
    expect(say).toHaveBeenCalledTimes(1);
    rerender(menu(2));
    expect(say).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenLastCalledWith(couldNotLoad("this Project's menu"));
  });
});

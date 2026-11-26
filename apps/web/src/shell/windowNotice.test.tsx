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
});

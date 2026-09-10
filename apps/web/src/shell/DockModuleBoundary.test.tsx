import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DockModuleBoundary } from "./DockModuleBoundary";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("contains a failing tool while the conversation stays available", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw new Error("A tool failed");
  }
  render(
    <>
      <p>The conversation remains here</p>
      <DockModuleBoundary>
        <Broken />
      </DockModuleBoundary>
    </>,
  );
  expect(screen.getByText("The conversation remains here")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("This tool could not be displayed");
});

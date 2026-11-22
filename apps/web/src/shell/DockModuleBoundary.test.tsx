import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
  expect(screen.getByRole("alert")).toHaveTextContent("This tool could not load");
});

it("lets a person close a dialog that could not load", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw new Error("A dialog failed");
  }
  const onClose = vi.fn();
  render(
    <DockModuleBoundary onClose={onClose}>
      <Broken />
    </DockModuleBoundary>,
  );
  screen.getByRole("button", { name: "Close" }).click();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps an unsaved edit when the surface switches, and clears a failure when it does", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Reader({ broken }: { readonly broken: boolean }) {
    if (broken) throw new Error("A reader failed");
    return <textarea aria-label="Notes" />;
  }
  const { rerender } = render(
    <DockModuleBoundary resetKey="todos">
      <Reader broken={false} />
    </DockModuleBoundary>,
  );
  fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Unsaved notes" } });
  rerender(
    <DockModuleBoundary resetKey="todos+board">
      <Reader broken={false} />
    </DockModuleBoundary>,
  );
  expect(screen.getByLabelText("Notes")).toHaveValue("Unsaved notes");

  rerender(
    <DockModuleBoundary resetKey="todos+board">
      <Reader broken />
    </DockModuleBoundary>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("This tool could not load");
  rerender(
    <DockModuleBoundary resetKey="todos">
      <Reader broken={false} />
    </DockModuleBoundary>,
  );
  expect(screen.getByLabelText("Notes")).toBeVisible();
});

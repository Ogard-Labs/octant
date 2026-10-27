import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasFixture } from "./test-fixtures";

// Each test needs a fresh module graph: the lazy component caches its first
// import result, which would hide the loading and failure states.
async function importCanvasViewWith(documentModule: Parameters<typeof vi.doMock>[1]) {
  vi.resetModules();
  vi.doMock("./CanvasDocument", documentModule);
  return (await import("./CanvasView")).CanvasView;
}

afterEach(() => {
  vi.doUnmock("./CanvasDocument");
  vi.restoreAllMocks();
});

describe("CanvasView while its code loads", () => {
  it("shows a loading status until the Canvas code arrives", async () => {
    let release: () => void = () => {};
    const arrival = new Promise<void>((resolve) => {
      release = resolve;
    });
    const CanvasView = await importCanvasViewWith(async () => {
      await arrival;
      return { CanvasDocument: () => <h1>Loaded canvas</h1> };
    });
    render(<CanvasView input={canvasFixture} />);
    expect(screen.getByRole("status")).toHaveTextContent("Opening canvas");
    release();
    expect(await screen.findByRole("heading", { name: "Loaded canvas" })).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a failed load inside the Canvas and retries on request", async () => {
    let attempts = 0;
    const CanvasView = await importCanvasViewWith(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk failed");
      return { CanvasDocument: () => <h1>Loaded canvas</h1> };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <main>
        <p>Sibling content</p>
        <CanvasView input={canvasFixture} />
      </main>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Canvas could not be shown");
    expect(screen.getByText("Sibling content")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Loaded canvas" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock";

// jsdom ships no clipboard; each case defines exactly the one it wants and
// puts the original back so the next case starts from the host's own state.
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");

function setClipboard(value: unknown): void {
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value });
}

describe("CodeBlock", () => {
  afterEach(() => {
    if (originalClipboard === undefined) {
      Reflect.deleteProperty(globalThis.navigator, "clipboard");
    } else {
      Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    }
  });

  it("names the language in its header and copies the code on request", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    render(<CodeBlock code={"const ready = true;\n"} language="ts" />);

    expect(screen.getByText("ts")).toBeVisible();
    expect(screen.getByText("const ready = true;")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith("const ready = true;\n");
    expect(await screen.findByText("Copied")).toBeVisible();
  });

  it("says the code was not copied on a host with no clipboard", async () => {
    setClipboard(undefined);
    render(<CodeBlock code="echo hi" />);

    // No language tag: the header still carries the copy control alone.
    expect(screen.queryByText("Code")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(await screen.findByText("Not copied")).toBeVisible();
  });
});

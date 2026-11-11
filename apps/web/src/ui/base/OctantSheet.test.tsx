import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OctantButton } from "./OctantButton";
import { OctantSheet } from "./OctantSheet";

describe("OctantSheet", () => {
  it("floats a named surface over the page, keeps focus inside it, and closes on Escape with focus returned", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = createRef<HTMLButtonElement>();
    function Fixture() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <OctantButton ref={opener} type="button">
            Open Settings
          </OctantButton>
          <p>The page behind the sheet</p>
          <OctantSheet
            label="Settings"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            open={open}
            restoreFocus={opener}
          >
            <OctantButton type="button">First control</OctantButton>
            <OctantButton type="button">Last control</OctantButton>
          </OctantSheet>
        </>
      );
    }
    render(<Fixture />);

    const sheet = screen.getByRole("dialog", { name: "Settings" });
    // The page is still drawn behind the sheet; it is only out of reach.
    expect(screen.getByText("The page behind the sheet")).toBeInTheDocument();
    expect(sheet).toHaveClass("octant-sheet__popup");

    // The page is out of reach, and Tab wraps inside the sheet.
    expect(opener.current?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(opener.current?.parentElement).toHaveAttribute("data-base-ui-inert");
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    screen.getByRole("button", { name: "First control" }).focus();
    await user.tab({ shift: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Last control" })).toHaveFocus());

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    await waitFor(() => expect(opener.current).toHaveFocus());
  });
});

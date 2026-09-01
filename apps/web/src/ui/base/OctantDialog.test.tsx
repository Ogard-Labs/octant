import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OctantDialog } from "./OctantDialog";
import { OctantButton } from "./OctantButton";

describe("OctantDialog", () => {
  it("provides one controlled modal with trapped focus, Escape dismissal, and opener restoration", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = createRef<HTMLButtonElement>();
    const initialFocus = createRef<HTMLButtonElement>();
    function Fixture() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <OctantButton ref={opener} type="button">
            Open utility dock
          </OctantButton>
          <OctantDialog
            label="Project memory"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            open={open}
            initialFocus={initialFocus}
            restoreFocus={opener}
          >
            <OctantButton ref={initialFocus} type="button">
              First dock action
            </OctantButton>
            <OctantButton type="button">Last dock action</OctantButton>
          </OctantDialog>
        </>
      );
    }
    render(<Fixture />);

    expect(screen.getByRole("dialog", { name: "Project memory" })).toBeVisible();
    expect(opener.current?.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(opener.current?.parentElement).toHaveAttribute("data-base-ui-inert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "First dock action" })).toHaveFocus(),
    );

    await user.tab({ shift: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Last dock action" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open utility dock" })).toHaveFocus(),
    );
    expect(opener.current?.parentElement).not.toHaveAttribute("aria-hidden");
    expect(opener.current?.parentElement).not.toHaveAttribute("data-base-ui-inert");
  });

  it("dismisses through the backdrop while pointer interaction inside remains safe", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <OctantDialog label="Code environment" onClose={onClose} open>
        <OctantButton type="button">Refresh environment</OctantButton>
      </OctantDialog>,
    );

    await user.click(screen.getByRole("button", { name: "Refresh environment" }));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("octant-dialog-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

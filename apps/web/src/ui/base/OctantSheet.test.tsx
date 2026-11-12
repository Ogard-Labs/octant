import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OctantButton } from "./OctantButton";
import { OctantSheet } from "./OctantSheet";

/**
 * The library waits for the popup's running transitions before it takes a
 * closed sheet out of the document, and jsdom runs none. A test that has to
 * see the exit hands the popup one transition and ends it when it chooses.
 */
function runExitTransitions(): { readonly finish: () => void } {
  let finish = (): void => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element) {
      return this.hasAttribute("data-ending-style") ? [{ finished }] : [];
    },
  });
  return { finish: () => finish() };
}

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

/** Settings as a sheet over a page with a field of its own. */
function Page(props: { readonly onSave: () => void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <main>
      <OctantButton onClick={() => setOpen(true)} ref={opener} type="button">
        Open Settings
      </OctantButton>
      <input aria-label="Message" />
      <OctantSheet
        label="Settings"
        onClose={() => setOpen(false)}
        open={open}
        restoreFocus={opener}
      >
        <OctantButton
          onClick={() => {
            props.onSave();
            setOpen(false);
          }}
          type="button"
        >
          Save and close
        </OctantButton>
      </OctantSheet>
    </main>
  );
}

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

  it("takes no press and no key while it leaves, and has focus back on the opener by then", async () => {
    const exit = runExitTransitions();
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Page onSave={onSave} />);
    const opener = screen.getByRole("button", { name: "Open Settings" });

    await user.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    await user.click(screen.getByRole("button", { name: "Save and close" }));

    expect(sheet).toBeInTheDocument();
    expect(sheet).toHaveAttribute("data-ending-style");
    expect(sheet).toHaveAttribute("inert");
    expect(screen.getByTestId("octant-sheet-backdrop")).toHaveAttribute("inert");
    expect(opener).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-hidden");

    exit.finish();
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(onSave).toHaveBeenCalledOnce();
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("leaves focus where the person put it while the sheet was leaving", async () => {
    const exit = runExitTransitions();
    const user = userEvent.setup();
    render(<Page onSave={() => undefined} />);
    const message = screen.getByRole("textbox", { name: "Message" });

    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await user.click(message);
    expect(message).toHaveFocus();

    exit.finish();
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    // The library hands focus back in a microtask after the exit.
    await Promise.resolve();
    expect(message).toHaveFocus();
  });
});

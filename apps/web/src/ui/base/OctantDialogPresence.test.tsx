import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OctantButton } from "./OctantButton";
import { OctantConfirmDialog } from "./OctantConfirmDialog";
import { OctantDialog } from "./OctantDialog";
import { OctantDialogPresence } from "./OctantDialogPresence";

/**
 * The library waits for the popup's running transitions before it takes a
 * closed dialog out of the document, and jsdom runs none. A test that has to
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

/** A feature that renders its confirmation only while a file is pending. */
function DeleteFile() {
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [deleted, setDeleted] = useState<ReadonlyArray<string>>([]);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <main>
      <OctantButton onClick={() => setPending("report.txt")} ref={opener} type="button">
        Delete report.txt
      </OctantButton>
      <OctantButton onClick={() => setPending("notes.txt")} type="button">
        Delete notes.txt
      </OctantButton>
      <input aria-label="Search files" />
      <p role="status">{pending === undefined ? "Nothing pending" : `Pending ${pending}`}</p>
      <p>{`Deleted ${String(deleted.length)}`}</p>
      <OctantDialogPresence>
        {pending === undefined ? null : (
          <OctantConfirmDialog
            confirmLabel="Delete"
            destructive
            onCancel={() => setPending(undefined)}
            onConfirm={() => {
              setDeleted((files) => [...files, pending]);
              setPending(undefined);
            }}
            restoreFocus={opener}
            title={`Delete ${pending}?`}
          >
            {`${pending} is removed from this computer.`}
          </OctantConfirmDialog>
        )}
      </OctantDialogPresence>
    </main>
  );
}

describe("OctantDialogPresence", () => {
  it("keeps the confirmation's last words on screen while it leaves, then takes it away", async () => {
    const exit = runExitTransitions();
    const user = userEvent.setup();
    render(<DeleteFile />);
    const opener = screen.getByRole("button", { name: "Delete report.txt" });

    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Delete report.txt?" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Delete" }));

    // The feature has cleared the state the words came from, and the dialog
    // that is leaving still says them.
    expect(screen.getByRole("status")).toHaveTextContent("Nothing pending");
    expect(screen.getByText("Deleted 1")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("data-ending-style");
    expect(dialog).toHaveAccessibleName("Delete report.txt?");
    expect(dialog).toHaveAccessibleDescription("report.txt is removed from this computer.");
    // The page is already the person's again while the dialog fades, and the
    // dialog that is leaving takes no press and no key.
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("main")).not.toHaveAttribute("data-base-ui-inert");
    expect(dialog).toHaveAttribute("inert");
    expect(screen.getByTestId("octant-dialog-backdrop")).toHaveAttribute("inert");
    expect(opener).toHaveFocus();

    exit.finish();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(screen.queryByText("Delete report.txt?")).not.toBeInTheDocument();
    expect(screen.queryByTestId("octant-dialog-backdrop")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("main")).not.toHaveAttribute("data-base-ui-inert");
  });

  // jsdom cannot show focus coming back after a press outside: the library
  // returns it there only where `focus({ preventScroll })` is supported.
  it("closes on Escape with focus back on the opener, and on a press outside", async () => {
    const exit = runExitTransitions();
    exit.finish();
    const user = userEvent.setup();
    render(<DeleteFile />);
    const opener = screen.getByRole("button", { name: "Delete report.txt" });

    await user.click(opener);
    await screen.findByRole("dialog", { name: "Delete report.txt?" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());

    await user.click(opener);
    await screen.findByRole("dialog", { name: "Delete report.txt?" });
    await user.click(screen.getByTestId("octant-dialog-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Deleted 0")).toBeInTheDocument();
  });

  it("is gone in the same turn when no transition runs, as under reduced motion", async () => {
    const user = userEvent.setup();
    render(<DeleteFile />);

    await user.click(screen.getByRole("button", { name: "Delete report.txt" }));
    await screen.findByRole("dialog", { name: "Delete report.txt?" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete report.txt?")).not.toBeInTheDocument();
  });

  it("leaves focus where the person put it while the dialog was leaving", async () => {
    const exit = runExitTransitions();
    const user = userEvent.setup();
    render(<DeleteFile />);
    const opener = screen.getByRole("button", { name: "Delete report.txt" });
    const search = screen.getByRole("textbox", { name: "Search files" });

    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Delete report.txt?" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(opener).toHaveFocus();

    await user.click(search);
    expect(search).toHaveFocus();
    exit.finish();
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    // The library hands focus back in a microtask after the exit.
    await Promise.resolve();
    expect(search).toHaveFocus();
  });

  it("opens a dialog of its own when the feature shows one again before the last has left", async () => {
    const exit = runExitTransitions();
    const user = userEvent.setup();
    render(<DeleteFile />);

    await user.click(screen.getByRole("button", { name: "Delete report.txt" }));
    const leaving = await screen.findByRole("dialog", { name: "Delete report.txt?" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(leaving).toHaveAttribute("data-ending-style");

    // The leaving dialog takes no press, so the page's own button is reachable.
    await user.click(screen.getByRole("button", { name: "Delete notes.txt" }));
    const next = await screen.findByRole("dialog", { name: "Delete notes.txt?" });
    expect(leaving).not.toBeInTheDocument();
    expect(next).not.toBe(leaving);
    expect(next).not.toHaveAttribute("data-ending-style");

    exit.finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(next).toBeInTheDocument();
  });

  it("drops content at once when no open dialog is inside it", async () => {
    runExitTransitions();
    const user = userEvent.setup();
    function Fixture() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <OctantButton onClick={() => setShown(false)} type="button">
            Hide
          </OctantButton>
          <OctantDialogPresence>
            {shown ? (
              <>
                <p>Plain words</p>
                <OctantDialog label="Closed already" onClose={() => undefined} open={false}>
                  Never shown
                </OctantDialog>
              </>
            ) : null}
          </OctantDialogPresence>
        </>
      );
    }
    render(<Fixture />);
    expect(screen.getByText("Plain words")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("Plain words")).not.toBeInTheDocument();
  });
});

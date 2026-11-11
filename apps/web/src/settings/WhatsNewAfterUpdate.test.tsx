import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarWhatsNew } from "../shell/SidebarWhatsNew";
import type { BundledWhatsNew, OctantHostBridge } from "../shell/hostBridge";
import { WhatsNewAfterUpdate } from "./WhatsNewAfterUpdate";
import { useWhatsNewAfterUpdate, whatsNewCardContent } from "./useWhatsNewAfterUpdate";

const NOTES =
  "Canvas comments\n\nPoint at any block and say what is wrong\nwith it, right on the page.\n\nMore below.";

function dueNotes(
  extra: Partial<Extract<BundledWhatsNew, { kind: "notes" }>> = {},
): BundledWhatsNew {
  return { kind: "notes", version: "0.2.0", text: NOTES, showAfterApply: true, ...extra };
}

/** The sidebar card and the shell dialogs, wired as App wires them. */
function Harness(props: {
  readonly hostBridge?: OctantHostBridge;
  readonly firstRunVisible?: boolean;
}) {
  const controller = useWhatsNewAfterUpdate({
    firstRunVisible: props.firstRunVisible ?? false,
    ...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge }),
  });
  return (
    <>
      {controller.card === undefined ? null : (
        <SidebarWhatsNew
          content={controller.card}
          onDismiss={controller.dismiss}
          onOpenNotes={controller.openNotes}
        />
      )}
      <WhatsNewAfterUpdate controller={controller} />
    </>
  );
}

function bridge(document: BundledWhatsNew) {
  const readBundledWhatsNew = vi.fn(async () => document);
  const acknowledgeWhatsNew = vi.fn(async () => undefined);
  const checkForAppUpdate = vi.fn();
  return {
    readBundledWhatsNew,
    acknowledgeWhatsNew,
    checkForAppUpdate,
    hostBridge: {
      readBundledWhatsNew,
      acknowledgeWhatsNew,
      checkForAppUpdate,
    } as unknown as OctantHostBridge,
  };
}

describe("What's new after an update", () => {
  it("shows a card with the version, a headline and a two-line summary when notes are due", async () => {
    const { hostBridge, checkForAppUpdate } = bridge(dueNotes());
    render(<Harness hostBridge={hostBridge} />);

    expect(await screen.findByText("New · v0.2.0")).toBeTruthy();
    expect(screen.getByText("Canvas comments")).toBeTruthy();
    expect(
      screen.getByText("Point at any block and say what is wrong with it, right on the page."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find out what's new" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(checkForAppUpdate).not.toHaveBeenCalled();
  });

  it("acknowledges the notes and hides the card when it is dismissed", async () => {
    const { hostBridge, acknowledgeWhatsNew } = bridge(dueNotes());
    render(<Harness hostBridge={hostBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());
    expect(screen.queryByText("New · v0.2.0")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the notes and acknowledges them when the card's button is pressed", async () => {
    const { hostBridge, acknowledgeWhatsNew } = bridge(dueNotes());
    render(<Harness hostBridge={hostBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Find out what's new" }));

    expect(await screen.findByRole("dialog", { name: "What's new" })).toBeTruthy();
    expect(screen.getByText("Octant 0.2.0")).toBeTruthy();
    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());
    expect(screen.queryByText("New · v0.2.0")).toBeNull();
  });

  it("shows nothing when the notes are not due or the build has none", async () => {
    const notDue = bridge(dueNotes({ showAfterApply: false }));
    const { unmount } = render(<Harness hostBridge={notDue.hostBridge} />);
    await waitFor(() => expect(notDue.readBundledWhatsNew).toHaveBeenCalledOnce());
    expect(screen.queryByText("New · v0.2.0")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    const empty = bridge({ kind: "empty", version: "0.2.0", showAfterApply: false });
    render(<Harness hostBridge={empty.hostBridge} />);
    await waitFor(() => expect(empty.readBundledWhatsNew).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("does not interrupt first-run setup", () => {
    const { hostBridge, readBundledWhatsNew } = bridge(dueNotes());
    render(<Harness firstRunVisible hostBridge={hostBridge} />);

    expect(readBundledWhatsNew).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("does not own this surface in a browser or remote client without the desktop bridge", () => {
    render(<Harness />);

    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the announcement instead of the card and acknowledges it on Not now", async () => {
    const { hostBridge, acknowledgeWhatsNew } = bridge(
      dueNotes({ announcement: { title: "Comment on a Canvas", body: "Point at a block." } }),
    );
    render(<Harness hostBridge={hostBridge} />);

    expect(await screen.findByRole("dialog", { name: "Comment on a Canvas" })).toBeTruthy();
    expect(screen.getByText("Point at a block.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "See what's new" })).toBeTruthy();
    expect(screen.queryByText("New · v0.2.0")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("New · v0.2.0")).toBeNull();
  });

  it("opens the notes from the announcement's primary button, with its own label and picture", async () => {
    const { hostBridge, acknowledgeWhatsNew } = bridge(
      dueNotes({
        announcement: {
          title: "Comment on a Canvas",
          body: "Point at a block.",
          actionLabel: "Show me",
          picture: { dataUrl: "data:image/png;base64,AAAA", alt: "A mark on a block" },
        },
      }),
    );
    render(<Harness hostBridge={hostBridge} />);

    expect(await screen.findByRole("img", { name: "A mark on a block" })).toHaveProperty(
      "src",
      "data:image/png;base64,AAAA",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show me" }));

    expect(await screen.findByRole("dialog", { name: "What's new" })).toBeTruthy();
    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());
  });

  it("splits the notes into a headline and the next paragraph for the card", () => {
    expect(
      whatsNewCardContent("1.0.0", "\n\n  Headline  \nstill the first paragraph\n\n\nSecond"),
    ).toEqual({
      version: "1.0.0",
      headline: "Headline",
      summary: "still the first paragraph",
    });
    expect(whatsNewCardContent("1.0.0", "Only a headline")).toEqual({
      version: "1.0.0",
      headline: "Only a headline",
    });
  });
});

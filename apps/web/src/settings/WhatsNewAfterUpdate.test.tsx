import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarWhatsNew } from "../shell/SidebarWhatsNew";
import type { BundledWhatsNew, OctantHostBridge } from "../shell/hostBridge";
import { AppUpdateSettings } from "./AppUpdateSettings";
import { WhatsNewAfterUpdate } from "./WhatsNewAfterUpdate";
import { resetWhatsNewAcknowledgement } from "./whatsNewAcknowledgement";
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
      <aside data-octant-sidebar>
        {controller.card === undefined ? null : (
          <SidebarWhatsNew
            content={controller.card}
            onDismiss={controller.dismiss}
            onOpenNotes={controller.openNotes}
          />
        )}
        <button aria-label="Account menu, Test" type="button" />
      </aside>
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

/** Settings' Updates row beside the shell, sharing one desktop bridge. */
function WithSettings(props: { readonly hostBridge: OctantHostBridge }) {
  return (
    <>
      <Harness hostBridge={props.hostBridge} />
      <AppUpdateSettings
        automaticChecks
        hostBridge={props.hostBridge}
        onAutomaticChecksChange={vi.fn()}
        onUpdateChannelChange={vi.fn()}
        updateChannel={undefined}
      />
    </>
  );
}

function settingsBridge(document: BundledWhatsNew) {
  const base = bridge(document);
  const idle = vi.fn(async () => undefined);
  const hostBridge = {
    ...base.hostBridge,
    downloadAppUpdate: idle,
    installAppUpdate: idle,
    setAutomaticAppUpdateChecks: idle,
    setAppUpdateRing: idle,
    subscribeAppUpdateState: vi.fn(() => () => undefined),
  } as unknown as OctantHostBridge;
  return { ...base, hostBridge };
}

describe("What's new after an update", () => {
  beforeEach(resetWhatsNewAcknowledgement);

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

  it("moves focus to the profile row when the card is dismissed", async () => {
    const { hostBridge } = bridge(dueNotes());
    render(<Harness hostBridge={hostBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Account menu/ }));
  });

  it("returns focus to the profile row when the notes dialog opened from the card closes", async () => {
    const { hostBridge } = bridge(dueNotes());
    render(<Harness hostBridge={hostBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Find out what's new" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Account menu/ })),
    );
  });

  it("returns focus to the profile row when the announcement is answered", async () => {
    const { hostBridge } = bridge(
      dueNotes({ announcement: { title: "Comment on a Canvas", body: "Point at a block." } }),
    );
    render(<Harness hostBridge={hostBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Account menu/ })),
    );
  });

  it("hides the card after the notes are opened from Settings, with one acknowledgement", async () => {
    const { hostBridge, acknowledgeWhatsNew } = settingsBridge(dueNotes());
    render(<WithSettings hostBridge={hostBridge} />);
    expect(await screen.findByText("New · v0.2.0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "What's new" }));

    await waitFor(() => expect(screen.queryByText("New · v0.2.0")).toBeNull());
    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());
  });

  it("does not acknowledge again when the notes are opened from Settings after the card was dismissed", async () => {
    const { hostBridge, acknowledgeWhatsNew } = settingsBridge(dueNotes());
    render(<WithSettings hostBridge={hostBridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));

    expect(await screen.findByText("Octant 0.2.0")).toBeTruthy();
    expect(acknowledgeWhatsNew).toHaveBeenCalledOnce();
  });

  it("does not show the announcement after Settings acknowledged the update", async () => {
    const { hostBridge, acknowledgeWhatsNew, readBundledWhatsNew } = settingsBridge(
      dueNotes({ announcement: { title: "Comment on a Canvas", body: "Point at a block." } }),
    );
    render(
      <AppUpdateSettings
        automaticChecks
        hostBridge={hostBridge}
        onAutomaticChecksChange={vi.fn()}
        onUpdateChannelChange={vi.fn()}
        updateChannel={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());

    render(<Harness hostBridge={hostBridge} />);

    await waitFor(() => expect(readBundledWhatsNew).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Comment on a Canvas" })).toBeNull();
    expect(acknowledgeWhatsNew).toHaveBeenCalledOnce();
  });
});

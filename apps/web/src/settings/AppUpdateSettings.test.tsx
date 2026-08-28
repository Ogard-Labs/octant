import {
  OCTANT_UPDATE_CHECK_DISCLOSURE,
  OCTANT_UPDATE_CHECK_INFERENCE,
} from "@octant/contracts/app-updates";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppUpdateSettings } from "./AppUpdateSettings";
import type { AppUpdateStateView, OctantHostBridge } from "../shell/hostBridge";

const ready: AppUpdateStateView = {
  status: "ready",
  currentVersion: "0.1.0" as AppUpdateStateView["currentVersion"],
  automaticChecks: true,
  ring: "stable",
};

function bridge(overrides: Partial<OctantHostBridge> = {}): OctantHostBridge {
  return {
    checkForAppUpdate: vi.fn(async () => ready),
    downloadAppUpdate: vi.fn(async () => ready),
    installAppUpdate: vi.fn(async () => ({ kind: "installing" }) as const),
    setAutomaticAppUpdateChecks: vi.fn(async () => ready),
    setAppUpdateRing: vi.fn(async () => ready),
    // The host pushes state; without an emission the surface is correctly idle.
    subscribeAppUpdateState: vi.fn((listener: (state: AppUpdateStateView) => void) => {
      listener(ready);
      return () => undefined;
    }),
    clearProviderCredential: vi.fn(),
    close: vi.fn(),
    maximizeOrRestore: vi.fn(),
    minimize: vi.fn(),
    ...overrides,
  } as unknown as OctantHostBridge;
}

function view(overrides: Partial<OctantHostBridge> = {}, automaticChecks = true) {
  const onAutomaticChecksChange = vi.fn();
  const onReleaseRingChange = vi.fn();
  const host = bridge(overrides);
  render(
    <AppUpdateSettings
      automaticChecks={automaticChecks}
      hostBridge={host}
      onAutomaticChecksChange={onAutomaticChecksChange}
      onReleaseRingChange={onReleaseRingChange}
    />,
  );
  return { host, onAutomaticChecksChange, onReleaseRingChange };
}

describe("AppUpdateSettings", () => {
  it("says what an update check sends, beside the switch that turns it off", () => {
    // The person deciding whether to leave checks on is the person who should
    // be able to read what those checks disclose.
    view();

    for (const item of OCTANT_UPDATE_CHECK_DISCLOSURE) {
      expect(screen.getByText(item)).toBeTruthy();
    }
    expect(screen.getByText(/no account, no Project, no thread, no usage/)).toBeTruthy();
  });

  it("says what the update service can work out, not only what is sent", () => {
    // A field list alone reads as reassurance; the inference is the part
    // somebody weighing the switch actually needs.
    view();

    for (const item of OCTANT_UPDATE_CHECK_INFERENCE) {
      expect(screen.getByText(item)).toBeTruthy();
    }
  });

  it("keeps a manual check available when automatic checking is off", () => {
    // Off means Octant stops asking on its own, not that the person loses the
    // ability to ask.
    view({}, false);

    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Check for updates automatically" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("turns automatic checking off in the host as well as the settings", async () => {
    // Off has to mean no request leaves the machine, so the host is told too
    // rather than the preference only being remembered.
    const { host, onAutomaticChecksChange } = view();

    fireEvent.click(screen.getByRole("switch", { name: "Check for updates automatically" }));

    expect(onAutomaticChecksChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(host.setAutomaticAppUpdateChecks).toHaveBeenCalledWith(false));
  });

  it("offers to relaunch once an update is staged, and never applies one on its own", async () => {
    const { host } = view();

    const relaunch = await screen.findByRole("button", { name: "Relaunch to update" });
    expect(host.installAppUpdate).not.toHaveBeenCalled();

    fireEvent.click(relaunch);

    await waitFor(() => expect(host.installAppUpdate).toHaveBeenCalledOnce());
  });

  it("says what it is waiting for rather than relaunching under live work", async () => {
    const { host } = view({
      installAppUpdate: vi.fn(async () => ({
        kind: "wait",
        activeAgentCount: 2,
        attentionRequired: true,
      })),
    } as Partial<OctantHostBridge>);

    fireEvent.click(await screen.findByRole("button", { name: "Relaunch to update" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /2 agents are still working and a thread is waiting on you/,
    );
    expect(host.installAppUpdate).toHaveBeenCalledOnce();
  });

  it("shows what the host refused rather than leaving the button spinning", async () => {
    // A misconfigured endpoint is refused by the host, and the person who has
    // to fix it needs to read why.
    view({
      checkForAppUpdate: vi.fn(async () => {
        throw new Error("OCTANT_UPDATE_FEED_URL must be an https URL");
      }),
    } as Partial<OctantHostBridge>);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/must be an https URL/);
    expect(screen.getByRole("button", { name: "Check for updates" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("moves to the preview ring and tells the host, not only the settings store", () => {
    // Both matter: the store is what survives a relaunch, and the host is what
    // the next check actually reads a feed from.
    const { host, onReleaseRingChange } = view();

    const rings = screen.getByRole("group", { name: "Release ring" });
    expect(within(rings).getByRole("button", { name: "Stable" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(within(rings).getByRole("button", { name: "Preview" }));

    expect(onReleaseRingChange).toHaveBeenCalledWith("preview");
    expect(host.setAppUpdateRing).toHaveBeenCalledWith("preview");
  });

  it("says plainly that a non-desktop client does not update itself", () => {
    render(
      <AppUpdateSettings
        automaticChecks
        hostBridge={{ close: vi.fn() } as unknown as OctantHostBridge}
        onAutomaticChecksChange={vi.fn()}
        onReleaseRingChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/not the desktop app, so it does not update itself/)).toBeTruthy();
  });
});

import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import type {
  DesktopLeaseSettings as LeaseSettings,
  DesktopPaneAnswer,
  DesktopPaneRequest,
} from "@octant/contracts/desktop-lease";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DesktopLeaseSettings } from "./DesktopLeaseSettings";

function hostWith(initial: Partial<LeaseSettings> = {}) {
  let settings: LeaseSettings = {
    confirmBilledDesktops: true,
    leasesPerThread: 2,
    hostLocalLeasesPerHost: 2,
    ...initial,
  };
  const request = vi.fn(async (sent: DesktopPaneRequest): Promise<DesktopPaneAnswer> => {
    if (sent.kind === "set-lease-settings") {
      settings = {
        confirmBilledDesktops: sent.confirmBilledDesktops ?? settings.confirmBilledDesktops,
        leasesPerThread: sent.leasesPerThread ?? settings.leasesPerThread,
        hostLocalLeasesPerHost: sent.hostLocalLeasesPerHost ?? settings.hostLocalLeasesPerHost,
      };
    }
    return { status: "lease-settings", settings };
  });
  const client: Pick<DesktopPaneClient, "request"> = { request };
  return { client, request };
}

describe("DesktopLeaseSettings", () => {
  it("shows the confirmation on by default and turns it off when the person switches it", async () => {
    const user = userEvent.setup();
    const { client, request } = hostWith();
    render(<DesktopLeaseSettings client={client} />);

    const confirm = await screen.findByRole("switch", { name: "Confirm each billed desktop" });
    await waitFor(() => expect(confirm).toBeChecked());
    await user.click(confirm);

    expect(request).toHaveBeenLastCalledWith({
      kind: "set-lease-settings",
      confirmBilledDesktops: false,
    });
    await waitFor(() => expect(confirm).not.toBeChecked());
  });

  it("sets how many desktops a thread and this host hold from the counts the host has", async () => {
    const user = userEvent.setup();
    const { client, request } = hostWith({ leasesPerThread: 3 });
    render(<DesktopLeaseSettings client={client} />);

    const perThread = await screen.findByRole("combobox", { name: "Desktops per thread" });
    await waitFor(() => expect(perThread).toHaveTextContent("3"));
    await user.click(perThread);
    await user.click(await screen.findByRole("option", { name: "5" }));
    expect(request).toHaveBeenLastCalledWith({ kind: "set-lease-settings", leasesPerThread: 5 });

    await user.click(screen.getByRole("combobox", { name: "Desktops on this host" }));
    await user.click(await screen.findByRole("option", { name: "1" }));
    expect(request).toHaveBeenLastCalledWith({
      kind: "set-lease-settings",
      hostLocalLeasesPerHost: 1,
    });
  });

  it("offers nothing to change in a window the host does not answer, such as a paired device", async () => {
    const request = vi.fn(
      async (): Promise<DesktopPaneAnswer> => ({ status: "refused", reason: "not-permitted" }),
    );
    render(<DesktopLeaseSettings client={{ request }} />);

    expect(await screen.findByText("Set on the computer Octant runs on.")).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Confirm each billed desktop" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByRole("combobox", { name: "Desktops per thread" })).toBeDisabled();
  });
});

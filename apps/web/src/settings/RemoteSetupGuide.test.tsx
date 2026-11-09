import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RemoteSetupGuide } from "./RemoteSetupGuide";

describe("remote setup", () => {
  it("distinguishes controlling a host, server commands and server folders before opening setup", async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    render(<RemoteSetupGuide canConfigureHost={true} onContinue={open} />);
    const guide = screen.getByRole("region", { name: "What do you want to do remotely?" });
    expect(within(guide).queryByRole("button", { name: /Continue/ })).toBeNull();

    await user.click(within(guide).getByRole("button", { name: "Control my Octant host" }));
    expect(guide).toHaveTextContent("Files, providers and the journal stay on the Octant host.");
    await user.click(within(guide).getByRole("button", { name: "Continue to pairing" }));
    expect(open).toHaveBeenLastCalledWith("control-host");

    await user.click(within(guide).getByRole("button", { name: "Run a command on a server" }));
    expect(guide).toHaveTextContent("Registration does not test a connection.");
    expect(guide).toHaveTextContent("Never repeat a command whose result is uncertain.");
    await user.click(
      within(guide).getByRole("button", { name: "Continue to server registration" }),
    );
    expect(open).toHaveBeenLastCalledWith("server-command");

    await user.click(within(guide).getByRole("button", { name: "Work in a server folder" }));
    expect(guide).toHaveTextContent("Only files and commands run on the server.");
    expect(guide).toHaveTextContent("Saved actions, extra folders");
    expect(guide).toHaveTextContent("Octant Harness");
    await user.click(within(guide).getByRole("button", { name: "Continue to server Projects" }));
    expect(open).toHaveBeenLastCalledWith("server-folder");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("focuses the real journey choices from the searchable checks setting", () => {
    render(
      <RemoteSetupGuide
        canConfigureHost={true}
        onContinue={() => {}}
        focusedSetting="remote-setup-checks"
      />,
    );
    expect(screen.getByRole("button", { name: "Control my Octant host" })).toHaveFocus();
  });

  it("directs a client without host controls to the host instead of offering an inert continuation", async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    render(<RemoteSetupGuide canConfigureHost={false} onContinue={open} />);
    await user.click(screen.getByRole("button", { name: "Control my Octant host" }));

    expect(
      screen.getByText(/Open Settings › Remote access in the Octant desktop app on the host/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue to pairing" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});

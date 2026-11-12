import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundHostChange, BackgroundHostState } from "../shell/hostBridge";
import { BackgroundHostSettings } from "./BackgroundHostSettings";

describe("BackgroundHostSettings", () => {
  it("starts with both switches off as the desktop reports them", async () => {
    render(
      <BackgroundHostSettings
        bridge={{
          readBackgroundHost: async () => ({
            status: "available",
            backgroundService: false,
            openAtLogin: false,
          }),
          changeBackgroundHost: vi.fn(),
        }}
      />,
    );

    expect(
      await screen.findByRole("switch", { name: "Keep Octant running in the background" }),
    ).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Open Octant at login" })).not.toBeChecked();
  });

  it("shows what the desktop read back after a change, not what was asked", async () => {
    const user = userEvent.setup();
    const changeBackgroundHost = vi.fn(
      async (_change: BackgroundHostChange): Promise<BackgroundHostState> => ({
        status: "available",
        backgroundService: false,
        openAtLogin: false,
        failure: "background-service",
      }),
    );
    render(
      <BackgroundHostSettings
        bridge={{
          readBackgroundHost: async () => ({
            status: "available",
            backgroundService: false,
            openAtLogin: false,
          }),
          changeBackgroundHost,
        }}
      />,
    );

    await user.click(
      await screen.findByRole("switch", { name: "Keep Octant running in the background" }),
    );

    expect(changeBackgroundHost).toHaveBeenCalledWith({ backgroundService: true });
    expect(
      screen.getByRole("switch", { name: "Keep Octant running in the background" }),
    ).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Octant could not change its background service.",
    );
  });

  it("offers nothing where the desktop cannot install a background host or on a remote client", async () => {
    const { container, rerender } = render(<BackgroundHostSettings bridge={undefined} />);
    expect(container).toBeEmptyDOMElement();

    const readBackgroundHost = vi.fn(
      async (): Promise<BackgroundHostState> => ({
        status: "unsupported",
      }),
    );
    rerender(
      <BackgroundHostSettings bridge={{ readBackgroundHost, changeBackgroundHost: vi.fn() }} />,
    );
    await vi.waitFor(() => expect(readBackgroundHost).toHaveBeenCalled());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("leaves out the login item where the system has none", async () => {
    render(
      <BackgroundHostSettings
        bridge={{
          readBackgroundHost: async () => ({ status: "available", backgroundService: true }),
          changeBackgroundHost: vi.fn(),
        }}
      />,
    );

    expect(
      await screen.findByRole("switch", { name: "Keep Octant running in the background" }),
    ).toBeChecked();
    expect(screen.queryByRole("switch", { name: "Open Octant at login" })).toBeNull();
  });
});

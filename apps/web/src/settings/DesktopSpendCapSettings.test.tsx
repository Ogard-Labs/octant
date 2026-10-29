import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import type { DesktopPaneAnswer, DesktopPaneRequest } from "@octant/contracts/desktop-lease";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DesktopSpendCapSettings } from "./DesktopSpendCapSettings";

function hostWith(cap: number | undefined, spent = 0) {
  let current = cap;
  const request = vi.fn(async (sent: DesktopPaneRequest): Promise<DesktopPaneAnswer> => {
    if (sent.kind === "set-spend-cap") current = sent.monthlyCapUsdCents;
    return {
      status: "spend",
      summary: {
        month: "2026-10",
        spentUsdCents: spent,
        ...(current === undefined ? {} : { monthlyCapUsdCents: current }),
      },
    };
  });
  const client: Pick<DesktopPaneClient, "request"> = { request };
  return { client, request };
}

describe("DesktopSpendCapSettings", () => {
  it("says desktops that bill are off until a cap is set, and sets the one the person typed", async () => {
    const user = userEvent.setup();
    const { client, request } = hostWith(undefined, 125);
    render(<DesktopSpendCapSettings client={client} />);

    expect(await screen.findByText("Off. $1.25 counted this month.")).toBeTruthy();
    const field = screen.getByLabelText("Monthly cap in US dollars");
    await user.type(field, "fifty");
    expect(screen.getByText("Enter the cap in dollars, such as 50.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set cap" })).toBeDisabled();
    await user.clear(field);
    await user.type(field, "50");
    await user.click(screen.getByRole("button", { name: "Set cap" }));

    expect(request).toHaveBeenLastCalledWith({ kind: "set-spend-cap", monthlyCapUsdCents: 5_000 });
    expect(await screen.findByText("$1.25 of $50.00 counted this month (UTC).")).toBeTruthy();
  });

  it("turns billed desktops off again by clearing the cap", async () => {
    const user = userEvent.setup();
    const { client, request } = hostWith(5_000);
    render(<DesktopSpendCapSettings client={client} />);
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(request).toHaveBeenLastCalledWith({ kind: "set-spend-cap" });
    expect(await screen.findByText("Off. $0.00 counted this month.")).toBeTruthy();
  });

  it("offers nothing to change in a window the host does not answer, such as a paired device", async () => {
    const request = vi.fn(
      async (): Promise<DesktopPaneAnswer> => ({
        status: "refused",
        reason: "spend-cap-local-only",
      }),
    );
    render(<DesktopSpendCapSettings client={{ request }} />);
    expect(await screen.findByText("Set on the computer Octant runs on.")).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Monthly cap in US dollars")).toBeDisabled());
    expect(screen.getByRole("button", { name: "Set cap" })).toBeDisabled();
  });
});

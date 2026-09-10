import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import { WhatsNewAfterUpdate } from "./WhatsNewAfterUpdate";

describe("WhatsNewAfterUpdate", () => {
  it("shows bundled notes after an applied update, without checking the feed", async () => {
    const readBundledWhatsNew = vi.fn(async () => ({
      kind: "notes" as const,
      version: "0.2.0",
      text: "The dock keeps pins.",
      showAfterApply: true,
    }));
    const acknowledgeWhatsNew = vi.fn(async () => undefined);
    const checkForAppUpdate = vi.fn();

    render(
      <WhatsNewAfterUpdate
        firstRunVisible={false}
        hostBridge={
          {
            acknowledgeWhatsNew,
            checkForAppUpdate,
            readBundledWhatsNew,
          } as unknown as OctantHostBridge
        }
      />,
    );

    expect(await screen.findByText("The dock keeps pins.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(checkForAppUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(acknowledgeWhatsNew).toHaveBeenCalledOnce());
  });

  it("does not interrupt first-run setup", () => {
    const readBundledWhatsNew = vi.fn();

    render(
      <WhatsNewAfterUpdate
        firstRunVisible
        hostBridge={{ readBundledWhatsNew } as unknown as OctantHostBridge}
      />,
    );

    expect(readBundledWhatsNew).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("does not own this surface on a remote client", () => {
    render(<WhatsNewAfterUpdate firstRunVisible={false} />);

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});

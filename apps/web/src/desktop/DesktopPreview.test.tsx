import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import { DesktopPreview } from "./DesktopPreview";

afterEach(cleanup);
const threadId = "f7000000-0000-4000-8000-000000000001";
const leaseId = "f7000000-0000-4000-8000-000000000002";
const reviewId = "f7000000-0000-4000-8000-000000000003";
const grantId = "f7000000-0000-4000-8000-000000000004";

describe("sharing a dev server with a desktop", () => {
  it("reviews scope before explicitly granting and lets the person stop sharing", async () => {
    const request = vi.fn<DesktopPaneClient["request"]>(async (input) => {
      if (input.kind === "preview-read") return { status: "preview-state", available: true };
      if (input.kind === "preview-review")
        return {
          status: "preview-review",
          reviewId,
          port: 5173,
          processName: "node",
          expiresAt: "2026-11-07T20:00:00Z",
        };
      if (input.kind === "preview-grant")
        return {
          status: "preview-ready",
          grant: {
            grantId,
            port: 5173,
            guestUrl: "http://127.0.0.1:5173/",
            expiresAt: "2026-11-07T20:00:00Z",
          },
        };
      return { status: "preview-revoked" };
    });
    render(
      <DesktopPreview
        client={{ request, frame: async () => ({ status: "no-frame" }) }}
        threadId={threadId}
        leaseId={leaseId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review preview" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review preview" }));
    await screen.findByRole("dialog", { name: "Share this dev server with the desktop?" });
    expect(request.mock.calls.some(([input]) => input.kind === "preview-grant")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Share preview" }));
    await screen.findByRole("button", { name: "Stop sharing" });
    expect(screen.getByText(/Inside this desktop, open/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await screen.findByText(/Preview sharing stopped/);
    expect(request.mock.calls.filter(([input]) => input.kind === "preview-grant")).toHaveLength(1);
  });

  it("keeps a failed grant uncertain without automatically resending it", async () => {
    const request = vi.fn<DesktopPaneClient["request"]>(async (input) => {
      if (input.kind === "preview-read") return { status: "preview-state", available: true };
      if (input.kind === "preview-review")
        return {
          status: "preview-review",
          reviewId,
          port: 5173,
          processName: "node",
          expiresAt: "2026-11-07T20:00:00Z",
        };
      throw new Error("connection lost");
    });
    render(
      <DesktopPreview
        client={{ request, frame: async () => ({ status: "no-frame" }) }}
        threadId={threadId}
        leaseId={leaseId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review preview" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Share preview" }));
    await screen.findByText(/Completion was not confirmed/);
    expect(request.mock.calls.filter(([input]) => input.kind === "preview-grant")).toHaveLength(1);
  });
});

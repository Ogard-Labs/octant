import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { decodeAppleSimulatorId } from "@octant/contracts/apple-toolchain";
import type { AppleSimulatorLiveFrame } from "@octant/domain";
import { AppleSimulatorLiveFrameView } from "./AppleSimulatorLiveFrame";

const simulatorId = decodeAppleSimulatorId("90000000-0000-4000-8000-000000000006");

describe("AppleSimulatorLiveFrameView", () => {
  it("states why the frame is unavailable on a host without Apple tooling", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "unavailable",
      reason: "toolchain-missing",
      title: "Simulator is unavailable",
      message:
        "Install or select Xcode and an iOS Simulator runtime on the Mac that owns this Code thread, then retry.",
    };
    expect(renderToStaticMarkup(<AppleSimulatorLiveFrameView frame={frame} />)).toContain(
      "Simulator is unavailable",
    );
    expect(renderToStaticMarkup(<AppleSimulatorLiveFrameView frame={frame} />)).not.toContain(
      "<video",
    );
  });

  it("keeps a remote client from presenting a fake live video", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "unavailable",
      reason: "not-attachable",
      title: "Simulator frame is not attachable",
      message:
        "This client cannot attach a live Simulator frame. Open the thread on the Mac that owns the destination.",
    };
    const html = renderToStaticMarkup(<AppleSimulatorLiveFrameView frame={frame} />);
    expect(html).toContain("not attachable");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<img");
  });

  it("labels stale-after-restart instead of showing the destination as live", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "stale-after-restart",
      simulatorId,
      name: "iPhone 16",
      lastScreen: { reference: "apple-screenshot-before-restart" },
      title: "Simulator is stale after restart",
      message:
        "Ownership was reconciled after a host restart. This is not a live frame until the destination is observed again.",
    };
    render(<AppleSimulatorLiveFrameView frame={frame} />);
    expect(screen.getByLabelText("iOS Simulator live frame")).toHaveAttribute(
      "data-status",
      "stale-after-restart",
    );
    expect(screen.getByText("Simulator is stale after restart")).toBeVisible();
    expect(screen.getByText("apple-screenshot-before-restart")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("reports a pending capture until the host-held image URL is available", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message:
        "Showing the latest host-held screen capture for this thread. This is not a video stream.",
    };
    render(<AppleSimulatorLiveFrameView frame={frame} />);
    expect(screen.getByText(/captured screen is not available/)).toBeVisible();
    expect(screen.queryByText(/Showing the latest/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows a live still from a host-held evidence URL, never a video element", () => {
    const frame: AppleSimulatorLiveFrame = {
      status: "live",
      simulatorId,
      name: "iPhone 16",
      screen: { kind: "screenshot", reference: "apple-screenshot-live" },
      title: "Live · iPhone 16",
      message:
        "Showing the latest host-held screen capture for this thread. This is not a video stream.",
    };
    render(
      <AppleSimulatorLiveFrameView frame={frame} screenUrl="blob:https://octant.local/screen" />,
    );
    expect(screen.getByLabelText("iOS Simulator live frame")).toHaveAttribute(
      "data-status",
      "live",
    );
    expect(screen.getByRole("img", { name: "iPhone 16 screen" })).toHaveAttribute(
      "src",
      "blob:https://octant.local/screen",
    );
    expect(document.querySelector("video")).toBeNull();
  });
});

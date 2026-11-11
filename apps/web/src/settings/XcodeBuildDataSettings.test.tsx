import type { XcodeBuildDataList } from "@octant/contracts/disk-cleanup";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { XcodeBuildDataSettings } from "./XcodeBuildDataSettings";

const list: XcodeBuildDataList = {
  kind: "xcode-build-data",
  available: true,
  entries: [
    {
      name: "App-gone",
      workspacePath: "/w/gone/App.xcodeproj",
      state: "orphaned",
      sizeBytes: 3 * 1024 * 1024,
      sizeComplete: true,
    },
    {
      name: "App-old",
      workspacePath: "/w/app/App.xcodeproj",
      state: "unused",
      sizeBytes: 1024,
      sizeComplete: true,
    },
  ],
};

function client(answer: XcodeBuildDataList = list) {
  const removeXcodeBuildData = vi.fn(async () => ({
    kind: "xcode-build-data-removed" as const,
    removed: ["App-gone"],
    kept: [],
  }));
  return {
    removeXcodeBuildData,
    fake: {
      worktrees: vi.fn(),
      scanWorktrees: vi.fn(),
      removeWorktree: vi.fn(),
      xcodeBuildData: vi.fn(async () => answer),
      removeXcodeBuildData,
    },
  };
}

describe("XcodeBuildDataSettings", () => {
  it("lists builds whose project is gone or unused, and removes the orphans after asking", async () => {
    const user = userEvent.setup();
    const { fake, removeXcodeBuildData } = client();
    render(<XcodeBuildDataSettings client={fake} />);
    expect(await screen.findByText("App-gone")).toBeVisible();
    expect(screen.getByText(/Project folder is gone/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove 1 whose project is gone" }));
    expect(removeXcodeBuildData).not.toHaveBeenCalled();
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove build data" }),
    );
    await waitFor(() => expect(removeXcodeBuildData).toHaveBeenCalledWith(["App-gone"]));
  });

  it("leaves the section out where the host has no Xcode", async () => {
    const { fake } = client({ kind: "xcode-build-data", available: false, entries: [] });
    const { container } = render(<XcodeBuildDataSettings client={fake} />);
    await waitFor(() => expect(fake.xcodeBuildData).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

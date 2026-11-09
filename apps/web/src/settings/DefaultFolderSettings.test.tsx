import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { joinDefaultFolderDisplayPath } from "./defaultFolderDisplay";
import { DefaultFolderSettings } from "./DefaultFolderSettings";

describe("DefaultFolderSettings", () => {
  it("shows the host-reported folder from home so its own name fits, with the full path on hover", () => {
    render(
      <DefaultFolderSettings folder="/Users/ada/Documents/Octant" onFolderChange={() => true} />,
    );

    const path = screen.getByText("~/Documents/Octant");
    expect(path).toBeVisible();
    expect(path).toHaveAttribute("title", "/Users/ada/Documents/Octant");
  });

  it("sends a trailing separator to the host instead of rewriting the path", async () => {
    const user = userEvent.setup();
    const onFolderChange = vi.fn(() => true);
    render(
      <DefaultFolderSettings
        folder="/Users/ada/Documents/Octant"
        onFolderChange={onFolderChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change" }));
    const input = screen.getByLabelText("Default folder");
    await user.clear(input);
    await user.type(input, "/Users/ada/Documents/Octant/");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onFolderChange).toHaveBeenCalledWith("/Users/ada/Documents/Octant/");
  });

  it("sends Windows absolute input unchanged to the host and preserves its refusal", async () => {
    const user = userEvent.setup();
    const onFolderChange = vi.fn(() => false);
    render(
      <DefaultFolderSettings
        folder="/Users/ada/Documents/Octant"
        onFolderChange={onFolderChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change" }));
    const input = screen.getByLabelText("Default folder");
    await user.clear(input);
    await user.type(input, "C:\\Users\\ada\\Documents\\Octant");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onFolderChange).toHaveBeenCalledWith("C:\\Users\\ada\\Documents\\Octant");
    expect(
      screen.getByText("The folder must be an absolute path inside your home folder."),
    ).toBeVisible();
    expect(input).toHaveValue("C:\\Users\\ada\\Documents\\Octant");
  });
});

describe("default-folder display paths", () => {
  it("joins a POSIX folder without doubling a trailing slash", () => {
    expect(joinDefaultFolderDisplayPath("/Users/ada/Documents/Octant", "Work")).toBe(
      "/Users/ada/Documents/Octant/Work",
    );
    expect(joinDefaultFolderDisplayPath("/Users/ada/Documents/Octant/", "Work")).toBe(
      "/Users/ada/Documents/Octant/Work",
    );
  });

  it("keeps a trailing backslash that is part of a POSIX folder name", () => {
    expect(joinDefaultFolderDisplayPath("/Volumes/work\\", "Work")).toBe("/Volumes/work\\/Work");
  });

  it("keeps a Windows-style separator when the host path already uses one", () => {
    expect(joinDefaultFolderDisplayPath("C:\\Users\\ada\\Documents\\Octant", "Code")).toBe(
      "C:\\Users\\ada\\Documents\\Octant\\Code",
    );
    expect(joinDefaultFolderDisplayPath("C:\\Users\\ada\\Documents\\Octant\\", "Code")).toBe(
      "C:\\Users\\ada\\Documents\\Octant\\Code",
    );
  });
});

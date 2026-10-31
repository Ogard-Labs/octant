import type { BrowserProfilesResult } from "@octant/contracts/browser-profiles";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserProfilesSection } from "./BrowserProfilesSection";

const projectId = "40000000-0000-4000-8000-000000000001" as never;
const listing: BrowserProfilesResult = {
  kind: "browser-profiles",
  profiles: [
    { profile: { kind: "personal" }, label: "Personal", sizeBytes: 0 },
    { profile: { kind: "project", projectId }, label: "Research", sizeBytes: 3 * 1024 * 1024 },
  ],
};

describe("BrowserProfilesSection", () => {
  it("lists each stored profile with its size", async () => {
    const manageProfiles = vi.fn(async () => listing);
    render(<BrowserProfilesSection client={{ manageProfiles }} />);

    expect(await screen.findByText("Personal · 0 B")).toBeInTheDocument();
    expect(screen.getByText("Research · 3.0 MB")).toBeInTheDocument();
    expect(manageProfiles).toHaveBeenCalledWith({ kind: "list" });
  });

  it("signs out of a profile only after the person confirms, then lists again", async () => {
    const user = userEvent.setup();
    const manageProfiles = vi.fn(async (command: { kind: string }) =>
      command.kind === "clear"
        ? ({
            kind: "browser-profile-cleared",
            profile: { kind: "project", projectId },
            scope: "all",
          } as BrowserProfilesResult)
        : listing,
    );
    render(<BrowserProfilesSection client={{ manageProfiles }} />);
    await screen.findByText("Research · 3.0 MB");

    await user.click(screen.getAllByRole("button", { name: "Sign out…" })[1]!);
    expect(manageProfiles).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(manageProfiles).toHaveBeenCalledWith({
        kind: "clear",
        profile: { kind: "project", projectId },
        scope: "all",
      }),
    );
    expect(await screen.findByText(/Signed out/)).toBeInTheDocument();
    await waitFor(() => expect(manageProfiles).toHaveBeenCalledTimes(3));
  });

  it("says in words why profiles are unavailable instead of listing nothing", async () => {
    const manageProfiles = vi.fn(
      async () =>
        ({
          kind: "browser-profiles-refused",
          reason: "profile-unavailable",
          message: "Browser profiles are kept by the Octant app, which is not running.",
        }) as BrowserProfilesResult,
    );
    render(<BrowserProfilesSection client={{ manageProfiles }} />);

    expect(
      await screen.findByText("Browser profiles are kept by the Octant app, which is not running."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out…" })).not.toBeInTheDocument();
  });

  it("reports a refused clear rather than claiming it signed out", async () => {
    const user = userEvent.setup();
    const manageProfiles = vi.fn(async (command: { kind: string }) =>
      command.kind === "clear"
        ? ({
            kind: "browser-profiles-refused",
            reason: "profile-unavailable",
            message: "The profile could not be cleared.",
          } as BrowserProfilesResult)
        : listing,
    );
    render(<BrowserProfilesSection client={{ manageProfiles }} />);
    await screen.findByText("Personal · 0 B");

    await user.click(screen.getAllByRole("button", { name: "Sign out…" })[0]!);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("The profile could not be cleared.")).toBeInTheDocument();
    expect(screen.queryByText(/^Signed out/)).not.toBeInTheDocument();
  });
});

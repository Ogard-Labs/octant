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

    await user.click(screen.getByRole("button", { name: "Sign out of Research" }));
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
    expect(screen.queryByRole("button", { name: /Sign out of/ })).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Sign out of Personal" }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("The profile could not be cleared.")).toBeInTheDocument();
    expect(screen.queryByText(/^Signed out/)).not.toBeInTheDocument();
  });

  it("clears only the cookies after a confirmation", async () => {
    const user = userEvent.setup();
    const manageProfiles = vi.fn(async (command: { kind: string }) =>
      command.kind === "clear"
        ? ({
            kind: "browser-profile-cleared",
            profile: { kind: "personal" },
            scope: "cookies",
          } as BrowserProfilesResult)
        : listing,
    );
    render(<BrowserProfilesSection client={{ manageProfiles }} />);
    await screen.findByText("Personal · 0 B");

    await user.click(screen.getByRole("button", { name: "Clear cookies in Personal" }));
    expect(manageProfiles).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Clear cookies" }));

    await waitFor(() =>
      expect(manageProfiles).toHaveBeenCalledWith({
        kind: "clear",
        profile: { kind: "personal" },
        scope: "cookies",
      }),
    );
    expect(await screen.findByText(/Cookies cleared/)).toBeInTheDocument();
  });

  describe("importing cookies", () => {
    const sources: BrowserProfilesResult = {
      kind: "browser-cookie-sources",
      sources: [
        {
          browser: "chrome",
          label: "Google Chrome",
          profiles: [
            { id: "Default", label: "Person 1" },
            { id: "Profile 2", label: "Work" },
          ],
        },
        {
          browser: "firefox",
          label: "Firefox",
          profiles: [{ id: "Profiles/a.default", label: "default" }],
        },
      ],
    };

    function answering(importResult: BrowserProfilesResult) {
      return vi.fn(async (command: { kind: string }) =>
        command.kind === "import-sources"
          ? sources
          : command.kind === "import-cookies"
            ? importResult
            : listing,
      );
    }

    it("reads nothing until the person has picked a browser and profile and pressed Import", async () => {
      const user = userEvent.setup();
      const manageProfiles = answering({
        kind: "browser-cookies-imported",
        profile: { kind: "personal" },
        browser: "chrome",
        sourceProfile: "Default",
        imported: 41,
        skipped: 3,
      });
      render(<BrowserProfilesSection client={{ manageProfiles }} />);
      await screen.findByText("Personal · 0 B");

      await user.click(screen.getByRole("button", { name: "Import cookies into Personal" }));

      expect(await screen.findByText(/macOS will ask you to allow access/)).toBeInTheDocument();
      await waitFor(() => expect(manageProfiles).toHaveBeenCalledWith({ kind: "import-sources" }));
      expect(manageProfiles).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "import-cookies" }),
      );

      await user.click(screen.getByRole("button", { name: "Import" }));

      await waitFor(() =>
        expect(manageProfiles).toHaveBeenCalledWith({
          kind: "import-cookies",
          profile: { kind: "personal" },
          browser: "chrome",
          sourceProfile: "Default",
        }),
      );
      expect(
        await screen.findByText(
          "Imported 41 cookies from Google Chrome into Personal (3 left behind).",
        ),
      ).toBeInTheDocument();
    });

    it("says plainly that nothing was imported when macOS access is refused", async () => {
      const user = userEvent.setup();
      const manageProfiles = answering({
        kind: "browser-profiles-refused",
        reason: "keychain-refused",
        message:
          "macOS did not allow Octant to read the browser's cookie key, so nothing was imported.",
      });
      render(<BrowserProfilesSection client={{ manageProfiles }} />);
      await screen.findByText("Personal · 0 B");

      await user.click(screen.getByRole("button", { name: "Import cookies into Personal" }));
      await user.click(await screen.findByRole("button", { name: "Import" }));

      expect(
        await screen.findByText(/did not allow Octant to read the browser's cookie key/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Imported/)).not.toBeInTheDocument();
    });

    it("says so when no other browser is on the Mac and offers no Import", async () => {
      const user = userEvent.setup();
      const manageProfiles = vi.fn(async (command: { kind: string }) =>
        command.kind === "import-sources"
          ? ({ kind: "browser-cookie-sources", sources: [] } as BrowserProfilesResult)
          : listing,
      );
      render(<BrowserProfilesSection client={{ manageProfiles }} />);
      await screen.findByText("Personal · 0 B");

      await user.click(screen.getByRole("button", { name: "Import cookies into Personal" }));

      expect(
        await screen.findByText("No other browser with cookies was found on this Mac."),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    });

    it("lets the person cancel without anything being read", async () => {
      const user = userEvent.setup();
      const manageProfiles = answering({
        kind: "browser-profiles-refused",
        reason: "source-not-found",
        message: "nope",
      });
      render(<BrowserProfilesSection client={{ manageProfiles }} />);
      await screen.findByText("Personal · 0 B");

      await user.click(screen.getByRole("button", { name: "Import cookies into Personal" }));
      await user.click(await screen.findByRole("button", { name: "Cancel" }));

      expect(manageProfiles).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "import-cookies" }),
      );
    });
  });
});

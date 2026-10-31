import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserProfileControl } from "./BrowserProfileControl";
import {
  browserApprovalDetail,
  browserApprovalSummary,
  formatProfileSize,
  readRememberedProfileChoice,
  writeRememberedProfileChoice,
} from "./browserProfileCopy";

const projectId = "40000000-0000-4000-8000-000000000001" as never;

describe("BrowserProfileControl", () => {
  it("names the profile the page is in and offers the three choices", async () => {
    const user = userEvent.setup();
    render(
      <BrowserProfileControl
        onChange={vi.fn()}
        profile="private"
        projectProfileAvailable
        signedInPagesAvailable
      />,
    );

    await user.click(screen.getByRole("button", { name: "Browser profile: Private" }));

    expect(await screen.findByRole("menuitemradio", { name: "Private" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Personal" })).toBeInTheDocument();
  });

  it("reports the choice the person made", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <BrowserProfileControl
        onChange={onChange}
        profile="private"
        projectProfileAvailable
        signedInPagesAvailable
      />,
    );

    await user.click(screen.getByRole("button", { name: "Browser profile: Private" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Personal" }));

    expect(onChange).toHaveBeenCalledWith("personal");
  });

  it("says why a signed-in profile cannot be chosen outside the desktop app", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <BrowserProfileControl
        onChange={onChange}
        profile="private"
        projectProfileAvailable
        signedInPagesAvailable={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Browser profile: Private" }));
    const personal = await screen.findByRole("menuitemradio", { name: "Personal" });

    expect(personal).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByText("Signed-in pages open in the Octant app only.").length,
    ).toBeGreaterThan(0);
    await user.click(personal);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers sign out only for a stored profile and asks before it clears anything", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn(async () => undefined);
    const { rerender } = render(
      <BrowserProfileControl
        onChange={vi.fn()}
        onSignOut={onSignOut}
        profile="private"
        projectProfileAvailable
        signedInPagesAvailable
      />,
    );
    await user.click(screen.getByRole("button", { name: "Browser profile: Private" }));
    await screen.findByRole("menuitemradio", { name: "Private" });
    expect(screen.queryByRole("menuitem", { name: /Sign out/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    rerender(
      <BrowserProfileControl
        onChange={vi.fn()}
        onSignOut={onSignOut}
        profile="personal"
        projectProfileAvailable
        signedInPagesAvailable
      />,
    );
    await user.click(screen.getByRole("button", { name: "Browser profile: Personal" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out of this profile…" }));

    expect(onSignOut).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/cookies, site storage and cache are removed/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledOnce());
  });
});

describe("browser profile copy", () => {
  it("asks about a Private page by site and about a signed-in page by site and profile", () => {
    expect(browserApprovalSummary({ origin: "https://example.com" })).toBe(
      "Allow Browser to open https://example.com?",
    );
    expect(
      browserApprovalSummary({ origin: "https://github.com", profile: { kind: "personal" } }),
    ).toBe("Let the agent use https://github.com in the Personal profile?");
    expect(
      browserApprovalSummary({
        origin: "https://staging.example.com",
        profile: { kind: "project", projectId },
      }),
    ).toBe("Let the agent use https://staging.example.com in the Project profile?");
    expect(browserApprovalDetail({ profile: { kind: "personal" } })).toMatch(/signed in as you/);
    expect(browserApprovalDetail({})).toBe("Shell and file access stay unchanged");
  });

  it("remembers the person's last choice for a Project and falls back to Private", () => {
    globalThis.localStorage?.clear();
    expect(readRememberedProfileChoice("p1")).toBe("private");
    writeRememberedProfileChoice("p1", "project");
    expect(readRememberedProfileChoice("p1")).toBe("project");
    expect(readRememberedProfileChoice("p2")).toBe("private");
    globalThis.localStorage?.setItem("octant.browser.profile.p3", "admin");
    expect(readRememberedProfileChoice("p3")).toBe("private");
  });

  it("writes sizes a person can read", () => {
    expect(formatProfileSize(0)).toBe("0 B");
    expect(formatProfileSize(2048)).toBe("2.0 KB");
    expect(formatProfileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

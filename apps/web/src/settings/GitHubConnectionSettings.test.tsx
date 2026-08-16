import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GithubAuthenticationCommand, GithubAuthenticationSnapshot } from "@octant/contracts";
import type { GithubClient } from "@octant/client-runtime/github-client";
import { GitHubConnectionSettings } from "./GitHubConnectionSettings";

const readySnapshot: GithubAuthenticationSnapshot = {
  state: "ready",
  account: {
    login: "octocat",
    gitProtocol: "https",
    scopes: ["read:org", "repo"],
  },
  capabilities: [
    { kind: "repository-catalogue", available: true },
    { kind: "issues-read", available: true },
    { kind: "pull-requests-read", available: true },
    {
      kind: "projects-read",
      available: false,
      remediation: "Grant read:project to enable Projects metadata.",
    },
  ],
};

const unauthorizedSnapshot: GithubAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [],
  remediation: "Set up GitHub to browse repositories.",
};

interface ClientOverrides {
  readonly authenticationSnapshot?: () => Promise<GithubAuthenticationSnapshot>;
  readonly executeAuthenticationCommand?: (
    command: GithubAuthenticationCommand,
  ) => Promise<GithubAuthenticationSnapshot>;
}

function makeClient(overrides: ClientOverrides = {}): GithubClient {
  return {
    authenticationSnapshot: overrides.authenticationSnapshot ?? (async () => readySnapshot),
    executeAuthenticationCommand:
      overrides.executeAuthenticationCommand ?? (async () => readySnapshot),
    readCatalogue: async () => {
      throw new Error("not used");
    },
    recordRecentRepository: async () => {
      throw new Error("not used");
    },
  };
}

describe("GitHubConnectionSettings", () => {
  it("renders the compact account and per-capability state", async () => {
    render(<GitHubConnectionSettings client={makeClient()} />);

    expect(await screen.findByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByText("Issues")).toBeInTheDocument();
    expect(screen.getByText("Pull requests")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Grant read:project to enable Projects metadata.")).toBeInTheDocument();
  });

  it("shows an honest transport failure and recovers through retry", async () => {
    let failures = 1;
    const authenticationSnapshot = vi.fn(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("GitHub is unavailable.");
      }
      return readySnapshot;
    });
    render(<GitHubConnectionSettings client={makeClient({ authenticationSnapshot })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("octocat")).toBeInTheDocument();
  });

  it("offers setup when unauthorized and renders the returned device-flow handoff", async () => {
    const executeAuthenticationCommand = vi.fn(
      async (): Promise<GithubAuthenticationSnapshot> => ({
        ...unauthorizedSnapshot,
        interaction: {
          kind: "device-flow",
          verificationUri: "https://github.com/login/device",
          userCode: "ABCD-1234",
        },
      }),
    );
    render(
      <GitHubConnectionSettings
        client={makeClient({
          authenticationSnapshot: async () => unauthorizedSnapshot,
          executeAuthenticationCommand,
        })}
      />,
    );

    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Set up GitHub to browse repositories.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up GitHub" }));

    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    const deviceLink = screen.getByRole("link", { name: /github\.com\/login\/device/ });
    expect(deviceLink).toHaveAttribute("href", "https://github.com/login/device");
    expect(executeAuthenticationCommand).toHaveBeenCalledWith({
      kind: "setup",
      confirmation: "confirm-github-setup",
    });
  });

  it("requests the read:project scope through the exact refresh command", async () => {
    const executeAuthenticationCommand = vi.fn(async () => readySnapshot);
    render(<GitHubConnectionSettings client={makeClient({ executeAuthenticationCommand })} />);

    await screen.findByText("octocat");
    fireEvent.click(screen.getByRole("button", { name: "Enable Projects metadata" }));

    await waitFor(() =>
      expect(executeAuthenticationCommand).toHaveBeenCalledWith({
        kind: "refresh",
        confirmation: "confirm-github-refresh",
        scopes: ["read:project"],
      }),
    );
  });

  it("requires a second explicit confirmation before the local logout command", async () => {
    const executeAuthenticationCommand = vi.fn(async () => unauthorizedSnapshot);
    render(<GitHubConnectionSettings client={makeClient({ executeAuthenticationCommand })} />);

    await screen.findByText("octocat");
    fireEvent.click(screen.getByRole("button", { name: "Log out on this host" }));
    expect(executeAuthenticationCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm local logout" }));
    await waitFor(() =>
      expect(executeAuthenticationCommand).toHaveBeenCalledWith({
        kind: "logout",
        confirmation: "confirm-github-local-logout",
      }),
    );
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
  });

  it("keeps GitHub-side revocation guidance distinct from local logout", async () => {
    render(<GitHubConnectionSettings client={makeClient()} />);
    await screen.findByText("octocat");

    expect(screen.getByText(/does not revoke Octant's GitHub authorization/)).toBeInTheDocument();
    const revokeLink = screen.getByRole("link", { name: /GitHub application settings/ });
    expect(revokeLink).toHaveAttribute("href", "https://github.com/settings/applications");
  });

  it("keeps advanced diagnostics behind an explicit disclosure", async () => {
    render(<GitHubConnectionSettings client={makeClient()} />);
    await screen.findByText("octocat");

    expect(screen.queryByText("read:org")).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: "Advanced diagnostics" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("read:org")).toBeInTheDocument();
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(screen.getByText("https")).toBeInTheDocument();
  });

  it("shows a fail-closed storage posture with remediation and no setup control", async () => {
    render(
      <GitHubConnectionSettings
        client={makeClient({
          authenticationSnapshot: async () => ({
            state: "insecure-storage",
            capabilities: [],
            remediation: "Configure an operating-system credential store, then reauthenticate.",
          }),
        })}
      />,
    );

    expect(await screen.findByText("Blocked: insecure credential storage")).toBeInTheDocument();
    expect(
      screen.getByText("Configure an operating-system credential store, then reauthenticate."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up GitHub" })).not.toBeInTheDocument();
  });

  it("reports a refused command without losing the current snapshot", async () => {
    const executeAuthenticationCommand = vi.fn(async () => {
      throw new Error("GitHub request is unauthorized.");
    });
    render(<GitHubConnectionSettings client={makeClient({ executeAuthenticationCommand })} />);
    await screen.findByText("octocat");

    fireEvent.click(screen.getByRole("button", { name: "Enable Projects metadata" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub request is unauthorized.");
    expect(screen.getByText("octocat")).toBeInTheDocument();
  });

  it("completes a load, refresh, scope, and logout walkthrough with zero console errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<GitHubConnectionSettings client={makeClient()} />);
      await screen.findByText("octocat");

      fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
      await screen.findByText("octocat");
      fireEvent.click(screen.getByRole("button", { name: "Enable Projects metadata" }));
      await screen.findByText("octocat");
      fireEvent.click(screen.getByRole("button", { name: "Log out on this host" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm local logout" }));
      await screen.findByText("octocat");

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps every control keyboard-reachable and traversable in order", async () => {
    const user = userEvent.setup();
    render(<GitHubConnectionSettings client={makeClient()} />);
    await screen.findByText("octocat");

    const refresh = screen.getByRole("button", { name: "Refresh status" });
    refresh.focus();
    expect(refresh).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Enable Projects metadata" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Log out on this host" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: /GitHub application settings/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Advanced diagnostics" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByText("read:org")).toBeInTheDocument();
  });

  // Zoom / contrast / motion coverage is documented through the owned
  // stylesheet because jsdom does not apply media queries: the fact grid
  // collapses to one column in narrow layouts, values wrap for 200% zoom
  // reflow, and the section declares no animation so reduced motion holds by
  // construction.
  it("keeps the section readable in narrow layouts, at 200% zoom, and under motion settings", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");
    const githubStyles = styles.slice(styles.indexOf(".github-settings"));

    expect(githubStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.github-settings__facts\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(githubStyles).toContain("overflow-wrap: anywhere");
    expect(githubStyles).not.toContain("animation");
  });
});

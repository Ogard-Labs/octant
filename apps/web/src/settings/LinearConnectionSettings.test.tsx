import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  IntegrationAuthenticationCommand,
  IntegrationAuthenticationSnapshot,
} from "@octant/contracts/integration";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import { LinearConnectionSettings } from "./LinearConnectionSettings";

const readySnapshot: IntegrationAuthenticationSnapshot = {
  state: "ready",
  account: { login: "ogard-labs", source: "oauth", scopes: ["read"] },
  capabilities: [],
};

const unauthorizedSnapshot: IntegrationAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [],
  remediation: "Connect Linear to authorize this host.",
};

const reconnectSnapshot: IntegrationAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [],
  remediation: "The Linear authorization expired. Reconnect to continue.",
};

function makeClient(
  overrides: {
    readonly authenticationSnapshot?: () => Promise<IntegrationAuthenticationSnapshot>;
    readonly executeAuthenticationCommand?: (
      command: IntegrationAuthenticationCommand,
    ) => Promise<IntegrationAuthenticationSnapshot>;
  } = {},
): IntegrationClient {
  return {
    authenticationSnapshot: overrides.authenticationSnapshot ?? (async () => readySnapshot),
    executeAuthenticationCommand:
      overrides.executeAuthenticationCommand ?? (async () => readySnapshot),
    storePersonalCredential: async () => {},
    deletePersonalCredential: async () => {},
  };
}

describe("LinearConnectionSettings", () => {
  it("renders the connected workspace identity without token material", async () => {
    render(<LinearConnectionSettings client={makeClient()} />);
    expect(await screen.findByText("ogard-labs")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("oauth")).toBeInTheDocument();
    expect(screen.queryByText(/access_token|refresh_token|lin_api_/i)).not.toBeInTheDocument();
  });

  it("offers Connect when unauthorized", async () => {
    render(
      <LinearConnectionSettings
        client={makeClient({ authenticationSnapshot: async () => unauthorizedSnapshot })}
      />,
    );
    expect(await screen.findByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("surfaces Reconnect after an expired grant and does not show Connect as a loop", async () => {
    render(
      <LinearConnectionSettings
        client={makeClient({ authenticationSnapshot: async () => reconnectSnapshot })}
      />,
    );
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("opens the authorization URL returned by setup", async () => {
    const executeAuthenticationCommand = vi.fn(async () => ({
      ...unauthorizedSnapshot,
      interaction: {
        kind: "authorization-redirect" as const,
        authorizationUri: "https://linear.app/oauth/authorize?client_id=public",
      },
    }));
    render(
      <LinearConnectionSettings
        client={makeClient({
          authenticationSnapshot: async () => unauthorizedSnapshot,
          executeAuthenticationCommand,
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("link", { name: "Approve access" })).toHaveAttribute(
      "href",
      "https://linear.app/oauth/authorize?client_id=public",
    );
  });

  it("disconnects after confirmation", async () => {
    const executeAuthenticationCommand = vi.fn(async () => unauthorizedSnapshot);
    render(
      <LinearConnectionSettings
        client={makeClient({
          executeAuthenticationCommand,
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(executeAuthenticationCommand).toHaveBeenCalledWith({ kind: "logout" });
  });

  it("keeps the personal API key behind an advanced disclosure", async () => {
    render(<LinearConnectionSettings client={makeClient()} />);
    await screen.findByText("ogard-labs");
    expect(screen.queryByLabelText("Personal API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Personal API key" }));
    expect(screen.getByLabelText("Personal API key")).toBeInTheDocument();
  });
});

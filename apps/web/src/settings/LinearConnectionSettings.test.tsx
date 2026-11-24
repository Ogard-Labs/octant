import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeProjectSummary } from "@octant/contracts";
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
    executeOperation: async () => ({ kind: "refused", reason: "Not used." }),
    listIssues: async () => ({ rows: [], hasNextPage: false }),
    getIssue: async () => {
      throw new Error("Not used.");
    },
    listIssueFilters: async () => ({ teams: [], states: [], assignees: [], projects: [] }),
    storePersonalCredential: async () => {},
    deletePersonalCredential: async () => {},
  };
}

describe("LinearConnectionSettings", () => {
  it("keeps fields and their draft mounted while refreshing connection status", async () => {
    const pending = Promise.withResolvers<IntegrationAuthenticationSnapshot>();
    const authenticationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(readySnapshot)
      .mockReturnValueOnce(pending.promise);
    render(<LinearConnectionSettings client={makeClient({ authenticationSnapshot })} />);
    await screen.findByText("ogard-labs");
    fireEvent.click(screen.getByRole("button", { name: "Personal API key" }));
    const input = screen.getByLabelText("Personal API key");
    fireEvent.change(input, { target: { value: "unsaved-local-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(screen.getByLabelText("Personal API key")).toBe(input);
    expect(input).toHaveValue("unsaved-local-draft");
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeDisabled();
    await act(async () => pending.reject(new Error("Status refresh failed")));
    expect(screen.getByLabelText("Personal API key")).toBe(input);
    expect(await screen.findByText("Status refresh failed")).toBeVisible();
  });

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
    const user = userEvent.setup();
    const executeAuthenticationCommand = vi.fn(async () => unauthorizedSnapshot);
    render(
      <LinearConnectionSettings
        client={makeClient({
          executeAuthenticationCommand,
        })}
      />,
    );
    const opener = await screen.findByRole("button", { name: "Disconnect" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "Disconnect Linear?" })).toBeInTheDocument();
    // The dialog moves focus to Cancel on the frame after it opens.
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(executeAuthenticationCommand).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(executeAuthenticationCommand).not.toHaveBeenCalled();

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(executeAuthenticationCommand).not.toHaveBeenCalled();
    await user.click(opener);
    await user.click(screen.getByTestId("octant-dialog-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(executeAuthenticationCommand).not.toHaveBeenCalled();
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(executeAuthenticationCommand).toHaveBeenCalledWith({ kind: "logout" });
  });

  it("keeps the personal API key behind an advanced disclosure", async () => {
    render(<LinearConnectionSettings client={makeClient()} />);
    await screen.findByText("ogard-labs");
    expect(screen.queryByLabelText("Personal API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Personal API key" }));
    expect(screen.getByLabelText("Personal API key")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create one" })).toHaveAttribute(
      "href",
      "https://linear.app/settings/account/security",
    );
  });

  it("shows connected user, linked project count, stored-key hint, and project mapping controls", async () => {
    const onProjectLinearTargetChange = vi.fn(async () => true);
    const snapshot: IntegrationAuthenticationSnapshot = {
      state: "ready",
      account: {
        login: "ogard-labs",
        displayName: "Henrik",
        workspace: "Ogard Labs",
        source: "personal-api-key",
        scopes: ["read"],
      },
      capabilities: [{ operationId: "list-issues", available: true }],
      personalCredentialStored: true,
    };
    const client: IntegrationClient = {
      ...makeClient({ authenticationSnapshot: async () => snapshot }),
      listIssueFilters: async () => ({
        teams: [{ id: "team-oct", label: "Octant (OCT)", key: "OCT", name: "Octant" }],
        states: [],
        assignees: [],
        projects: [{ id: "proj-1", label: "Preview 1" }],
      }),
    };
    const projects = [
      decodeProjectSummary({
        id: "11111111-1111-4111-8111-111111111111",
        name: "octant",
        type: "code",
        lifecycle: "active",
        pinned: false,
        rank: "1/1",
        version: 1,
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
        binding: { canonicalRoot: "/tmp/octant" },
        bindingRevisionId: "22222222-2222-4222-8222-222222222222",
        codeAccessPersistence: "current-session",
        linearTarget: { teamId: "team-oct", teamKey: "OCT", teamName: "Octant" },
      }),
    ];

    render(
      <LinearConnectionSettings
        client={client}
        onProjectLinearTargetChange={onProjectLinearTargetChange}
        projects={projects}
      />,
    );
    expect(await screen.findByText("Henrik")).toBeInTheDocument();
    expect(screen.getByText("1 project linked")).toBeInTheDocument();
    expect(await screen.findByText("octant")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Personal API key" }));
    expect(screen.getByLabelText("Personal API key")).toHaveAttribute(
      "placeholder",
      "Stored secret, enter a new key to replace",
    );
  });
});

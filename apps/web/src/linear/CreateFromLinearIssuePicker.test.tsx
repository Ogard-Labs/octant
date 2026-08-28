import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { LinearIssueListPage } from "@octant/contracts/linear-issues";
import {
  CreateFromLinearIssuePicker,
  useLinearIssuesCreateAvailable,
} from "./CreateFromLinearIssuePicker";

const readySnapshot: IntegrationAuthenticationSnapshot = {
  state: "ready",
  capabilities: [
    { operationId: "list-issues", available: true },
    { operationId: "get-issue", available: true },
  ],
};

const unauthorizedSnapshot: IntegrationAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [{ operationId: "list-issues", available: false }],
};

const page: LinearIssueListPage = {
  rows: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      identifier: "ENG-12",
      title: "Browse issues in the workspace",
      state: { name: "In Progress", type: "started" },
      assignee: "Ada",
      url: "https://linear.app/ogard-labs/issue/ENG-12",
    },
  ],
  hasNextPage: false,
};

function makeClient(
  snapshot: IntegrationAuthenticationSnapshot = readySnapshot,
  overrides: {
    readonly listIssues?: () => Promise<LinearIssueListPage>;
  } = {},
): IntegrationClient {
  return {
    authenticationSnapshot: vi.fn(async () => snapshot),
    executeAuthenticationCommand: async () => snapshot,
    executeOperation: async () => ({ kind: "refused", reason: "not used" }),
    listIssues: overrides.listIssues ?? (async () => page),
    getIssue: async () => {
      throw new Error("not used");
    },
    listIssueFilters: async () => ({ teams: [], states: [], assignees: [], projects: [] }),
    storePersonalCredential: async () => {},
    deletePersonalCredential: async () => {},
  };
}

function AvailabilityProbe(props: {
  readonly client?: IntegrationClient;
  readonly pluginEnabled: boolean;
}) {
  const available = useLinearIssuesCreateAvailable(props.client, props.pluginEnabled);
  return <div>{available ? "linear-create-available" : "linear-create-hidden"}</div>;
}

describe("Create from Linear issue picker", () => {
  it("attaches only the opaque node id when an issue is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CreateFromLinearIssuePicker client={makeClient()} onSelect={onSelect} />);
    await user.click(
      await screen.findByRole("button", { name: /ENG-12 Browse issues in the workspace/ }),
    );
    expect(onSelect).toHaveBeenCalledWith({
      id: "11111111-1111-4111-8111-111111111111",
      identifier: "ENG-12",
    });
    expect(onSelect.mock.calls[0]?.[0]).not.toHaveProperty("title");
    expect(onSelect.mock.calls[0]?.[0]).not.toHaveProperty("description");
  });

  it("hides create-from-issue when the plugin is disabled", async () => {
    render(<AvailabilityProbe client={makeClient()} pluginEnabled={false} />);
    expect(await screen.findByText("linear-create-hidden")).toBeVisible();
  });

  it("hides create-from-issue when list-issues is unavailable", async () => {
    render(<AvailabilityProbe client={makeClient(unauthorizedSnapshot)} pluginEnabled={true} />);
    expect(await screen.findByText("linear-create-hidden")).toBeVisible();
  });

  it("shows create-from-issue when connected with list-issues", async () => {
    render(<AvailabilityProbe client={makeClient()} pluginEnabled={true} />);
    await waitFor(() => expect(screen.getByText("linear-create-available")).toBeVisible());
  });

  it("does not throw when the client has no snapshot method", async () => {
    const stub = {} as IntegrationClient;
    expect(() => render(<AvailabilityProbe client={stub} pluginEnabled={true} />)).not.toThrow();
    expect(await screen.findByText("linear-create-hidden")).toBeVisible();
  });
});

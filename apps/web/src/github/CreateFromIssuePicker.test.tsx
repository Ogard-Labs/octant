import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  GithubAuthenticationSnapshot,
  GithubCatalogueReadRequest,
  GithubCatalogueReadResponse,
} from "@octant/contracts";
import type { GithubClient } from "@octant/client-runtime/github-client";
import { CreateFromIssuePicker, useGithubIssuesCreateAvailable } from "./CreateFromIssuePicker";

const readySnapshot: GithubAuthenticationSnapshot = {
  state: "ready",
  account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
  capabilities: [
    { kind: "repository-catalogue", available: true },
    { kind: "issues-read", available: true },
    { kind: "pull-requests-read", available: true },
    { kind: "projects-read", available: true },
  ],
};

const unauthorizedSnapshot: GithubAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [],
};

function makeClient(
  snapshot: GithubAuthenticationSnapshot = readySnapshot,
  overrides: {
    readonly readCatalogue?: (
      request: GithubCatalogueReadRequest,
    ) => Promise<GithubCatalogueReadResponse>;
  } = {},
): GithubClient {
  return {
    authenticationSnapshot: vi.fn(async () => snapshot),
    executeAuthenticationCommand: async () => snapshot,
    readCatalogue:
      overrides.readCatalogue ??
      (async (request) => {
        if (request.kind === "recent-repositories") {
          return { kind: "recent-repositories", rows: [] };
        }
        if (request.kind === "repositories") {
          return {
            kind: "repositories",
            page: {
              rows: [
                {
                  nodeId: "R_node1",
                  owner: "octant",
                  name: "octant",
                  visibility: "private",
                  defaultBranch: "development",
                  viewerPermission: "admin",
                  capabilities: [{ kind: "issues-read", available: true }],
                },
              ],
              sort: "pushed-desc",
              hasNextPage: false,
              freshness: { status: "fresh" },
            },
          };
        }
        if (request.kind === "issues") {
          return {
            kind: "issues",
            page: {
              rows: [
                {
                  number: 7,
                  title: "Flaky search",
                  state: "open",
                  author: "octocat",
                  updatedAt: "2026-08-11T10:00:00Z",
                  url: "https://github.com/octant/octant/issues/7",
                },
              ],
              sort: "updated-desc",
              hasNextPage: false,
              freshness: { status: "fresh" },
            },
          };
        }
        return { kind: "unavailable", capability: "issues-read", reason: "unavailable" };
      }),
    recordRecentRepository: vi.fn(
      async () => ({ kind: "recent-repositories", rows: [] }) as GithubCatalogueReadResponse,
    ),
  };
}

function AvailabilityProbe(props: {
  readonly client?: GithubClient;
  readonly pluginEnabled: boolean;
}) {
  const available = useGithubIssuesCreateAvailable(props.client, props.pluginEnabled);
  return <div>{available ? "issues-create-available" : "issues-create-hidden"}</div>;
}

describe("Create from issue picker", () => {
  it("attaches only owner, name, and number when an issue is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CreateFromIssuePicker client={makeClient()} onSelect={onSelect} />);
    await user.click(await screen.findByText("octant/octant"));
    await user.click(await screen.findByRole("button", { name: /#7 Flaky search/ }));
    expect(onSelect).toHaveBeenCalledWith({ owner: "octant", name: "octant", number: 7 });
    expect(onSelect.mock.calls[0]?.[0]).not.toHaveProperty("title");
    expect(onSelect.mock.calls[0]?.[0]).not.toHaveProperty("body");
  });

  it("hides create-from-issue when the plugin is disabled", async () => {
    render(<AvailabilityProbe client={makeClient()} pluginEnabled={false} />);
    expect(await screen.findByText("issues-create-hidden")).toBeVisible();
  });

  it("hides create-from-issue when issues-read is unavailable", async () => {
    render(<AvailabilityProbe client={makeClient(unauthorizedSnapshot)} pluginEnabled={true} />);
    expect(await screen.findByText("issues-create-hidden")).toBeVisible();
  });

  it("shows create-from-issue when connected with issues-read", async () => {
    render(<AvailabilityProbe client={makeClient()} pluginEnabled={true} />);
    await waitFor(() => expect(screen.getByText("issues-create-available")).toBeVisible());
  });

  it("does not throw when the client has no catalogue reads", async () => {
    const stub = {} as GithubClient;
    expect(() => render(<AvailabilityProbe client={stub} pluginEnabled={true} />)).not.toThrow();
    expect(await screen.findByText("issues-create-hidden")).toBeVisible();
  });

  it("does not throw when authenticationSnapshot returns nothing", async () => {
    const stub = { authenticationSnapshot: vi.fn() } as unknown as GithubClient;
    expect(() => render(<AvailabilityProbe client={stub} pluginEnabled={true} />)).not.toThrow();
    expect(await screen.findByText("issues-create-hidden")).toBeVisible();
  });

  it("ignores a late issues response after the repository changes", async () => {
    const user = userEvent.setup();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const issuePage = (
      number: number,
      title: string,
      name: string,
    ): GithubCatalogueReadResponse => ({
      kind: "issues",
      page: {
        rows: [
          {
            number,
            title,
            state: "open",
            author: "octocat",
            updatedAt: "2026-08-11T10:00:00Z",
            url: `https://github.com/octant/${name}/issues/${String(number)}`,
          },
        ],
        sort: "updated-desc",
        hasNextPage: false,
        freshness: { status: "fresh" },
      },
    });
    const client = makeClient(readySnapshot, {
      readCatalogue: async (request) => {
        if (request.kind === "recent-repositories") {
          return { kind: "recent-repositories", rows: [] };
        }
        if (request.kind === "repositories") {
          return {
            kind: "repositories",
            page: {
              rows: [
                {
                  nodeId: "R_node1",
                  owner: "octant",
                  name: "octant",
                  visibility: "private",
                  defaultBranch: "development",
                  viewerPermission: "admin",
                  capabilities: [{ kind: "issues-read", available: true }],
                },
                {
                  nodeId: "R_node2",
                  owner: "octant",
                  name: "atlas",
                  visibility: "private",
                  defaultBranch: "development",
                  viewerPermission: "admin",
                  capabilities: [{ kind: "issues-read", available: true }],
                },
              ],
              sort: "pushed-desc",
              hasNextPage: false,
              freshness: { status: "fresh" },
            },
          };
        }
        if (request.kind === "issues") {
          if (request.name === "octant") {
            await firstGate;
            return issuePage(7, "Old repo issue", "octant");
          }
          return issuePage(9, "New repo issue", "atlas");
        }
        return { kind: "unavailable", capability: "issues-read", reason: "unavailable" };
      },
    });
    render(<CreateFromIssuePicker client={client} onSelect={vi.fn()} />);
    await user.click(await screen.findByText("octant/octant"));
    await user.click(await screen.findByText("octant/atlas"));
    releaseFirst?.();
    expect(await screen.findByRole("button", { name: /#9 New repo issue/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /#7 Old repo issue/ })).toBeNull();
  });

  it("does not throw when catalogue reads are missing from the picker", () => {
    const stub = {
      authenticationSnapshot: async () => readySnapshot,
    } as unknown as GithubClient;
    expect(() => render(<CreateFromIssuePicker client={stub} onSelect={vi.fn()} />)).not.toThrow();
    expect(screen.getByText("Choose a repository to list its issues.")).toBeVisible();
  });
});

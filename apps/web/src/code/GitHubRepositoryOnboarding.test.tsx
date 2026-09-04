import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  GithubCatalogueReadResponse,
  GithubCloneCommand,
  GithubCloneCommandResponse,
  GithubCloneOperation,
  GithubCloneOperationList,
} from "@octant/contracts";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import { GitHubRepositoryOnboardingFlow } from "./GitHubRepositoryOnboarding";

const DIGEST = "a".repeat(64);
const RECEIPT_ID = "R".repeat(43);

const repositoriesPage: GithubCatalogueReadResponse = {
  kind: "repositories",
  page: {
    rows: [
      {
        nodeId: "R_node1",
        owner: "octant",
        name: "repo-1",
        visibility: "private",
        defaultBranch: "development",
        viewerPermission: "admin",
        capabilities: [],
      },
    ],
    sort: "pushed-desc",
    hasNextPage: false,
    freshness: { status: "fresh" },
  },
} as GithubCatalogueReadResponse;

function makeGithubClient(): GithubClient {
  return {
    authenticationSnapshot: async () => {
      throw new Error("not used");
    },
    executeAuthenticationCommand: async () => {
      throw new Error("not used");
    },
    readCatalogue: async (request) =>
      request.kind === "recent-repositories"
        ? ({ kind: "recent-repositories", rows: [] } as never)
        : repositoriesPage,
    recordRecentRepository: async () => ({ kind: "recent-repositories", rows: [] }) as never,
  };
}

function operation(overrides: Partial<GithubCloneOperation> = {}): GithubCloneOperation {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    state: "awaiting-confirmation",
    mode: "clone",
    repository: {
      nodeId: "R_node1",
      owner: "octant",
      name: "repo-1",
      visibility: "private",
      defaultBranch: "development",
    },
    destination: {
      inventoryPath: "/home/user/Octant/Repositories",
      destinationPath: "/home/user/Octant/Repositories/github.com/octant/repo-1",
      digest: DIGEST,
    },
    version: 1,
    requestedAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    ...overrides,
  } as GithubCloneOperation;
}

interface CloneClientOverrides {
  readonly execute?: (command: GithubCloneCommand) => Promise<GithubCloneCommandResponse>;
  readonly listOperations?: () => Promise<GithubCloneOperationList>;
}

function makeCloneClient(overrides: CloneClientOverrides = {}): GithubCloneClient {
  return {
    execute:
      overrides.execute ??
      (async (command) => {
        if (command.kind === "request-clone") {
          return { kind: "operation", operation: operation({ requestId: command.requestId }) };
        }
        if (command.kind === "cancel-clone") {
          return {
            kind: "operation",
            operation: operation({ requestId: command.requestId, state: "cancelled" }),
          };
        }
        return {
          kind: "operation",
          operation: operation({
            requestId: command.requestId,
            state: "completed",
            bindingIssued: true,
          }),
          binding: { receiptId: RECEIPT_ID, projectType: "code", expiresAt: 9_999_999_999 },
        };
      }),
    listOperations: overrides.listOperations ?? (async () => ({ operations: [] })),
  };
}

function renderOnboarding(
  overrides: Partial<Parameters<typeof GitHubRepositoryOnboardingFlow>[0]> = {},
) {
  const createProject = vi.fn(async () => "project-1");
  const onProjectCreated = vi.fn();
  const onDone = vi.fn();
  const props = {
    client: makeGithubClient(),
    cloneClient: makeCloneClient(),
    hostName: "This Mac",
    createProject,
    onProjectCreated,
    onDone,
    pollIntervalMs: 20,
    ...overrides,
  };
  const view = render(<GitHubRepositoryOnboardingFlow {...props} />);
  return { createProject, onProjectCreated, onDone, props, ...view };
}

async function selectFirstRepository() {
  fireEvent.click(await screen.findByText("octant/repo-1"));
}

describe("GitHubRepositoryOnboardingFlow", () => {
  it("requests the clone on selection and names host, repository, visibility, destination, branch, and approvals", async () => {
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      expect(command).toMatchObject({
        kind: "request-clone",
        nodeId: "R_node1",
        expectedOwner: "octant",
        expectedName: "repo-1",
      });
      return {
        kind: "operation",
        operation: operation({ requestId: (command as { requestId: string }).requestId }),
      } as GithubCloneCommandResponse;
    });
    renderOnboarding({ cloneClient: makeCloneClient({ execute }) });

    await selectFirstRepository();

    expect(await screen.findByText("Confirm managed clone")).toBeInTheDocument();
    expect(screen.getByText("This Mac")).toBeInTheDocument();
    expect(screen.getAllByText("octant/repo-1").length).toBeGreaterThan(0);
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(
      screen.getByText("/home/user/Octant/Repositories/github.com/octant/repo-1"),
    ).toBeInTheDocument();
    expect(screen.getByText("development")).toBeInTheDocument();
    expect(
      screen.getByText(/network, credential, and managed-repository-create/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Octant will create a managed folder/)).toBeInTheDocument();
  });

  it("confirms with the exact confirmation and digest, shows polled progress, and creates the bound Project", async () => {
    let resolveConfirm!: (value: GithubCloneCommandResponse) => void;
    let liveRequestId = "";
    const commands: GithubCloneCommand[] = [];
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      commands.push(command);
      if (command.kind === "request-clone") {
        liveRequestId = command.requestId;
        return {
          kind: "operation",
          operation: operation({ requestId: command.requestId }),
        } as GithubCloneCommandResponse;
      }
      return new Promise<GithubCloneCommandResponse>((resolve) => {
        resolveConfirm = resolve;
      });
    });
    const listOperations = vi.fn(async () => ({
      operations: [
        {
          operation: operation({ requestId: liveRequestId, state: "cloning", version: 3 }),
          progress: { phase: "cloning", message: "Receiving objects" },
        },
      ],
    })) as never;
    const { createProject, onProjectCreated } = renderOnboarding({
      cloneClient: makeCloneClient({ execute, listOperations }),
    });

    await selectFirstRepository();
    fireEvent.click(await screen.findByRole("button", { name: "Clone repository" }));

    expect(await screen.findByText(/Receiving objects/)).toBeInTheDocument();
    const confirm = commands.find((command) => command.kind === "confirm-clone");
    expect(confirm).toMatchObject({
      kind: "confirm-clone",
      nodeId: "R_node1",
      confirmation: "confirm-github-managed-clone",
      destinationDigest: DIGEST,
    });

    resolveConfirm({
      kind: "operation",
      operation: operation({ state: "completed", bindingIssued: true }),
      binding: { receiptId: RECEIPT_ID, projectType: "code", expiresAt: 9_999_999_999 },
    } as GithubCloneCommandResponse);

    await waitFor(() => expect(createProject).toHaveBeenCalledWith("repo-1", RECEIPT_ID));
    await waitFor(() => expect(onProjectCreated).toHaveBeenCalledWith("project-1", "repo-1"));
    expect(await screen.findByText(/Code Project is ready/)).toBeInTheDocument();
  });

  it("cancels an in-flight clone and preserves the repository selection", async () => {
    let resolveConfirm!: (value: GithubCloneCommandResponse) => void;
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      if (command.kind === "request-clone") {
        return {
          kind: "operation",
          operation: operation({ requestId: command.requestId }),
        } as GithubCloneCommandResponse;
      }
      if (command.kind === "cancel-clone") {
        const cancelled = {
          kind: "operation",
          operation: operation({ requestId: command.requestId, state: "cancelled" }),
        } as GithubCloneCommandResponse;
        resolveConfirm(cancelled);
        return cancelled;
      }
      return new Promise<GithubCloneCommandResponse>((resolve) => {
        resolveConfirm = resolve;
      });
    });
    renderOnboarding({ cloneClient: makeCloneClient({ execute }) });

    await selectFirstRepository();
    fireEvent.click(await screen.findByRole("button", { name: "Clone repository" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel clone" }));

    expect(await screen.findByText(/clone was cancelled/i)).toBeInTheDocument();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "cancel-clone" }));
    // Selection survives cancellation for a later retry: Try again asks for
    // the same repository without a second pick.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        execute.mock.calls.filter(([command]) => command.kind === "request-clone"),
      ).toHaveLength(2),
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "request-clone", nodeId: "R_node1" }),
    );
  });

  it("shows a collision refusal honestly and returns to the picker on request", async () => {
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      if (command.kind === "request-clone") {
        return {
          kind: "refused",
          reason: "collision",
          remediation: "The destination already contains a different checkout.",
        } as GithubCloneCommandResponse;
      }
      throw new Error("unexpected");
    });
    renderOnboarding({ cloneClient: makeCloneClient({ execute }) });

    await selectFirstRepository();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The destination already contains a different checkout.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose another repository" }));
    expect(await screen.findByLabelText("Search GitHub repositories")).toBeInTheDocument();
  });

  it("labels a verified existing checkout as attach and sends the attach-existing confirmation", async () => {
    const commands: GithubCloneCommand[] = [];
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      commands.push(command);
      if (command.kind === "request-clone") {
        return {
          kind: "operation",
          operation: operation({ requestId: command.requestId, mode: "attach-existing" }),
        } as GithubCloneCommandResponse;
      }
      return {
        kind: "operation",
        operation: operation({
          requestId: (command as { requestId: string }).requestId,
          mode: "attach-existing",
          state: "completed",
          bindingIssued: true,
        }),
        binding: { receiptId: RECEIPT_ID, projectType: "code", expiresAt: 9_999_999_999 },
      } as GithubCloneCommandResponse;
    });
    const { createProject } = renderOnboarding({ cloneClient: makeCloneClient({ execute }) });

    await selectFirstRepository();
    expect(
      await screen.findByText(/verified checkout of this repository already exists/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Attach existing checkout" }));

    await waitFor(() =>
      expect(commands.find((command) => command.kind === "attach-existing")).toMatchObject({
        kind: "attach-existing",
        confirmation: "confirm-github-attach-existing",
        destinationDigest: DIGEST,
      }),
    );
    await waitFor(() => expect(createProject).toHaveBeenCalledWith("repo-1", RECEIPT_ID));
  });

  it("shows a terminal clone failure with remediation and retries through a fresh request", async () => {
    let requests = 0;
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      if (command.kind === "request-clone") {
        requests += 1;
        return {
          kind: "operation",
          operation: operation({ requestId: command.requestId }),
        } as GithubCloneCommandResponse;
      }
      return {
        kind: "operation",
        operation: operation({
          requestId: (command as { requestId: string }).requestId,
          state: "failed",
          failure: { code: "clone-failed", remediation: "The network connection was interrupted." },
        }),
      } as GithubCloneCommandResponse;
    });
    renderOnboarding({ cloneClient: makeCloneClient({ execute }) });

    await selectFirstRepository();
    fireEvent.click(await screen.findByRole("button", { name: "Clone repository" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The network connection was interrupted.",
    );
    expect(screen.getByText(/clone-failed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Confirm managed clone")).toBeInTheDocument();
    expect(requests).toBe(2);
  });

  it("keeps the verified checkout recoverable when Project creation fails and retries with the same receipt", async () => {
    const createProject = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("project-2");
    const onProjectCreated = vi.fn();
    renderOnboarding({ createProject, onProjectCreated });

    await selectFirstRepository();
    fireEvent.click(await screen.findByRole("button", { name: "Clone repository" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /verified checkout remains on the host/i,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry Project creation" }));

    await waitFor(() => expect(onProjectCreated).toHaveBeenCalledWith("project-2", "repo-1"));
    expect(createProject).toHaveBeenNthCalledWith(2, "repo-1", RECEIPT_ID);
  });

  // Zoom / contrast / motion coverage is documented through the owned
  // stylesheet because jsdom does not apply media queries: narrow layouts
  // collapse the fact grids to one column, 200% zoom reflows through
  // minmax(0, 1fr) tracks and overflow-wrap, high contrast strengthens the
  // option ring, and no GitHub surface declares animation so reduced motion
  // holds by construction.
  it("keeps the GitHub surfaces readable in narrow layouts, at 200% zoom, and under contrast and motion settings", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/code.css"), "utf8");
    const githubStyles = styles.slice(styles.indexOf(".github-picker"));

    expect(githubStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.github-picker__facts\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(githubStyles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.github-onboarding__facts\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(githubStyles).toContain("overflow-wrap: anywhere");
    expect(githubStyles).toMatch(
      /@media \(prefers-contrast: more\)[\s\S]*?\.github-picker__option/,
    );
    expect(githubStyles).not.toContain("animation");
  });

  it("completes the full pick, confirm, clone, and bind walkthrough with zero console errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { onDone, onProjectCreated } = renderOnboarding();
      await selectFirstRepository();
      fireEvent.click(await screen.findByRole("button", { name: "Clone repository" }));
      await waitFor(() => expect(onProjectCreated).toHaveBeenCalledWith("project-1", "repo-1"));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      expect(onDone).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

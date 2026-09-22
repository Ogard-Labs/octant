import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  GithubCatalogueReadResponse,
  GithubCloneCommand,
  GithubCloneCommandResponse,
  GithubCloneOperation,
} from "@octant/contracts";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCloneClient } from "@octant/client-runtime/github-clone-client";
import type { OctantHostBridge } from "../shell/hostBridge";
import {
  bindingReceipt,
  credentialHostOperations,
  deferred,
  projectId,
  projectWindowCapability,
} from "../App.test-fixtures";
import { ProjectCreateDialog } from "./ProjectCreateDialog";

function hostBridge(selectProjectRoot: OctantHostBridge["selectProjectRoot"]): OctantHostBridge {
  return {
    ...credentialHostOperations(),
    close: vi.fn(),
    maximizeOrRestore: vi.fn(),
    minimize: vi.fn(),
    projectWindowCapability,
    resetBounds: vi.fn(),
    selectProjectRoot,
    setSidebarMaterialPreference: vi.fn(),
    subscribeResolvedMaterial: vi.fn(() => () => undefined),
  };
}

function selectsDocuments() {
  return vi.fn(async () => ({
    kind: "selected" as const,
    receiptId: bindingReceipt,
    displayName: "Documents",
  }));
}

describe("ProjectCreateDialog renderer flows", () => {
  it("creates Chat directly without invoking the native picker", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(vi.fn());
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="chat"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Create Project" });
    const heading = screen.getByRole("heading", { name: "Create Project" });
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(heading).toBeVisible();
    await user.type(screen.getByLabelText("Project name"), "Research");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(bridge.selectProjectRoot).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith("chat", "Research", undefined);
    expect(onCreated).toHaveBeenCalledWith(projectId, "chat", "Research");
  });

  it("waits for the person to ask before opening the folder chooser", () => {
    const bridge = hostBridge(selectsDocuments());
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="work"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(bridge.selectProjectRoot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose a folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create Project" })).toBeDisabled();
  });

  it("creates Work with only the native opaque receipt", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(selectsDocuments());
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="work"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalledWith("work"));
    expect(screen.getByLabelText("Project name")).toHaveValue("Documents");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("work", "Documents", bindingReceipt));
    expect(JSON.stringify(onCreate.mock.calls)).not.toContain("canonicalRoot");
  });

  it("keeps a name the person typed when they pick a folder afterwards", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(selectsDocuments());
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Project name"), "Ledger");
    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await screen.findByRole("button", { name: /Documents/ });
    expect(screen.getByLabelText("Project name")).toHaveValue("Ledger");

    await user.click(screen.getByRole("button", { name: "Create Project" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("code", "Ledger", bindingReceipt, true),
    );
  });

  it("redacts native picker rejection details", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(
      vi.fn(async () => {
        throw new Error("/private/secret/path desktop-token");
      }),
    );
    const onCreate = vi.fn();
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await waitFor(() =>
      expect(screen.getByText("Project creation could not be completed.")).toBeVisible(),
    );
    expect(document.body).not.toHaveTextContent("/private/secret/path");
    expect(document.body).not.toHaveTextContent("desktop-token");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not submit or open after unmount while the native picker is pending", async () => {
    const user = userEvent.setup();
    const selection = deferred<{
      readonly kind: "selected";
      readonly receiptId: string;
      readonly displayName: string;
    }>();
    const bridge = hostBridge(vi.fn(() => selection.promise));
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    const view = render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalled());
    view.unmount();

    await act(async () =>
      selection.resolve({ kind: "selected", receiptId: bindingReceipt, displayName: "Documents" }),
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("creates a Code Project with Git initialization enabled by default", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(selectsDocuments());
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalledWith("code"));
    expect(screen.getByRole("checkbox", { name: /Initialize as a Git repository/i })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("code", "Documents", bindingReceipt, true),
    );
  });

  it("lets the person decline Git initialization for a Code Project", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(selectsDocuments());
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await screen.findByRole("checkbox", { name: /Initialize as a Git repository/i });
    await user.click(screen.getByRole("checkbox", { name: /Initialize as a Git repository/i }));
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("code", "Documents", bindingReceipt, false),
    );
  });

  it("keeps Cancel usable while creation is in flight and ignores the late result", async () => {
    const user = userEvent.setup();
    const command = deferred<typeof projectId>();
    const bridge = hostBridge(selectsDocuments());
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const view = render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={onClose}
        onCreate={vi.fn(() => command.promise)}
        onCreated={onCreated}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await screen.findByRole("button", { name: /Documents/ });
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close new Project" })).toBeEnabled();
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => command.resolve(projectId));
    expect(onCreated).not.toHaveBeenCalled();
  });
});

const CLONE_RECEIPT = `${"R".repeat(42)}A`;
const CLONE_DIGEST = "b".repeat(64);

function githubRepositoryRow() {
  return {
    nodeId: "R_dialog_node1",
    owner: "octant",
    name: "repo-1",
    visibility: "private" as const,
    defaultBranch: "development",
    viewerPermission: "admin" as const,
    capabilities: [],
  };
}

function catalogueClient(): GithubClient {
  return {
    authenticationSnapshot: async () => {
      throw new Error("not used");
    },
    executeAuthenticationCommand: async () => {
      throw new Error("not used");
    },
    readCatalogue: async (request) =>
      request.kind === "recent-repositories"
        ? ({ kind: "recent-repositories", rows: [] } as GithubCatalogueReadResponse)
        : ({
            kind: "repositories",
            page: {
              rows: [githubRepositoryRow()],
              sort: "pushed-desc",
              hasNextPage: false,
              freshness: { status: "fresh" },
            },
          } as GithubCatalogueReadResponse),
    recordRecentRepository: async () =>
      ({ kind: "recent-repositories", rows: [] }) as GithubCatalogueReadResponse,
  };
}

function cloneOperation(requestId: string): GithubCloneOperation {
  return {
    requestId,
    state: "awaiting-confirmation",
    mode: "clone",
    repository: {
      nodeId: "R_dialog_node1",
      owner: "octant",
      name: "repo-1",
      visibility: "private",
      defaultBranch: "development",
    },
    destination: {
      inventoryPath: "/home/user/code",
      destinationPath: "/home/user/code/repo-1",
      digest: CLONE_DIGEST,
    },
    version: 1,
    requestedAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
  } as GithubCloneOperation;
}

function cloneClient(): GithubCloneClient {
  return {
    execute: async (command: GithubCloneCommand) => {
      if (command.kind === "request-clone") {
        return {
          kind: "operation",
          operation: cloneOperation(command.requestId),
        } as GithubCloneCommandResponse;
      }
      return {
        kind: "operation",
        operation: {
          ...cloneOperation(command.requestId),
          state: "completed",
          bindingIssued: true,
        },
        binding: { receiptId: CLONE_RECEIPT, projectType: "code", expiresAt: 9_999_999_999 },
      } as GithubCloneCommandResponse;
    },
    listOperations: async () => ({ operations: [] }),
  };
}

describe("ProjectCreateDialog GitHub source", () => {
  it("keeps the folder form as the default tab when the GitHub source is available", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(selectsDocuments());
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        github={{ client: catalogueClient(), cloneClient: cloneClient(), hostName: "This Mac" }}
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByRole("group", { name: "Project source" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    await screen.findByRole("button", { name: /Documents/ });
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("code", "Documents", bindingReceipt, true),
    );
  });

  it("clones the chosen GitHub repository into a natively chosen parent folder", async () => {
    const user = userEvent.setup();
    const commands: GithubCloneCommand[] = [];
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      commands.push(command);
      if (command.kind === "request-clone") {
        return {
          kind: "operation",
          operation: cloneOperation(command.requestId),
        } as GithubCloneCommandResponse;
      }
      return {
        kind: "operation",
        operation: {
          ...cloneOperation(command.requestId),
          state: "completed",
          bindingIssued: true,
        },
        binding: { receiptId: CLONE_RECEIPT, projectType: "code", expiresAt: 9_999_999_999 },
      } as GithubCloneCommandResponse;
    });
    const selectProjectRoot = vi.fn(async () => ({
      kind: "selected" as const,
      receiptId: bindingReceipt,
      displayName: "Code",
    }));
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <ProjectCreateDialog
        github={{
          client: catalogueClient(),
          cloneClient: {
            execute,
            listOperations: async () => ({ operations: [] }),
          },
          hostName: "This Mac",
        }}
        hostBridge={hostBridge(selectProjectRoot)}
        mode="code"
        onClose={onClose}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    fireEvent.click(await screen.findByText("octant/repo-1"));

    expect(await screen.findByText("Where should it be cloned?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText("Code")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Confirm managed clone")).toBeInTheDocument();
    const request = commands.find((command) => command.kind === "request-clone");
    expect(request).toMatchObject({
      destination: { parentReceiptId: bindingReceipt, folderName: "repo-1" },
    });
    await user.click(screen.getByRole("button", { name: "Clone repository" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("code", "repo-1", CLONE_RECEIPT));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(projectId, "code", "repo-1"));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ProjectCreateDialog GitHub source on a headless host", () => {
  function folderBrowseClient(): FolderBrowseClient {
    return {
      browse: vi.fn(async () => ({
        candidates: [
          {
            candidateId: "80000000-0000-4000-8000-000000000305" as never,
            displayName: "knowledge",
            isGitRepository: false,
            isSelectable: true,
          },
        ],
        breadcrumbs: [{ label: "Home" }],
        hasMore: false,
        browsedAt: "2026-07-26T22:00:00.000Z" as never,
      })),
      select: vi.fn(async () => ({
        receiptId: bindingReceipt,
        displayName: "knowledge",
        selectedAt: "2026-07-26T22:00:01.000Z" as never,
      })),
    };
  }

  it("resolves the clone destination through the host folder browser", async () => {
    const user = userEvent.setup();
    const commands: GithubCloneCommand[] = [];
    const execute = vi.fn(async (command: GithubCloneCommand) => {
      commands.push(command);
      if (command.kind === "request-clone") {
        return {
          kind: "operation",
          operation: cloneOperation(command.requestId),
        } as GithubCloneCommandResponse;
      }
      return {
        kind: "operation",
        operation: {
          ...cloneOperation(command.requestId),
          state: "completed",
          bindingIssued: true,
        },
        binding: { receiptId: CLONE_RECEIPT, projectType: "code", expiresAt: 9_999_999_999 },
      } as GithubCloneCommandResponse;
    });
    render(
      <ProjectCreateDialog
        folderBrowseClient={folderBrowseClient()}
        github={{
          client: catalogueClient(),
          cloneClient: { execute, listOperations: async () => ({ operations: [] }) },
          hostName: "Devbox",
        }}
        hostId="local"
        mode="code"
        onClose={vi.fn()}
        onCreate={vi.fn(async () => projectId)}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    fireEvent.click(await screen.findByText("octant/repo-1"));

    await user.click(await screen.findByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText("Choose clone destination")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    // The chosen parent shows in the destination step once the folder browser
    // has closed; its row text is gone by then.
    expect(await screen.findByText("Change")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Confirm managed clone")).toBeInTheDocument();
    const request = commands.find((command) => command.kind === "request-clone");
    expect(request).toMatchObject({
      destination: { parentReceiptId: bindingReceipt, folderName: "repo-1" },
    });
  });

  it("still creates a folder-bound Project from the Folder tab", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        folderBrowseClient={folderBrowseClient()}
        github={{ client: catalogueClient(), cloneClient: cloneClient(), hostName: "Devbox" }}
        hostId="local"
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByRole("group", { name: "Project source" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Choose a folder" }));
    expect(await screen.findByText("Add Code folder")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("code", "knowledge", bindingReceipt, true),
    );
  });
});

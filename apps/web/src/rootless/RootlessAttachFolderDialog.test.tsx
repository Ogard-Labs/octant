import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RootlessAttachFolderDialog } from "./RootlessAttachFolderDialog";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { RootlessThreadSummary } from "@octant/contracts/rootless-thread";
import type { CompatibleProjectEntry } from "@octant/contracts/rootless-thread";

const thread: RootlessThreadSummary = {
  threadId: "00000000-0000-4000-8000-000000000001" as never,
  title: "Rootless brief",
  mode: "work",
  hostId: "local" as never,
  providerInstanceId: "00000000-0000-4000-8000-000000000010" as never,
  modelId: "model-a" as never,
  workspaceKind: "rootless",
  createdAt: "2026-07-29T12:00:00.000Z" as never,
  updatedAt: "2026-07-29T12:00:00.000Z" as never,
};

const hostBThread: RootlessThreadSummary = {
  ...thread,
  hostId: "host-b" as never,
};

const compatibleProject: CompatibleProjectEntry = {
  projectId: "00000000-0000-4000-8000-000000000020" as never,
  displayName: "Attached Docs" as never,
  rootPath: "/docs" as never,
};

function hostBridge(selected: { receiptId: string; displayName: string }): OctantHostBridge {
  return {
    projectWindowCapability: "capability",
    providerCredentialStatus: vi.fn(),
    setProviderCredential: vi.fn(),
    clearProviderCredential: vi.fn(),
    selectProjectRoot: vi.fn(async () => selected),
  } as unknown as OctantHostBridge;
}

function client(
  attachResult: { kind: "attached" | "denied"; reason?: string } = { kind: "attached" },
) {
  return {
    lookupCompatibleProjects: vi.fn(async () => [compatibleProject]),
    attachFolder: vi.fn(async () =>
      attachResult.kind === "attached"
        ? {
            kind: "attached" as const,
            attachmentId: "00000000-0000-4000-8000-000000000030",
            threadId: thread.threadId,
            projectId: compatibleProject.projectId,
            attachedAt: "2026-07-29T12:00:00.000Z",
          }
        : {
            kind: "denied" as const,
            attachmentId: "00000000-0000-4000-8000-000000000030",
            threadId: thread.threadId,
            reason: "stale-binding",
            message: "The selected folder does not match the saved Project binding.",
          },
    ),
  };
}

describe("RootlessAttachFolderDialog", () => {
  it("lists compatible saved Projects and attaches through the Electron host bridge", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge({ receiptId: "receipt-1", displayName: "Attached Docs" });
    const onAttached = vi.fn();
    const onClose = vi.fn();
    const c = client();

    render(
      <RootlessAttachFolderDialog
        client={c as never}
        hostBridge={bridge}
        thread={thread}
        onAttached={onAttached}
        onClose={onClose}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "Attach folder" })).toBeVisible();
    expect(await screen.findByText(/Attached Docs/)).toBeVisible();
    expect(c.lookupCompatibleProjects).toHaveBeenCalledWith({
      threadId: thread.threadId,
      mode: thread.mode,
      hostId: thread.hostId,
    });

    await user.click(screen.getByRole("button", { name: "Attach to Attached Docs" }));
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalledWith(thread.mode));

    await waitFor(() =>
      expect(c.attachFolder).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: thread.threadId,
          projectId: compatibleProject.projectId,
          receiptId: "receipt-1",
        }),
      ),
    );
    expect(onAttached).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows an actionable denial message and keeps the dialog open", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge({ receiptId: "receipt-1", displayName: "Attached Docs" });
    const onAttached = vi.fn();
    const c = client({ kind: "denied" });

    render(
      <RootlessAttachFolderDialog
        client={c as never}
        hostBridge={bridge}
        thread={thread}
        onAttached={onAttached}
        onClose={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Attach to Attached Docs" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not match/);
    expect(onAttached).not.toHaveBeenCalled();
  });

  it("uses the web folder picker when no Electron bridge is available", async () => {
    const user = userEvent.setup();
    const folderBrowseClient: FolderBrowseClient = {
      browse: vi.fn().mockResolvedValue({
        candidates: [
          {
            candidateId: "80000000-0000-4000-8000-000000000100" as never,
            displayName: "docs",
            isGitRepository: false,
            isSelectable: true,
          },
        ],
        breadcrumbs: [{ label: "/" }],
        hasMore: false,
        browsedAt: "2026-07-29T12:00:00.000Z" as never,
      }),
      select: vi.fn().mockResolvedValue({
        receiptId: "receipt-web",
        displayName: "docs",
        selectedAt: "2026-07-29T12:00:00.000Z" as never,
      }),
    };
    const onAttached = vi.fn();
    const c = client();

    render(
      <RootlessAttachFolderDialog
        client={c as never}
        folderBrowseClient={folderBrowseClient}
        thread={thread}
        onAttached={onAttached}
        onClose={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Attach to Attached Docs" }));
    expect(await screen.findByRole("dialog", { name: "Add folder" })).toBeVisible();

    await user.click(await screen.findByRole("button", { name: "Select" }));
    await waitFor(() =>
      expect(c.attachFolder).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: thread.threadId,
          projectId: compatibleProject.projectId,
          receiptId: "receipt-web",
        }),
      ),
    );
    expect(onAttached).toHaveBeenCalled();
  });

  it("offers Add local folder when no compatible Project exists", async () => {
    const c = client();
    c.lookupCompatibleProjects = vi.fn(async () => []);
    const onAddFolder = vi.fn();

    render(
      <RootlessAttachFolderDialog
        client={c as never}
        thread={thread}
        onAddFolder={onAddFolder}
        onAttached={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText(/No saved Projects match this thread/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add a local folder first" }));
    expect(onAddFolder).toHaveBeenCalled();
  });

  it("fails closed for a non-local thread with an actionable unavailable message", async () => {
    const c = client();
    const folderBrowseClient: FolderBrowseClient = {
      browse: vi.fn(),
      select: vi.fn(),
    };
    const bridge = hostBridge({ receiptId: "receipt-1", displayName: "Attached Docs" });

    render(
      <RootlessAttachFolderDialog
        client={c as never}
        folderBrowseClient={folderBrowseClient}
        hostBridge={bridge}
        thread={hostBThread}
        onAttached={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/Attach a folder from the host where this thread was created/),
    ).toBeVisible();
    expect(c.lookupCompatibleProjects).not.toHaveBeenCalled();
    expect(folderBrowseClient.browse).not.toHaveBeenCalled();
    expect(bridge.selectProjectRoot).not.toHaveBeenCalled();
    expect(c.attachFolder).not.toHaveBeenCalled();
  });

  it("uses the web folder picker for a local thread when no Electron bridge is available", async () => {
    const user = userEvent.setup();
    const folderBrowseClient: FolderBrowseClient = {
      browse: vi.fn().mockResolvedValue({
        candidates: [
          {
            candidateId: "80000000-0000-4000-8000-000000000100" as never,
            displayName: "docs",
            isGitRepository: false,
            isSelectable: true,
          },
        ],
        breadcrumbs: [{ label: "/" }],
        hasMore: false,
        browsedAt: "2026-07-29T12:00:00.000Z" as never,
      }),
      select: vi.fn().mockResolvedValue({
        receiptId: "receipt-web",
        displayName: "docs",
        selectedAt: "2026-07-29T12:00:00.000Z" as never,
      }),
    };
    const onAttached = vi.fn();
    const c = client();

    render(
      <RootlessAttachFolderDialog
        client={c as never}
        folderBrowseClient={folderBrowseClient}
        thread={thread}
        onAttached={onAttached}
        onClose={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Attach to Attached Docs" }));
    expect(await screen.findByRole("dialog", { name: "Add folder" })).toBeVisible();

    await waitFor(() =>
      expect(folderBrowseClient.browse).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "local" }),
      ),
    );

    await user.click(await screen.findByRole("button", { name: "Select" }));
    await waitFor(() =>
      expect(c.attachFolder).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: thread.threadId,
          projectId: compatibleProject.projectId,
          receiptId: "receipt-web",
        }),
      ),
    );
    expect(onAttached).toHaveBeenCalled();
  });
});

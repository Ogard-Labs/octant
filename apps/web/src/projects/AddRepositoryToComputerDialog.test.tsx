import type { ProjectClient } from "@octant/client-runtime/project-client";
import {
  RepositoryBootstrapClientFailure,
  type RepositoryBootstrapClient,
} from "@octant/client-runtime/repository-bootstrap-client";
import { decodeHostId } from "@octant/contracts/host";
import type { UtcTimestamp } from "@octant/contracts/events";
import {
  decodeBindingReceiptId,
  decodeProjectId,
  type ProjectSummary,
} from "@octant/contracts/projects";
import {
  decodeRepositoryBootstrapOperationId,
  type RepositoryBootstrapInspectResult,
} from "@octant/contracts/repository-bootstrap";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BootstrapDestinationTarget } from "../host/useBootstrapDestinations";
import { AddRepositoryToComputerDialog } from "./AddRepositoryToComputerDialog";

const PROJECT_ID = decodeProjectId("11111111-1111-4111-8111-111111111111");
const REMOTE_HOST_ID = decodeHostId("host-linux-devbox");
const RECEIPT_ID_1 = decodeBindingReceiptId("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const RECEIPT_ID_2 = decodeBindingReceiptId("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA");

function localCodeProject(): Extract<ProjectSummary, { readonly type: "code" }> {
  return {
    type: "code",
    id: PROJECT_ID,
    name: "octant",
    lifecycle: "active",
    pinned: false,
    rank: "a0",
    createdAt: "2026-11-24T20:00:00.000Z",
    binding: { canonicalRoot: "/Users/henrik/Repos/octant" },
    bindingRevisionId: "22222222-2222-4222-8222-222222222222" as never,
    memoryCount: 0,
  } as unknown as Extract<ProjectSummary, { readonly type: "code" }>;
}

function inspectFixture(
  overrides: Partial<RepositoryBootstrapInspectResult> = {},
): RepositoryBootstrapInspectResult {
  return {
    projectId: PROJECT_ID,
    projectName: "octant",
    sourcePath: "/Users/henrik/Repos/octant",
    repositoryName: "octant",
    defaultDestinationPath: "~/octant",
    remotes: {
      originUrl: "git@github.com:Ogard-Labs/octant.git",
      sshUrl: "git@github.com:Ogard-Labs/octant.git",
      httpsUrl: "https://github.com/Ogard-Labs/octant.git",
      defaultTransport: "ssh",
    },
    ignoredFiles: [
      { path: ".env", bytes: 420, secretGuardMatched: true },
      { path: "apps/web/.env.local", bytes: 2048, secretGuardMatched: true },
      { path: "local.settings.json", bytes: 128, secretGuardMatched: false },
    ],
    truncated: false,
    omittedCount: 0,
    omittedOversizedCount: 0,
    caps: { maxFiles: 200, maxFileBytes: 2_097_152, maxTotalBytes: 20_971_520 },
    ...overrides,
  };
}

function makeSourceClient(
  inspectResult: RepositoryBootstrapInspectResult = inspectFixture(),
): RepositoryBootstrapClient {
  return {
    inspect: vi.fn().mockResolvedValue(inspectResult),
    readIgnoredFile: vi
      .fn()
      .mockImplementation(async ({ relativePath }: { relativePath: string }) => ({
        relativePath,
        bytes: 5,
        sha256: "a".repeat(64),
        mode: 0o600,
        contentBase64: btoa("hello"),
      })),
    startClone: vi.fn(),
    cloneStatus: vi.fn(),
    cancelClone: vi.fn(),
    landFiles: vi.fn(),
  };
}

function makeDestination(
  overrides: Partial<BootstrapDestinationTarget> = {},
): BootstrapDestinationTarget & { readonly bootstrapClient: RepositoryBootstrapClient } {
  const bootstrapClient: RepositoryBootstrapClient = overrides.bootstrapClient ?? {
    inspect: vi.fn(),
    readIgnoredFile: vi.fn(),
    startClone: vi.fn().mockImplementation(async (req) => ({
      operation: {
        state: "cloned",
        operationId: req.operationId,
        transport: req.transport,
        destinationPath: req.destinationPath,
        canonicalDestination: "/home/dev/octant",
        receiptId: RECEIPT_ID_1,
        projectName: req.projectName ?? "octant",
        updatedAt: "2026-11-24T20:00:00.000Z",
      },
    })),
    cloneStatus: vi.fn(),
    cancelClone: vi.fn(),
    landFiles: vi.fn().mockImplementation(async (req) => ({
      status: "landed",
      landed: req.files.map((file: { relativePath: string }) => file.relativePath),
      failed: [],
    })),
  };
  const projectClient = {
    bootstrap: vi.fn(),
    executeProject: vi
      .fn()
      .mockImplementation(async (cmd: { projectId: string; name: string }) => ({
        kind: "code-project-created",
        project: { id: cmd.projectId, name: cmd.name },
      })),
  } as unknown as ProjectClient;

  return {
    hostId: REMOTE_HOST_ID,
    displayName: "Linux Devbox",
    connected: true,
    actsAsHostPerson: true,
    projectClient,
    boundRepositoryKeys: new Set(),
    ...overrides,
    bootstrapClient,
  };
}

describe("AddRepositoryToComputerDialog", () => {
  it("renders summary, defaults to 0 ignored files selected, updates counts on toggle/All, and switches SSH/HTTPS preview", async () => {
    const sourceClient = makeSourceClient();
    const destination = makeDestination();

    render(
      <AddRepositoryToComputerDialog
        destinations={[destination]}
        onClose={vi.fn()}
        open
        project={localCodeProject()}
        sourceBootstrapClient={sourceClient}
        sourceHostName="MacBook Pro"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("repo-bootstrap-remote-preview").textContent).toBe(
        "git@github.com:Ogard-Labs/octant.git",
      );
    });

    expect(screen.getByTestId("repo-bootstrap-file-count").textContent).toBe("0 of 3");
    expect(screen.getByTestId("repo-bootstrap-summary").textContent).toContain("no files");
    expect(screen.getAllByText("Secret")).toHaveLength(2);

    // Switch transport from SSH to HTTPS and verify live URL preview updates.
    fireEvent.click(screen.getByRole("button", { name: "HTTPS" }));
    expect(screen.getByTestId("repo-bootstrap-remote-preview").textContent).toBe(
      "https://github.com/Ogard-Labs/octant.git",
    );

    // Tick one file -> 1 of 3 and secret warning appears.
    fireEvent.click(screen.getByRole("checkbox", { name: ".env" }));
    expect(screen.getByTestId("repo-bootstrap-file-count").textContent).toBe("1 of 3");
    expect(screen.getByTestId("repo-bootstrap-summary").textContent).toContain("1 file");
    expect(screen.getByText(/Files marked Secret may contain local credentials/)).toBeTruthy();

    // Click All -> 3 of 3; click None -> 0 of 3.
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("repo-bootstrap-file-count").textContent).toBe("3 of 3");
    expect(screen.getByTestId("repo-bootstrap-summary").textContent).toContain("3 files");

    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByTestId("repo-bootstrap-file-count").textContent).toBe("0 of 3");
  });

  it("submits chosen transport, destination path, and exact ticked files, binds the Project, and completes", async () => {
    const sourceClient = makeSourceClient();
    const destination = makeDestination();
    const onCompleted = vi.fn();
    const onClose = vi.fn();

    render(
      <AddRepositoryToComputerDialog
        destinations={[destination]}
        onClose={onClose}
        onCompleted={onCompleted}
        open
        project={localCodeProject()}
        sourceBootstrapClient={sourceClient}
        sourceHostName="MacBook Pro"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("repo-bootstrap-remote-preview")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "HTTPS" }));
    fireEvent.change(screen.getByLabelText("Folder on Linux Devbox"), {
      target: { value: "~/src/octant" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: ".env" }));

    fireEvent.click(screen.getByRole("button", { name: "Clone to Linux Devbox" }));

    await waitFor(() => {
      expect(onCompleted).toHaveBeenCalledTimes(1);
    });

    expect(destination.bootstrapClient.startClone).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: "https://github.com/Ogard-Labs/octant.git",
        transport: "https",
        destinationPath: "~/src/octant",
      }),
      expect.any(AbortSignal),
    );
    expect(destination.projectClient.executeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-code-project",
        receiptId: RECEIPT_ID_1,
      }),
    );
    expect(sourceClient.readIgnoredFile).toHaveBeenCalledTimes(1);
    expect(sourceClient.readIgnoredFile).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, relativePath: ".env" },
      expect.any(AbortSignal),
    );
    expect(destination.bootstrapClient.landFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ relativePath: ".env" })],
      }),
      expect.any(AbortSignal),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces typed clone errors and partial-copy failures without deleting the cloned Project", async () => {
    const sourceClient = makeSourceClient();
    const destination = makeDestination();
    vi.mocked(destination.bootstrapClient.startClone).mockRejectedValueOnce(
      new RepositoryBootstrapClientFailure({
        code: "host-key-unverified",
        message: "SSH host key verification failed.",
      }),
    );

    const { rerender } = render(
      <AddRepositoryToComputerDialog
        destinations={[destination]}
        onClose={vi.fn()}
        open
        project={localCodeProject()}
        sourceBootstrapClient={sourceClient}
        sourceHostName="MacBook Pro"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Clone to Linux Devbox" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Clone to Linux Devbox" }));
    await waitFor(() => {
      expect(screen.getByText("SSH host key verification failed.")).toBeTruthy();
    });

    // One-click switch to HTTPS from remediation alert.
    fireEvent.click(screen.getByRole("button", { name: "Switch to HTTPS" }));
    expect(screen.getByTestId("repo-bootstrap-remote-preview").textContent).toBe(
      "https://github.com/Ogard-Labs/octant.git",
    );

    // Now simulate clone succeeding + partial file copy failure.
    vi.mocked(destination.bootstrapClient.startClone).mockResolvedValueOnce({
      operation: {
        state: "cloned",
        operationId: decodeRepositoryBootstrapOperationId("99999999-9999-4999-8999-999999999999"),
        transport: "https",
        destinationPath: "~/octant",
        canonicalDestination: "/home/dev/octant",
        receiptId: RECEIPT_ID_2,
        projectName: "octant",
        updatedAt: "2026-11-24T20:00:00.000Z" as UtcTimestamp,
      },
    });
    vi.mocked(destination.bootstrapClient.landFiles).mockResolvedValueOnce({
      status: "partial-copy",
      landed: [],
      failed: [{ relativePath: ".env", reason: "symlink-refused", message: "Refused symlink." }],
    });

    fireEvent.click(screen.getByRole("checkbox", { name: ".env" }));
    fireEvent.click(screen.getByRole("button", { name: "Clone to Linux Devbox" }));

    await waitFor(() => {
      expect(screen.getByText(/Cloned and added octant on Linux Devbox/)).toBeTruthy();
    });
    expect(screen.getByText(/Refused symlink/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open on Linux Devbox" })).toBeTruthy();

    // Parent rerendering with a fresh destinations array identity must preserve the partial-copy summary.
    rerender(
      <AddRepositoryToComputerDialog
        destinations={[makeDestination({ bootstrapClient: destination.bootstrapClient })]}
        onClose={vi.fn()}
        open
        project={localCodeProject()}
        sourceBootstrapClient={sourceClient}
        sourceHostName="MacBook Pro"
      />,
    );
    expect(screen.getByText(/Cloned and added octant on Linux Devbox/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open on Linux Devbox" })).toBeTruthy();
  });

  it("refuses destinations where the window does not act as the computer's person", async () => {
    const sourceClient = makeSourceClient();
    const hubIntroducedOnly = makeDestination({ actsAsHostPerson: false });

    render(
      <AddRepositoryToComputerDialog
        destinations={[hubIntroducedOnly]}
        onClose={vi.fn()}
        open
        project={localCodeProject()}
        sourceBootstrapClient={sourceClient}
        sourceHostName="MacBook Pro"
      />,
    );

    expect(screen.getByText(/No eligible paired computer is connected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clone to/ })).toBeNull();
  });
});

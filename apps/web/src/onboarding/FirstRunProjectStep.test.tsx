import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_IMPORTED_PROVIDER_FOLDERS,
  decodeDiscoveredProviderFolderId,
  decodeProjectId,
  type DiscoveredProviderFolderGroup,
  type ImportProviderFoldersResult,
  type ProviderFolderScanResult,
  type UtcTimestamp,
} from "@octant/contracts";
import { FirstRunProjectStep, type FirstRunProviderFolderScan } from "./FirstRunProjectStep";
import type { FirstRunTaskMode } from "./firstRunHandoffModel";

const FOLDER_A = decodeDiscoveredProviderFolderId("11111111-1111-4111-8111-111111111111");
const FOLDER_B = decodeDiscoveredProviderFolderId("22222222-2222-4222-8222-222222222222");
const FOLDER_C = decodeDiscoveredProviderFolderId("33333333-3333-4333-8333-333333333333");
const PROJECT_A = decodeProjectId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

function folderIdAt(index: number) {
  const hex = index.toString(16).padStart(12, "0");
  return decodeDiscoveredProviderFolderId(`11111111-1111-4111-8111-${hex}`);
}

function Step(props: {
  readonly initial: FirstRunTaskMode;
  readonly providerFolderScan?: FirstRunProviderFolderScan;
}) {
  const [mode, setMode] = useState<FirstRunTaskMode>(props.initial);
  return (
    <FirstRunProjectStep
      mode={mode}
      onChooseFolder={() => {}}
      onSelectMode={setMode}
      onSelectProject={() => {}}
      projects={[]}
      providerFolderScan={props.providerFolderScan}
      selectedProjectId={undefined}
      workEnabled
    />
  );
}

describe("FirstRunProjectStep mode choice", () => {
  it("wraps from the last mode to the first and selects the one it lands on", async () => {
    const user = userEvent.setup();
    render(<Step initial="code" />);
    screen.getByRole("radio", { name: "Code" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Work" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Code" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Code" })).toBeChecked();
  });

  it("jumps to the first and last mode with Home and End", async () => {
    const user = userEvent.setup();
    render(<Step initial="code" />);
    screen.getByRole("radio", { name: "Code" }).focus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Work" })).toBeChecked();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Code" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Code" })).toHaveFocus();
  });
});

describe("FirstRunProjectStep provider folder scan", () => {
  it("lists folders the person's providers used, grouped by remote, with distinct labels for same-name clones", async () => {
    const scan = vi.fn(
      async (): Promise<ProviderFolderScanResult> => ({
        status: "ready",
        requireGitRepository: true,
        groups: [
          {
            repository: "acme/alpha",
            label: "acme/alpha",
            providers: ["claude", "codex"],
            sessionCount: 5,
            lastActivityAt: "2026-11-21T10:00:00.000Z" as UtcTimestamp,
            folders: [
              {
                id: FOLDER_A,
                folderName: "alpha",
                providers: ["claude"],
                sessionCount: 3,
                lastActivityAt: "2026-11-21T10:00:00.000Z" as UtcTimestamp,
                isGitRepository: true,
                alreadyImported: false,
              },
              {
                id: FOLDER_B,
                folderName: "alpha",
                providers: ["codex"],
                sessionCount: 2,
                lastActivityAt: "2026-11-20T10:00:00.000Z" as UtcTimestamp,
                isGitRepository: true,
                alreadyImported: false,
              },
            ],
          },
          {
            label: "local-notes",
            providers: ["opencode", "pi"],
            sessionCount: 4,
            lastActivityAt: "2026-11-19T10:00:00.000Z" as UtcTimestamp,
            folders: [
              {
                id: FOLDER_C,
                folderName: "local-notes",
                providers: ["opencode", "pi"],
                sessionCount: 4,
                lastActivityAt: "2026-11-19T10:00:00.000Z" as UtcTimestamp,
                isGitRepository: false,
                alreadyImported: false,
              },
            ],
          },
        ],
        stoppedEarly: false,
        scannedAt: "2026-11-21T10:05:00.000Z" as UtcTimestamp,
      }),
    );

    render(
      <Step
        initial="code"
        providerFolderScan={{
          strict: false,
          scan,
          importFolders: async () => ({ status: "completed", results: [] }),
        }}
      />,
    );

    expect(await screen.findByText("acme/alpha")).toBeInTheDocument();
    expect(screen.getByText(/2 clones/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "acme/alpha (alpha (1))" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "acme/alpha (alpha (2))" })).toBeEnabled();
    // Plain non-Git folder is disabled with guidance while Code requires Git.
    expect(screen.getByRole("checkbox", { name: "local-notes" })).toBeDisabled();
    expect(screen.getByText(/Not a Git repository/i)).toBeInTheDocument();
    expect(screen.getByText(/OpenCode, Pi/i)).toBeInTheDocument();
  });

  it("imports only the ticked folders as Code Projects and offers rescan in the ready view", async () => {
    const user = userEvent.setup();
    const scan = vi.fn(
      async (): Promise<ProviderFolderScanResult> => ({
        status: "ready",
        requireGitRepository: true,
        groups: [
          {
            repository: "acme/alpha",
            label: "acme/alpha",
            providers: ["claude"],
            sessionCount: 2,
            lastActivityAt: "2026-11-21T10:00:00.000Z" as UtcTimestamp,
            folders: [
              {
                id: FOLDER_A,
                folderName: "alpha",
                providers: ["claude"],
                sessionCount: 2,
                lastActivityAt: "2026-11-21T10:00:00.000Z" as UtcTimestamp,
                isGitRepository: true,
                alreadyImported: false,
              },
            ],
          },
          {
            label: "beta",
            providers: ["codex"],
            sessionCount: 1,
            lastActivityAt: "2026-11-20T10:00:00.000Z" as UtcTimestamp,
            folders: [
              {
                id: FOLDER_B,
                folderName: "beta",
                providers: ["codex"],
                sessionCount: 1,
                lastActivityAt: "2026-11-20T10:00:00.000Z" as UtcTimestamp,
                isGitRepository: true,
                alreadyImported: false,
              },
            ],
          },
        ],
        stoppedEarly: false,
        scannedAt: "2026-11-21T10:05:00.000Z" as UtcTimestamp,
      }),
    );
    const importFolders = vi.fn(
      async (): Promise<ImportProviderFoldersResult> => ({
        status: "completed",
        results: [
          {
            folderId: FOLDER_A,
            status: "created",
            projectId: PROJECT_A,
            name: "alpha",
          },
        ],
      }),
    );

    render(
      <Step
        initial="code"
        providerFolderScan={{
          strict: false,
          scan,
          importFolders,
        }}
      />,
    );

    const alphaCheckbox = await screen.findByRole("checkbox", { name: /acme\/alpha/i });
    expect(screen.getByRole("button", { name: /import selected/i })).toBeDisabled();

    await user.click(alphaCheckbox);
    const importButton = screen.getByRole("button", { name: /import 1 code project/i });
    expect(importButton).toBeEnabled();
    await user.click(importButton);

    await waitFor(() => {
      expect(importFolders).toHaveBeenCalledWith([FOLDER_A]);
    });
    expect(await screen.findByText(/imported 1 code project/i)).toBeInTheDocument();

    // Rescan button stays available in the ready view (e.g. if IDs expire).
    await user.click(screen.getByRole("button", { name: "Scan again" }));
    await waitFor(() => {
      expect(scan).toHaveBeenCalledTimes(2);
    });
  });

  it("batches selections exceeding the per-request folder import limit sequentially", async () => {
    const user = userEvent.setup();
    const total = MAX_IMPORTED_PROVIDER_FOLDERS + 1;
    const groups: DiscoveredProviderFolderGroup[] = Array.from({ length: total }, (_, index) => {
      const id = folderIdAt(index + 1);
      const name = `repo-${String(index + 1)}`;
      return {
        label: name,
        providers: ["claude"],
        sessionCount: 1,
        lastActivityAt: "2026-11-21T10:00:00.000Z" as UtcTimestamp,
        folders: [
          {
            id,
            folderName: name,
            providers: ["claude"],
            sessionCount: 1,
            lastActivityAt: "2026-11-21T10:00:00.000Z" as UtcTimestamp,
            isGitRepository: true,
            alreadyImported: false,
          },
        ],
      };
    });

    const batchSizes: number[] = [];
    const importFolders = vi.fn(
      async (
        folderIds: readonly [
          ReturnType<typeof decodeDiscoveredProviderFolderId>,
          ...ReturnType<typeof decodeDiscoveredProviderFolderId>[],
        ],
      ): Promise<ImportProviderFoldersResult> => {
        batchSizes.push(folderIds.length);
        return {
          status: "completed",
          results: folderIds.map((folderId) => ({
            folderId,
            status: "created",
            projectId: PROJECT_A,
            name: "repo",
          })),
        };
      },
    );

    render(
      <Step
        initial="code"
        providerFolderScan={{
          strict: false,
          scan: async () => ({
            status: "ready",
            requireGitRepository: true,
            groups,
            stoppedEarly: false,
            scannedAt: "2026-11-21T10:05:00.000Z" as UtcTimestamp,
          }),
          importFolders,
        }}
      />,
    );

    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes).toHaveLength(total);
    for (const checkbox of checkboxes) {
      await user.click(checkbox);
    }

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`import ${String(total)} code projects`, "i"),
      }),
    );

    await waitFor(() => {
      expect(batchSizes).toEqual([MAX_IMPORTED_PROVIDER_FOLDERS, 1]);
    });
    expect(
      await screen.findByText(new RegExp(`imported ${String(total)} code projects`, "i")),
    ).toBeInTheDocument();
  });

  it("says when the scan stopped early", async () => {
    render(
      <Step
        initial="code"
        providerFolderScan={{
          strict: false,
          scan: async () => ({
            status: "ready",
            requireGitRepository: true,
            groups: [],
            stoppedEarly: true,
            stoppedEarlyReason: "file-limit",
            scannedAt: "2026-11-21T10:05:00.000Z" as UtcTimestamp,
          }),
          importFolders: async () => ({ status: "completed", results: [] }),
        }}
      />,
    );

    expect(await screen.findByText(/scan stopped early/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan again" })).toBeEnabled();
  });

  it("hides the first-run project scan under Strict", async () => {
    const scan = vi.fn(
      async (): Promise<ProviderFolderScanResult> => ({
        status: "hidden",
        reason: "strict",
      }),
    );

    const { rerender } = render(
      <Step
        initial="code"
        providerFolderScan={{
          strict: true,
          scan,
          importFolders: async () => ({ status: "completed", results: [] }),
        }}
      />,
    );

    expect(scan).not.toHaveBeenCalled();
    expect(screen.queryByText(/folders from your providers/i)).not.toBeInTheDocument();

    // Even when UI strict flag is false, a server-side Strict hidden response hides the scan.
    rerender(
      <Step
        initial="code"
        providerFolderScan={{
          strict: false,
          scan,
          importFolders: async () => ({ status: "completed", results: [] }),
        }}
      />,
    );

    await waitFor(() => {
      expect(scan).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/folders from your providers/i)).not.toBeInTheDocument();
  });
});

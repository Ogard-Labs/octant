import { describe, expect, it } from "vitest";
import {
  decodeImportProviderFoldersRequest,
  decodeImportProviderFoldersResult,
  decodeProviderFolderScanResult,
} from "./providerFolderScan";

const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("provider folder scan contracts", () => {
  it("decodes a ready scan result with opaque folder IDs and safe display labels", () => {
    const decoded = decodeProviderFolderScanResult({
      status: "ready",
      groups: [
        {
          repository: "acme/widget",
          label: "acme/widget",
          providers: ["claude", "codex"],
          sessionCount: 5,
          lastActivityAt: "2026-11-21T10:00:00.000Z",
          folders: [
            {
              id: FOLDER_ID,
              folderName: "widget",
              providers: ["claude", "codex"],
              sessionCount: 5,
              lastActivityAt: "2026-11-21T10:00:00.000Z",
              isGitRepository: true,
              alreadyImported: false,
            },
          ],
        },
      ],
      requireGitRepository: true,
      stoppedEarly: true,
      stoppedEarlyReason: "file-limit",
      scannedAt: "2026-11-21T10:05:00.000Z",
    });

    expect(decoded.status).toBe("ready");
    if (decoded.status === "ready") {
      expect(decoded.stoppedEarly).toBe(true);
      expect(decoded.stoppedEarlyReason).toBe("file-limit");
      expect(decoded.groups[0]?.repository).toBe("acme/widget");
    }
  });

  it("refuses host paths in discovered folder names or extra path fields", () => {
    expect(() =>
      decodeProviderFolderScanResult({
        status: "ready",
        groups: [
          {
            label: "widget",
            providers: ["claude"],
            sessionCount: 1,
            lastActivityAt: "2026-11-21T10:00:00.000Z",
            folders: [
              {
                id: FOLDER_ID,
                folderName: "/Users/alice/widget",
                providers: ["claude"],
                sessionCount: 1,
                lastActivityAt: "2026-11-21T10:00:00.000Z",
                isGitRepository: true,
                alreadyImported: false,
              },
            ],
          },
        ],
        requireGitRepository: true,
        stoppedEarly: false,
        scannedAt: "2026-11-21T10:05:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      decodeProviderFolderScanResult({
        status: "ready",
        groups: [
          {
            label: "widget",
            providers: ["claude"],
            sessionCount: 1,
            lastActivityAt: "2026-11-21T10:00:00.000Z",
            folders: [
              {
                id: FOLDER_ID,
                folderName: "widget",
                canonicalPath: "/Users/alice/widget",
                providers: ["claude"],
                sessionCount: 1,
                lastActivityAt: "2026-11-21T10:00:00.000Z",
                isGitRepository: true,
                alreadyImported: false,
              },
            ],
          },
        ],
        requireGitRepository: true,
        stoppedEarly: false,
        scannedAt: "2026-11-21T10:05:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes Strict-hidden scan results and strict import refusals", () => {
    expect(decodeProviderFolderScanResult({ status: "hidden", reason: "strict" })).toEqual({
      status: "hidden",
      reason: "strict",
    });

    expect(
      decodeImportProviderFoldersResult({
        status: "refused",
        reason: "strict",
        message: "Strict hides the first-run folder scan.",
      }),
    ).toEqual({
      status: "refused",
      reason: "strict",
      message: "Strict hides the first-run folder scan.",
    });
  });

  it("rejects empty or duplicate folder IDs in import requests", () => {
    expect(() => decodeImportProviderFoldersRequest({ folderIds: [] })).toThrow();
    expect(() =>
      decodeImportProviderFoldersRequest({ folderIds: [FOLDER_ID, FOLDER_ID] }),
    ).toThrow();

    const valid = decodeImportProviderFoldersRequest({ folderIds: [FOLDER_ID] });
    expect(valid.folderIds).toHaveLength(1);

    const result = decodeImportProviderFoldersResult({
      status: "completed",
      results: [
        {
          folderId: FOLDER_ID,
          status: "created",
          projectId: PROJECT_ID,
          name: "widget",
        },
      ],
    });
    expect(result.status).toBe("completed");
  });
});

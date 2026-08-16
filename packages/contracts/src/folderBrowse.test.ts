import { describe, expect, it } from "vitest";
import {
  decodeFolderBrowseMode,
  decodeFolderBrowseRequest,
  decodeFolderBrowseResult,
  decodeFolderCandidate,
  decodeFolderSelectionRequest,
  decodeFolderSelectionResult,
  decodeFolderBrowseFailure,
  decodeFolderBreadcrumb,
} from "./folderBrowse";

describe("FolderBrowseMode", () => {
  it("accepts work and code", () => {
    expect(decodeFolderBrowseMode("work")).toBe("work");
    expect(decodeFolderBrowseMode("code")).toBe("code");
  });
  it("rejects chat", () => {
    expect(() => decodeFolderBrowseMode("chat")).toThrow();
  });
});

describe("FolderCandidate", () => {
  it("decodes a selectable candidate", () => {
    const candidate = decodeFolderCandidate({
      candidateId: "00000000-0000-4000-8000-000000000001",
      displayName: "my-project",
      isGitRepository: true,
      isSelectable: true,
    });
    expect(candidate.displayName).toBe("my-project");
    expect(candidate.isGitRepository).toBe(true);
  });
  it("decodes an unselectable candidate with reason", () => {
    const candidate = decodeFolderCandidate({
      candidateId: "00000000-0000-4000-8000-000000000002",
      displayName: "not-a-repo",
      isGitRepository: false,
      isSelectable: false,
      unselectableReason: "Not a Git repository.",
    });
    expect(candidate.isSelectable).toBe(false);
    expect(candidate.unselectableReason).toBe("Not a Git repository.");
  });
  it("rejects empty displayName", () => {
    expect(() =>
      decodeFolderCandidate({
        candidateId: "00000000-0000-4000-8000-000000000001",
        displayName: "",
        isGitRepository: false,
        isSelectable: true,
      }),
    ).toThrow();
  });
});

describe("FolderBrowseRequest", () => {
  it("decodes a root browse request", () => {
    const request = decodeFolderBrowseRequest({
      hostId: "local",
      mode: "work",
    });
    expect(request.hostId).toBe("local");
    expect(request.mode).toBe("work");
  });
  it("decodes a child browse request", () => {
    const request = decodeFolderBrowseRequest({
      hostId: "local",
      mode: "code",
      parentCandidateId: "00000000-0000-4000-8000-000000000001",
    });
    expect(request.parentCandidateId).toBe("00000000-0000-4000-8000-000000000001");
  });
  it("decodes a search request", () => {
    const request = decodeFolderBrowseRequest({
      hostId: "local",
      mode: "work",
      search: "project",
    });
    expect(request.search).toBe("project");
  });
  it("rejects excess properties", () => {
    expect(() =>
      decodeFolderBrowseRequest({
        hostId: "local",
        mode: "work",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("FolderBrowseResult", () => {
  it("decodes a result with candidates and breadcrumbs", () => {
    const result = decodeFolderBrowseResult({
      candidates: [
        {
          candidateId: "00000000-0000-4000-8000-000000000001",
          displayName: "Documents",
          isGitRepository: false,
          isSelectable: true,
        },
      ],
      breadcrumbs: [
        { label: "Home" },
        { label: "Documents", candidateId: "00000000-0000-4000-8000-000000000001" },
      ],
      hasMore: false,
      browsedAt: "2026-07-24T12:00:00.000Z",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.breadcrumbs).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });
});

describe("FolderSelectionRequest", () => {
  it("decodes a selection", () => {
    const request = decodeFolderSelectionRequest({
      hostId: "local",
      mode: "work",
      candidateId: "00000000-0000-4000-8000-000000000001",
    });
    expect(request.candidateId).toBe("00000000-0000-4000-8000-000000000001");
  });
});

describe("FolderSelectionResult", () => {
  it("decodes a selection result", () => {
    const result = decodeFolderSelectionResult({
      receiptId: "abc123",
      displayName: "my-project",
      selectedAt: "2026-07-24T12:00:00.000Z",
    });
    expect(result.receiptId).toBe("abc123");
    expect(result.displayName).toBe("my-project");
  });
});

describe("FolderBrowseFailure", () => {
  it("decodes each failure category", () => {
    for (const category of ["invalid", "unauthorized", "unavailable", "not-found"] as const) {
      const failure = decodeFolderBrowseFailure({ category, message: "test" });
      expect(failure.category).toBe(category);
    }
  });
});

describe("FolderBreadcrumb", () => {
  it("decodes a breadcrumb without candidateId", () => {
    const crumb = decodeFolderBreadcrumb({ label: "Home" });
    expect(crumb.label).toBe("Home");
    expect(crumb.candidateId).toBeUndefined();
  });
  it("decodes a breadcrumb with candidateId", () => {
    const crumb = decodeFolderBreadcrumb({
      label: "Documents",
      candidateId: "00000000-0000-4000-8000-000000000001",
    });
    expect(crumb.candidateId).toBe("00000000-0000-4000-8000-000000000001");
  });
});

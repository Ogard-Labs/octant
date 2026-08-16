import { describe, expect, it } from "vitest";
import {
  filterComposerFolderEntries,
  validateFolderAttachment,
  validateFolderAttachmentAuthority,
} from "./rootlessThreadPolicy";
import type { ComposerFolderEntry } from "@octant/contracts/rootless-thread";

const project = {
  kind: "saved-project" as const,
  projectId: "00000000-0000-4000-8000-000000000001" as never,
  displayName: "Docs",
  rootPath: "/tmp/docs",
};
const entries: ComposerFolderEntry[] = [project, { kind: "add-folder" }, { kind: "no-folder" }];

describe("rootlessThreadPolicy", () => {
  it("allows attachment only for rootless workspaces without active turns", () => {
    expect(
      validateFolderAttachment({
        workspace: { kind: "rootless" },
        threadMode: "work",
        projectMode: "work",
        hasActiveTurn: false,
      }),
    ).toEqual({ kind: "allowed" });
    expect(
      validateFolderAttachment({
        workspace: { kind: "project-backed", projectId: project.projectId },
        threadMode: "work",
        projectMode: "work",
        hasActiveTurn: false,
      }).kind,
    ).toBe("denied");
  });

  it("filters saved projects by mode and query while keeping sentinels", () => {
    const filtered = filterComposerFolderEntries(
      entries,
      "code",
      "docs",
      new Map([[String(project.projectId), "work"]]),
    );
    expect(filtered.some((entry) => entry.kind === "saved-project")).toBe(false);
    expect(filtered.some((entry) => entry.kind === "add-folder")).toBe(true);
    expect(filtered.some((entry) => entry.kind === "no-folder")).toBe(true);
  });
});

describe("validateFolderAttachmentAuthority", () => {
  const baseAllowed = {
    workspace: { kind: "rootless" as const },
    threadMode: "work" as const,
    projectMode: "work" as const,
    hasActiveTurn: false,
    hostConnected: true,
    hostAuthorized: true,
    projectLifecycle: "active" as const,
    rootValid: true,
    bindingFresh: true,
    authorityGranted: true,
    requestCancelled: false,
  };

  it("allows attachment when every authority precondition holds", () => {
    expect(validateFolderAttachmentAuthority(baseAllowed)).toEqual({ kind: "allowed" });
  });

  it("denies with wrong-mode when thread and project modes differ", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, projectMode: "code" })).toEqual({
      kind: "denied",
      reason: "wrong-mode",
    });
  });

  it("denies with concurrent-turn when an active turn is in progress", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, hasActiveTurn: true })).toEqual({
      kind: "denied",
      reason: "concurrent-turn",
    });
  });

  it("denies with disconnected-host when the host is not connected", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, hostConnected: false })).toEqual({
      kind: "denied",
      reason: "disconnected-host",
    });
  });

  it("denies with policy-denied when the host is not authorized", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, hostAuthorized: false })).toEqual({
      kind: "denied",
      reason: "policy-denied",
    });
  });

  it("denies with archived when the project is archived", () => {
    expect(
      validateFolderAttachmentAuthority({ ...baseAllowed, projectLifecycle: "archived" }),
    ).toEqual({ kind: "denied", reason: "archived" });
  });

  it("denies with unavailable when the root is not valid", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, rootValid: false })).toEqual({
      kind: "denied",
      reason: "unavailable",
    });
  });

  it("denies with stale-binding when the binding is not fresh", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, bindingFresh: false })).toEqual({
      kind: "denied",
      reason: "stale-binding",
    });
  });

  it("denies with stale-binding when the workspace is already project-backed", () => {
    expect(
      validateFolderAttachmentAuthority({
        ...baseAllowed,
        workspace: { kind: "project-backed", projectId: project.projectId },
      }),
    ).toEqual({ kind: "denied", reason: "stale-binding" });
  });

  it("denies with cancelled when the request was cancelled", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, requestCancelled: true })).toEqual({
      kind: "denied",
      reason: "cancelled",
    });
  });

  it("denies with policy-denied when authority is not granted", () => {
    expect(validateFolderAttachmentAuthority({ ...baseAllowed, authorityGranted: false })).toEqual({
      kind: "denied",
      reason: "policy-denied",
    });
  });
});

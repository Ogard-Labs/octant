import { decodeProjectId } from "@octant/contracts/projects";
import { threadExportContainsForbiddenKey } from "./threadExportPolicy";
import { describe, expect, it } from "vitest";
import {
  authorizeHostExport,
  encodeHostExportPage,
  hostExportOmissions,
  projectHostExportProject,
  projectHostExportSettings,
} from "./hostExportPolicy";

const SEEDED_CREDENTIAL = "seeded-credential-do-not-export";

describe("authorizeHostExport", () => {
  it("allows only the local owner", () => {
    expect(authorizeHostExport("local-window")).toEqual({ kind: "allow" });
  });

  it.each(["remote-device", "paired-device"] as const)("refuses a %s principal", (principal) => {
    expect(authorizeHostExport(principal)).toEqual({
      kind: "deny",
      reason: "local-owner-only",
    });
  });
});

describe("host export secrets", () => {
  it("drops a seeded credential from the settings summary and the project cut", () => {
    const settings = projectHostExportSettings({
      chatEnabled: true,
      workEnabled: false,
      themeMode: "dark",
      apiKey: SEEDED_CREDENTIAL,
      password: SEEDED_CREDENTIAL,
      canonicalRoot: "/Users/ada/secret",
    });
    const project = projectHostExportProject({
      projectId: decodeProjectId("20000000-0000-4000-8000-000000000001"),
      name: "Notes",
      type: "work",
      lifecycle: "active",
      canonicalRoot: "/Users/ada/secret",
      apiKey: SEEDED_CREDENTIAL,
    });
    const serialized = JSON.stringify({ settings, project });
    expect(serialized).not.toContain(SEEDED_CREDENTIAL);
    expect(serialized).not.toContain("/Users/ada/secret");
    expect(threadExportContainsForbiddenKey({ settings, project })).toBe(false);
    expect(settings).toEqual({
      chatEnabled: true,
      workEnabled: false,
      themeMode: "dark",
    });
    expect(project).toEqual({
      projectId: decodeProjectId("20000000-0000-4000-8000-000000000001"),
      name: "Notes",
      type: "work",
      lifecycle: "active",
    });
  });

  it("refuses to write a page that still carries a forbidden key, and the refusal does not carry the credential", () => {
    const encoded = encodeHostExportPage({
      kind: "settings",
      settings: {
        chatEnabled: true,
        workEnabled: true,
        themeMode: "system",
        apiKey: SEEDED_CREDENTIAL,
      },
    });
    expect(encoded.kind).toBe("refused");
    expect(JSON.stringify(encoded)).not.toContain(SEEDED_CREDENTIAL);
  });
});

describe("hostExportOmissions", () => {
  it("names what a host export leaves out and why", () => {
    const omissions = hostExportOmissions();
    expect(omissions.map((omission) => omission.subject)).toEqual([
      "credentials",
      "filesystem-paths",
      "attachment-bytes",
      "raw-provider-payloads",
      "composer-drafts",
      "paired-device-keys",
      "window-capabilities",
    ]);
    expect(omissions.every((omission) => omission.reason.length > 0)).toBe(true);
  });
});

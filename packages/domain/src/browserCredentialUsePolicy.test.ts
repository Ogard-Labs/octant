import { describe, expect, it } from "vitest";
import {
  decodeBrowserCredentialGrant,
  decodeBrowserCredentialTarget,
} from "@octant/contracts/browser-credential-use";
import { browserCredentialGrantMatches } from "./browserCredentialUsePolicy";

const projectId = "00000000-0000-4000-8000-000000000001";
const contextId = "00000000-0000-4000-8000-000000000002";
const threadId = "00000000-0000-4000-8000-000000000003";
const hostSessionId = "00000000-0000-4000-8000-000000000004";
const target = decodeBrowserCredentialTarget({
  contextId,
  threadId,
  mode: "code",
  projectId,
  profile: { kind: "project", projectId },
  topOrigin: "https://login.example:8443",
  frame: { kind: "top", origin: "https://login.example:8443" },
});
const grant = decodeBrowserCredentialGrant({
  kind: "browser-credential-grant",
  grantId: "00000000-0000-4000-8000-000000000005",
  hostSessionId,
  target,
  metadata: {
    item: {
      store: "onepassword",
      accountId: "a".repeat(26),
      vaultId: "v".repeat(26),
      itemId: "i".repeat(26),
    },
    title: "Fixture",
    version: 1,
    websiteOrigins: [target.topOrigin],
    storeRevision: "fixture-link",
  },
  scope: { kind: "project", projectId },
  createdAt: "2026-11-03T10:00:00.000Z",
  expiresAt: "2026-11-03T18:00:00.000Z",
});

describe("Browser credential-use permission", () => {
  it("reuses a Project binding across eligible threads without widening site or profile", () => {
    const other = { ...target, threadId: "other-thread" as typeof target.threadId };
    expect(
      browserCredentialGrantMatches(
        grant,
        other,
        hostSessionId,
        Date.parse("2026-11-03T11:00:00Z"),
      ),
    ).toBe(true);
  });
  it.each([
    { ...target, topOrigin: "https://login.example" },
    { ...target, frame: { kind: "top" as const, origin: "https://other.example" } },
    { ...target, projectId: "00000000-0000-4000-8000-000000000099" as typeof target.projectId },
    { ...target, profile: { kind: "personal" as const } },
  ])("refuses a changed exact origin, frame, Project or profile", (changed) => {
    expect(
      browserCredentialGrantMatches(
        grant,
        changed,
        hostSessionId,
        Date.parse("2026-11-03T11:00:00Z"),
      ),
    ).toBe(false);
  });
  it("refuses expiry, host restart and a task binding on another context", () => {
    expect(
      browserCredentialGrantMatches(grant, target, "restarted", Date.parse("2026-11-03T11:00:00Z")),
    ).toBe(false);
    expect(
      browserCredentialGrantMatches(grant, target, hostSessionId, Date.parse(grant.expiresAt)),
    ).toBe(false);
    const scoped = {
      ...grant,
      scope: {
        kind: "task" as const,
        projectId: target.projectId,
        threadId: target.threadId,
        contextId: target.contextId,
      },
    };
    expect(
      browserCredentialGrantMatches(
        scoped,
        { ...target, contextId: "other" as typeof target.contextId },
        hostSessionId,
        Date.parse("2026-11-03T11:00:00Z"),
      ),
    ).toBe(false);
  });
});

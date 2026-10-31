import { describe, expect, it } from "vitest";
import {
  decodeBrowserProfile,
  decodeProjectId,
  type BrowserProfile,
  type RememberedBrowserProfileSite,
} from "@octant/contracts";
import {
  browserProfileKey,
  browserProfilePartition,
  browserProfilePartitionFolder,
  evaluateBrowserProfileUse,
  isBrowserProfileSiteRemembered,
  resolveRememberedBrowserProfileSites,
  sameBrowserProfile,
  storedBrowserProfileOfPartitionFolder,
} from "./browserProfilePolicy";

const projectId = decodeProjectId("11111111-2222-4333-8444-555555555555");
const otherProjectId = decodeProjectId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const project: BrowserProfile = { kind: "project", projectId };
const personal: BrowserProfile = { kind: "personal" };

describe("browser profile partitions", () => {
  it("keeps a Private page in a partition of its own browsing context", () => {
    expect(browserProfilePartition(undefined, "ctx-1")).toBe("octant-browser-ctx-1");
    expect(browserProfilePartition({ kind: "private" }, "ctx-2")).toBe("octant-browser-ctx-2");
  });

  it("gives every page of a stored profile the same persistent partition", () => {
    expect(browserProfilePartition(personal, "ctx-1")).toBe("persist:octant-profile-personal");
    expect(browserProfilePartition(personal, "ctx-2")).toBe("persist:octant-profile-personal");
    expect(browserProfilePartition(project, "ctx-1")).toBe(
      "persist:octant-profile-project-11111111-2222-4333-8444-555555555555",
    );
  });

  it("never lets two Projects share a partition", () => {
    expect(browserProfilePartition(project, "a")).not.toBe(
      browserProfilePartition({ kind: "project", projectId: otherProjectId }, "a"),
    );
  });

  it("round-trips a profile through its folder under Partitions", () => {
    for (const profile of [personal, project]) {
      const stored = decodeBrowserProfile(profile);
      if (stored.kind === "private") throw new Error("expected a stored profile");
      const folder = browserProfilePartitionFolder(stored);
      expect(storedBrowserProfileOfPartitionFolder(folder)).toEqual(
        stored.kind === "personal"
          ? { kind: "personal" }
          : { kind: "project", projectId: String(stored.projectId) },
      );
    }
  });

  it("does not claim folders that are not Octant profile stores", () => {
    expect(storedBrowserProfileOfPartitionFolder("octant-browser-123")).toBeUndefined();
    expect(
      storedBrowserProfileOfPartitionFolder("octant-profile-project-../../etc"),
    ).toBeUndefined();
    expect(storedBrowserProfileOfPartitionFolder("something-else")).toBeUndefined();
  });

  it("compares profiles by what they are, not by object identity", () => {
    expect(sameBrowserProfile({ kind: "project", projectId }, project)).toBe(true);
    expect(sameBrowserProfile(project, personal)).toBe(false);
    expect(sameBrowserProfile(undefined, { kind: "private" })).toBe(true);
    expect(browserProfileKey(project)).toBe(`project:${String(projectId)}`);
  });
});

describe("evaluateBrowserProfileUse", () => {
  const base = { nativeBrowserAvailable: true } as const;
  const codeAuthority = { mode: "code", projectId } as const;

  it("lets anyone open a Private page, which carries no sign-in", () => {
    for (const caller of ["person", "remote-device", "unattended", "terminal-grant"] as const) {
      expect(
        evaluateBrowserProfileUse({
          ...base,
          nativeBrowserAvailable: false,
          profile: undefined,
          caller,
        }).kind,
      ).toBe("allowed");
    }
  });

  it("lets the person open the Project or Personal profile", () => {
    expect(
      evaluateBrowserProfileUse({
        ...base,
        profile: project,
        caller: "person",
        authority: codeAuthority,
      }).kind,
    ).toBe("allowed");
    expect(
      evaluateBrowserProfileUse({
        ...base,
        profile: personal,
        caller: "person",
        authority: codeAuthority,
      }).kind,
    ).toBe("allowed");
  });

  it("refuses a paired device with profile-not-local", () => {
    expect(
      evaluateBrowserProfileUse({ ...base, profile: personal, caller: "remote-device" }),
    ).toMatchObject({ kind: "refused", reason: "profile-not-local" });
  });

  it("refuses a routine, a subagent, and a terminal grant with profile-needs-a-person", () => {
    for (const caller of ["unattended", "terminal-grant"] as const) {
      expect(evaluateBrowserProfileUse({ ...base, profile: project, caller })).toMatchObject({
        kind: "refused",
        reason: "profile-needs-a-person",
      });
    }
  });

  it("refuses a profile page when there is no desktop Browser to hold the store", () => {
    expect(
      evaluateBrowserProfileUse({
        profile: personal,
        caller: "person",
        nativeBrowserAvailable: false,
      }),
    ).toMatchObject({ kind: "refused", reason: "profile-unavailable" });
  });

  it("refuses Chat, which has no Browser profile", () => {
    expect(
      evaluateBrowserProfileUse({
        ...base,
        profile: personal,
        caller: "person",
        authority: { mode: "chat", projectId },
      }),
    ).toMatchObject({ kind: "refused", reason: "profile-unavailable" });
  });

  it("refuses another Project's profile", () => {
    expect(
      evaluateBrowserProfileUse({
        ...base,
        profile: { kind: "project", projectId: otherProjectId },
        caller: "person",
        authority: codeAuthority,
      }),
    ).toMatchObject({ kind: "refused", reason: "profile-unavailable" });
  });
});

describe("remembered signed-in sites", () => {
  const remembered: ReadonlyArray<RememberedBrowserProfileSite> = [
    { origin: "https://github.com", profile: { kind: "personal" } },
  ];

  it("covers the exact (origin, profile) pair only", () => {
    expect(
      isBrowserProfileSiteRemembered(remembered, "https://github.com", { kind: "personal" }),
    ).toBe(true);
    expect(
      isBrowserProfileSiteRemembered(remembered, "https://github.com", {
        kind: "project",
        projectId,
      }),
    ).toBe(false);
    expect(
      isBrowserProfileSiteRemembered(remembered, "https://example.com", { kind: "personal" }),
    ).toBe(false);
  });

  it("lets a settings write forget a pair but not add one", () => {
    expect(resolveRememberedBrowserProfileSites(remembered, [])).toEqual({
      kind: "kept",
      sites: [],
    });
    expect(resolveRememberedBrowserProfileSites(remembered, undefined)).toEqual({
      kind: "kept",
      sites: remembered,
    });
    expect(
      resolveRememberedBrowserProfileSites(remembered, [
        ...remembered,
        { origin: "https://evil.example", profile: { kind: "personal" } },
      ]),
    ).toEqual({ kind: "rejected" });
  });
});

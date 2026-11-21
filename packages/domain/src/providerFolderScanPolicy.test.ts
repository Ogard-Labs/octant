import { describe, expect, it } from "vitest";
import { decodeDiscoveredProviderFolderId, type UtcTimestamp } from "@octant/contracts";
import {
  groupDiscoveredProviderFolders,
  isExcludedProviderFolder,
  parseRemoteOwnerName,
  safeDiscoveredFolderName,
} from "./providerFolderScanPolicy";

const ID_1 = decodeDiscoveredProviderFolderId("11111111-1111-4111-8111-111111111111");
const ID_2 = decodeDiscoveredProviderFolderId("22222222-2222-4222-8222-222222222222");
const ID_3 = decodeDiscoveredProviderFolderId("33333333-3333-4333-8333-333333333333");

describe("providerFolderScanPolicy", () => {
  it("parses SSH and HTTPS git remotes into credential-free owner/name slugs", () => {
    expect(parseRemoteOwnerName("git@github.com:Ogard-Labs/octant.git")).toEqual({
      host: "github.com",
      owner: "Ogard-Labs",
      name: "octant",
      slug: "Ogard-Labs/octant",
      groupKey: "github.com/ogard-labs/octant",
    });
    expect(parseRemoteOwnerName("https://github.com/ogard-labs/octant")).toEqual({
      host: "github.com",
      owner: "ogard-labs",
      name: "octant",
      slug: "ogard-labs/octant",
      groupKey: "github.com/ogard-labs/octant",
    });
    expect(parseRemoteOwnerName("ssh://git@gitlab.com/team/service.git")).toEqual({
      host: "gitlab.com",
      owner: "team",
      name: "service",
      slug: "team/service",
      groupKey: "gitlab.com/team/service",
    });
  });

  it("refuses credentialed, local-path, and malformed git remotes", () => {
    expect(parseRemoteOwnerName("https://user:secret@github.com/acme/app.git")).toBeUndefined();
    expect(parseRemoteOwnerName("https://token@github.com/acme/app.git")).toBeUndefined();
    expect(parseRemoteOwnerName("/Users/alice/repos/bare.git")).toBeUndefined();
    expect(parseRemoteOwnerName("file:///Users/alice/repos/bare.git")).toBeUndefined();
    expect(parseRemoteOwnerName("https://github.com/acme/../secret")).toBeUndefined();
    expect(parseRemoteOwnerName("not a url")).toBeUndefined();
  });

  it("derives safe single-segment display names from folder paths", () => {
    expect(safeDiscoveredFolderName("/Users/alice/code/my-app/")).toBe("my-app");
    expect(safeDiscoveredFolderName("/Users/alice/code/notes")).toBe("notes");
    expect(safeDiscoveredFolderName("/")).toBeUndefined();
    expect(safeDiscoveredFolderName("/Users/alice/..")).toBeUndefined();
  });

  it("excludes Downloads, nested Downloads folders, home, and filesystem root", () => {
    expect(isExcludedProviderFolder("/Users/alice/Downloads", "/Users/alice")).toBe(true);
    expect(isExcludedProviderFolder("/Users/alice/downloads/archive-repo", "/Users/alice")).toBe(
      true,
    );
    expect(isExcludedProviderFolder("/Users/alice", "/Users/alice")).toBe(true);
    expect(isExcludedProviderFolder("/", "/Users/alice")).toBe(true);
    expect(isExcludedProviderFolder("/Users/alice/code/downloads-service", "/Users/alice")).toBe(
      false,
    );
    expect(isExcludedProviderFolder("/Users/alice/code/octant", "/Users/alice")).toBe(false);
  });

  it("groups clones of one remote together and keeps non-remote folders separate", () => {
    const remote = parseRemoteOwnerName("git@github.com:acme/widget.git");
    const remoteHttps = parseRemoteOwnerName("https://github.com/Acme/Widget.git");
    expect(remote).toBeDefined();
    expect(remoteHttps).toBeDefined();
    if (remote === undefined || remoteHttps === undefined) return;

    const groups = groupDiscoveredProviderFolders([
      {
        id: ID_1,
        folderName: "widget",
        repository: { slug: remote.slug, groupKey: remote.groupKey },
        providers: ["claude", "codex"],
        sessionCount: 4,
        lastActivityAt: "2026-11-21T09:00:00.000Z" as UtcTimestamp,
        alreadyImported: false,
      },
      {
        id: ID_2,
        folderName: "widget-copy",
        repository: { slug: remoteHttps.slug, groupKey: remoteHttps.groupKey },
        providers: ["pi", "claude"],
        sessionCount: 2,
        lastActivityAt: "2026-11-21T10:00:00.000Z" as UtcTimestamp,
        alreadyImported: false,
      },
      {
        id: ID_3,
        folderName: "local-notes",
        providers: ["opencode"],
        sessionCount: 3,
        lastActivityAt: "2026-11-21T08:00:00.000Z" as UtcTimestamp,
        alreadyImported: true,
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      repository: "Acme/Widget",
      label: "Acme/Widget",
      providers: ["claude", "codex", "pi"],
      sessionCount: 6,
      lastActivityAt: "2026-11-21T10:00:00.000Z",
      folders: [
        {
          id: ID_2,
          folderName: "widget-copy",
          providers: ["claude", "pi"],
          sessionCount: 2,
          lastActivityAt: "2026-11-21T10:00:00.000Z",
          alreadyImported: false,
        },
        {
          id: ID_1,
          folderName: "widget",
          providers: ["claude", "codex"],
          sessionCount: 4,
          lastActivityAt: "2026-11-21T09:00:00.000Z",
          alreadyImported: false,
        },
      ],
    });
    expect(groups[1]).toEqual({
      label: "local-notes",
      providers: ["opencode"],
      sessionCount: 3,
      lastActivityAt: "2026-11-21T08:00:00.000Z",
      folders: [
        {
          id: ID_3,
          folderName: "local-notes",
          providers: ["opencode"],
          sessionCount: 3,
          lastActivityAt: "2026-11-21T08:00:00.000Z",
          alreadyImported: true,
        },
      ],
    });
  });
});

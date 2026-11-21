import type {
  DiscoveredFolderProvider,
  DiscoveredProviderFolder,
  DiscoveredProviderFolderGroup,
  DiscoveredProviderFolderId,
  DiscoveredRepositorySlug,
  SafeDiscoveredFolderName,
  UtcTimestamp,
} from "@octant/contracts";

export interface ParsedRemoteOwnerName {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly slug: DiscoveredRepositorySlug;
  /** Internal grouping key combining host and lowercase owner/name. Never sent to the renderer. */
  readonly groupKey: string;
}

export interface ObservedProviderFolder {
  readonly id: DiscoveredProviderFolderId;
  readonly folderName: SafeDiscoveredFolderName;
  readonly repository?: {
    readonly slug: DiscoveredRepositorySlug;
    readonly groupKey: string;
  };
  readonly providers: ReadonlyArray<DiscoveredFolderProvider>;
  readonly sessionCount: number;
  readonly lastActivityAt: UtcTimestamp;
  readonly alreadyImported: boolean;
}

const PROVIDER_ORDER: ReadonlyArray<DiscoveredFolderProvider> = [
  "claude",
  "codex",
  "opencode",
  "pi",
];

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCP_REMOTE_PATTERN = /^(?:git@)?([A-Za-z0-9.-]+):([^/:][^:]*?)(?:\.git)?$/;
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * Extract a credential-free `owner/name` repository identifier from a Git
 * remote URL, or return undefined when the remote carries credentials, a local
 * path, or an unexpected shape.
 */
export function parseRemoteOwnerName(remoteUrl: string): ParsedRemoteOwnerName | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0 || trimmed.includes("\0") || /\s/.test(trimmed)) return undefined;

  const scp = SCP_REMOTE_PATTERN.exec(trimmed);
  if (scp !== null && !trimmed.includes("://")) {
    const host = scp[1];
    const path = scp[2];
    if (host === undefined || path === undefined || !HOST_PATTERN.test(host)) return undefined;
    return buildRemoteIdentity(host, path);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return undefined;
  if (parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return undefined;
  if (parsed.protocol === "https:" && parsed.username !== "") return undefined;
  if (parsed.protocol === "ssh:" && parsed.username !== "" && parsed.username !== "git") {
    return undefined;
  }
  const host = parsed.hostname;
  if (!HOST_PATTERN.test(host)) return undefined;
  const path = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
  return buildRemoteIdentity(host, path);
}

function buildRemoteIdentity(host: string, path: string): ParsedRemoteOwnerName | undefined {
  const segments = path.split("/");
  if (segments.length !== 2) return undefined;
  const [owner, name] = segments;
  if (
    owner === undefined ||
    name === undefined ||
    !isSafeRemoteSegment(owner) ||
    !isSafeRemoteSegment(name)
  ) {
    return undefined;
  }
  const slug = `${owner}/${name}`;
  if (slug.length > 200) return undefined;
  const lowerHost = host.toLowerCase();
  return {
    host: lowerHost,
    owner,
    name,
    slug: slug as DiscoveredRepositorySlug,
    groupKey: `${lowerHost}/${owner.toLowerCase()}/${name.toLowerCase()}`,
  };
}

function isSafeRemoteSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 100 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    SEGMENT_PATTERN.test(segment)
  );
}

/**
 * Derive a safe single-segment display name for a folder path. Never returns a
 * full path, parent segments, or control characters.
 */
export function safeDiscoveredFolderName(folderPath: string): SafeDiscoveredFolderName | undefined {
  const normalized = stripTrailingSlashes(folderPath.replaceAll("\\", "/").trim());
  if (normalized === "" || normalized === "/") return undefined;
  const lastSlash = normalized.lastIndexOf("/");
  const raw = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  // oxlint-disable-next-line no-control-regex -- strip C0 and DEL from display labels.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (
    cleaned === "" ||
    cleaned === "." ||
    cleaned === ".." ||
    cleaned.includes("/") ||
    cleaned.includes("\\")
  ) {
    return undefined;
  }
  return Array.from(cleaned).slice(0, 128).join("") as SafeDiscoveredFolderName;
}

/**
 * Exclude folders that should never be offered as first-run Code Projects:
 * Downloads (and anything inside it), the home directory itself, and the
 * filesystem root.
 */
export function isExcludedProviderFolder(canonicalPath: string, homeDirectory: string): boolean {
  const path = stripTrailingSlashes(canonicalPath.replaceAll("\\", "/"));
  const home = stripTrailingSlashes(homeDirectory.replaceAll("\\", "/"));
  if (path === "" || path === "/") return true;
  if (home !== "" && path.toLowerCase() === home.toLowerCase()) return true;
  if (home !== "") {
    const downloadsPrefix = `${home.toLowerCase()}/downloads`;
    const lowerPath = path.toLowerCase();
    if (lowerPath === downloadsPrefix || lowerPath.startsWith(`${downloadsPrefix}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Group clones of the same Git remote into one entry while keeping non-remote
 * folders standalone. Output contains only opaque IDs and safe display labels.
 */
export function groupDiscoveredProviderFolders(
  folders: ReadonlyArray<ObservedProviderFolder>,
): ReadonlyArray<DiscoveredProviderFolderGroup> {
  const grouped = new Map<
    string,
    {
      readonly repositorySlug?: DiscoveredRepositorySlug;
      readonly entries: ObservedProviderFolder[];
    }
  >();

  let standaloneIndex = 0;
  for (const folder of folders) {
    const key =
      folder.repository !== undefined
        ? `remote:${folder.repository.groupKey}`
        : `standalone:${String(standaloneIndex++)}`;
    const existing = grouped.get(key);
    if (existing !== undefined) {
      existing.entries.push(folder);
    } else {
      grouped.set(key, {
        ...(folder.repository === undefined ? {} : { repositorySlug: folder.repository.slug }),
        entries: [folder],
      });
    }
  }

  const groups: DiscoveredProviderFolderGroup[] = [];
  for (const group of grouped.values()) {
    const sortedEntries = [...group.entries].sort(compareObservedFolders);
    const first = sortedEntries[0];
    if (first === undefined) continue;

    const folderItems: DiscoveredProviderFolder[] = [];
    let totalSessions = 0;
    const providerSet = new Set<DiscoveredFolderProvider>();
    for (const entry of sortedEntries) {
      const sortedProviders = sortProviders(entry.providers);
      if (sortedProviders === undefined) continue;
      for (const provider of sortedProviders) providerSet.add(provider);
      totalSessions += entry.sessionCount;
      folderItems.push({
        id: entry.id,
        folderName: entry.folderName,
        providers: sortedProviders,
        sessionCount: entry.sessionCount,
        lastActivityAt: entry.lastActivityAt,
        alreadyImported: entry.alreadyImported,
      });
    }
    const [firstFolder, ...restFolders] = folderItems;
    const groupProviders = sortProviders([...providerSet]);
    if (firstFolder === undefined || groupProviders === undefined) continue;

    // Prefer the most recently active clone's casing of owner/name.
    const repository = first.repository?.slug ?? group.repositorySlug;
    groups.push({
      ...(repository === undefined ? {} : { repository }),
      label: repository ?? firstFolder.folderName,
      providers: groupProviders,
      sessionCount: totalSessions,
      lastActivityAt: firstFolder.lastActivityAt,
      folders: [firstFolder, ...restFolders],
    });
  }

  return groups.sort(compareGroups);
}

function sortProviders(
  providers: ReadonlyArray<DiscoveredFolderProvider>,
): readonly [DiscoveredFolderProvider, ...DiscoveredFolderProvider[]] | undefined {
  const unique = new Set(providers);
  const ordered = PROVIDER_ORDER.filter((provider) => unique.has(provider));
  const [first, ...rest] = ordered;
  return first === undefined ? undefined : [first, ...rest];
}

function compareObservedFolders(
  left: ObservedProviderFolder,
  right: ObservedProviderFolder,
): number {
  const activity = right.lastActivityAt.localeCompare(left.lastActivityAt);
  if (activity !== 0) return activity;
  const sessions = right.sessionCount - left.sessionCount;
  if (sessions !== 0) return sessions;
  return left.folderName.localeCompare(right.folderName);
}

function compareGroups(
  left: DiscoveredProviderFolderGroup,
  right: DiscoveredProviderFolderGroup,
): number {
  const activity = right.lastActivityAt.localeCompare(left.lastActivityAt);
  if (activity !== 0) return activity;
  const sessions = right.sessionCount - left.sessionCount;
  if (sessions !== 0) return sessions;
  return left.label.localeCompare(right.label);
}

function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path.charAt(end - 1) === "/") {
    end -= 1;
  }
  return path.slice(0, end);
}

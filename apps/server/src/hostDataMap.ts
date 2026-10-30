import { join } from "node:path";
import { decodeProjectId } from "@octant/contracts";
import { CLAUDE_ACCOUNT_PROFILE, CODEX_ACCOUNT_PROFILE } from "@octant/domain";
import { localHostDisplayName } from "./localHostDisplayName";
import type {
  HostDataMap,
  HostDataMapCredentials,
  HostDataMapHostKind,
  HostDataMapLocation,
  HostDataMapNamedLocation,
  HostDataMapOutboundCategory,
  HostDataMapProject,
  HostDataMapProjectType,
} from "@octant/contracts/host-data-map";
import type { HostControlServiceMode } from "@octant/contracts/host-control";

const JOURNAL_FILENAME = "octant.sqlite3";
const PROVIDER_CREDENTIAL_SERVICE = "app.octant.provider-credentials";
const HOST_IDENTITY_CREDENTIAL_SERVICE = "app.octant.host-identity.v1";
const REPLICA_DEVICE_KEY_CREDENTIAL_SERVICE = "app.octant.replica-device-keys.v1";
const REPLICA_STORE_CREDENTIAL_SERVICE = "app.octant.replica-store-credentials.v1";
const MCP_SERVER_CREDENTIAL_SERVICE = "app.octant.mcp-server-credentials.v1";
const DESKTOP_PROVIDER_CREDENTIAL_SERVICE = "app.octant.desktop-provider-credentials.v1";

const ARTIFACT_DIRECTORIES: ReadonlyArray<{ readonly name: string; readonly relative: string }> = [
  { name: "Apple toolchain artifacts", relative: "artifacts" },
];

// Every directory the confirmed thread purge sweep reaches outside the
// journal must appear here, or the map under-states the erasure scope.
// The host roots its chat stores at <dataDirectory>/chat, so a relative
// path below "chat/" names where the running host actually writes.
const CACHE_DIRECTORIES: ReadonlyArray<{ readonly name: string; readonly relative: string }> = [
  { name: "Local provider usage history", relative: "local-usage-cache.sqlite3" },
  { name: "Provider plan usage", relative: "providers/plan-usage.json" },
  { name: "Provider usage readings", relative: "providers/usage-readings.json" },
  { name: "Chat scratch", relative: "chat/scratch" },
  { name: "Chat attachments", relative: "chat/threads" },
  { name: "Work attachments", relative: "work-threads" },
  { name: "Code attachments", relative: "code-threads" },
  { name: "Generated images", relative: "generated-images" },
  { name: "Browser captures", relative: "browser-captures" },
  { name: "Agent messages", relative: "agent-messages" },
  { name: "Agent-run scratch", relative: "agent-run-scratch" },
  { name: "Agent-run workspace receipts", relative: "agent-run-workspace-receipts" },
  { name: "Managed worktree receipts", relative: "managed-worktree-receipts" },
  { name: "Installed extensions", relative: "extensions" },
  // The desktop app installs the computer-use driver here, and the host keeps
  // its runtime receipts under it, so a person inspecting the store sees it.
  { name: "Computer use driver", relative: "computer-use" },
  // A leftover of the removed SSH targets: the owner-only known-hosts files
  // they pinned. Nothing reads or writes them now, and Octant leaves them in
  // place; the person may delete the folder.
  { name: "Leftover SSH target host-key pins (unused)", relative: "ssh-targets" },
];

// Octant assigns each extra provider account a folder under the person's
// home. The provider's own CLI fills it with that account's sign-in and
// history, and removing the account in Octant leaves the folder in place, so
// the map names where those folders live.
const ACCOUNT_DIRECTORIES: ReadonlyArray<{ readonly name: string; readonly relative: string }> = [
  { name: "Claude account folders", relative: CLAUDE_ACCOUNT_PROFILE.extraAccountsDirectoryName },
  { name: "Codex account homes", relative: CODEX_ACCOUNT_PROFILE.extraAccountsDirectoryName },
];

const RELATED_RETENTION = {
  kind: "thread-retention" as const,
  settings: { section: "data" as const, setting: "thread-retention" },
};

const RELATED_EXPORT = {
  kind: "thread-export" as const,
  guidance:
    "Export everything this host holds from Data & privacy. This map does not export or purge.",
};

export interface HostDataMapProjectInput {
  readonly id: string;
  readonly name: string;
  readonly type: HostDataMapProjectType;
  readonly boundRoot?: string;
}

export interface HostDataMapCredentialStoreInput {
  readonly backend: "keychain" | "secret-service";
  readonly entries: ReadonlyArray<{ readonly service: string }>;
}

export interface ComposeHostDataMapInput {
  readonly hostId: string;
  readonly serviceMode: HostControlServiceMode;
  readonly platform?: "darwin" | "linux";
  readonly dataDirectory?: string;
  readonly homeDirectory?: string;
  readonly credentialStore?: HostDataMapCredentialStoreInput;
  readonly projects?: ReadonlyArray<HostDataMapProjectInput>;
}

/**
 * Builds the read-only data map from host-runtime paths and verified Project
 * facts. Missing inputs become `unknown`; nothing is inferred from platform
 * folklore.
 */
export function composeHostDataMap(input: ComposeHostDataMapInput): HostDataMap {
  const kind: HostDataMapHostKind = input.serviceMode === "desktop" ? "desktop" : "headless";
  const store = knownPath(input.dataDirectory);
  const journal: HostDataMapLocation =
    store === undefined
      ? { kind: "unknown" }
      : { kind: "known", path: join(store, JOURNAL_FILENAME) };
  const credentials = composeCredentials(input.credentialStore);
  const hostCaches = [
    ...namedLocations(store, CACHE_DIRECTORIES),
    ...namedLocations(knownPath(input.homeDirectory), ACCOUNT_DIRECTORIES),
  ];

  return {
    host: {
      hostId: input.hostId,
      displayName: localHostDisplayName(input.platform ?? process.platform),
      kind,
      serviceMode: input.serviceMode,
      journal,
      projections: journal,
      artifacts: namedLocations(store, ARTIFACT_DIRECTORIES),
      caches: hostCaches,
      credentials,
      outbound: composeOutbound(kind),
    },
    projects:
      input.projects === undefined
        ? { kind: "unknown" }
        : {
            kind: "known",
            projects: input.projects.flatMap((project) => composeProject(project, journal)),
          },
    related: [RELATED_RETENTION, RELATED_EXPORT],
  };
}

export function desktopCredentialStore(): HostDataMapCredentialStoreInput {
  return {
    backend: "keychain",
    entries: [
      { service: PROVIDER_CREDENTIAL_SERVICE },
      { service: HOST_IDENTITY_CREDENTIAL_SERVICE },
      { service: REPLICA_DEVICE_KEY_CREDENTIAL_SERVICE },
      { service: REPLICA_STORE_CREDENTIAL_SERVICE },
      { service: MCP_SERVER_CREDENTIAL_SERVICE },
      { service: DESKTOP_PROVIDER_CREDENTIAL_SERVICE },
    ],
  };
}

function composeProject(
  project: HostDataMapProjectInput,
  journal: HostDataMapLocation,
): ReadonlyArray<HostDataMapProject> {
  let projectId;
  try {
    projectId = decodeProjectId(project.id);
  } catch {
    return [];
  }
  const name = project.name.trim();
  if (name.length === 0) return [];

  const boundRoot =
    project.type === "chat"
      ? undefined
      : project.boundRoot === undefined
        ? { kind: "unknown" as const }
        : locationFromPath(project.boundRoot);

  const mapped: HostDataMapProject = {
    projectId,
    name,
    type: project.type,
    journal,
    projections: journal,
    artifacts: [{ name: "Canvas and library artifacts", location: journal }],
    caches: [{ name: "Thread attachments and scratch", location: { kind: "unknown" } }],
    credentials: { kind: "unknown" },
    ...(boundRoot === undefined ? {} : { boundRoot }),
  };
  return [mapped];
}

function composeCredentials(
  store: HostDataMapCredentialStoreInput | undefined,
): HostDataMapCredentials {
  if (store === undefined || store.entries.length === 0) return { kind: "unknown" };
  const entries = store.entries
    .map((entry) => entry.service.trim())
    .filter((service) => service.length > 0)
    .map((service) => ({ service }));
  if (entries.length === 0) return { kind: "unknown" };
  return { kind: "known", backend: store.backend, entries };
}

function composeOutbound(kind: HostDataMapHostKind): ReadonlyArray<HostDataMapOutboundCategory> {
  const provider: HostDataMapOutboundCategory = {
    kind: "known",
    category: "provider-calls",
    leavesMachine: true,
    purpose: "Requests you send to a configured provider leave this machine.",
  };
  const marketplace: HostDataMapOutboundCategory = {
    kind: "known",
    category: "marketplace-fetches",
    leavesMachine: true,
    purpose: "Skill search talks to skills.sh and npm when you search the marketplace.",
  };
  const updates: HostDataMapOutboundCategory =
    kind === "desktop"
      ? {
          kind: "known",
          category: "update-checks",
          leavesMachine: true,
          purpose: "Signed update checks send version, platform, and architecture.",
        }
      : {
          kind: "known",
          category: "update-checks",
          leavesMachine: false,
          purpose: "This headless host does not check for desktop app updates.",
        };
  return [provider, updates, marketplace];
}

function namedLocations(
  dataDirectory: string | undefined,
  entries: ReadonlyArray<{ readonly name: string; readonly relative: string }>,
): ReadonlyArray<HostDataMapNamedLocation> {
  return entries.map((entry) => ({
    name: entry.name,
    location:
      dataDirectory === undefined
        ? { kind: "unknown" }
        : { kind: "known", path: join(dataDirectory, entry.relative) },
  }));
}

function knownPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/") || trimmed.includes("\0")) return undefined;
  return trimmed;
}

function locationFromPath(value: string): HostDataMapLocation {
  const path = knownPath(value);
  return path === undefined ? { kind: "unknown" } : { kind: "known", path };
}

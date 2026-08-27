import { join } from "node:path";
import { decodeProjectId, LOCAL_HOST_DISPLAY_NAME } from "@octant/contracts";
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

const ARTIFACT_DIRECTORIES: ReadonlyArray<{ readonly name: string; readonly relative: string }> = [
  { name: "Apple toolchain artifacts", relative: "artifacts" },
];

const CACHE_DIRECTORIES: ReadonlyArray<{ readonly name: string; readonly relative: string }> = [
  { name: "Chat scratch", relative: "scratch" },
  { name: "Chat attachments", relative: "threads" },
  { name: "Work attachments", relative: "work-threads" },
  { name: "Installed extensions", relative: "extensions" },
];

const RELATED_RETENTION = {
  kind: "thread-retention" as const,
  settings: { section: "host" as const, setting: "thread-retention" },
};

const RELATED_EXPORT = {
  kind: "thread-export" as const,
  guidance: "Export a thread from that thread's menu. This map does not export or purge.",
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
  const hostCaches = namedLocations(store, CACHE_DIRECTORIES);

  return {
    host: {
      hostId: input.hostId,
      displayName:
        input.platform === "darwin" && kind === "desktop" ? LOCAL_HOST_DISPLAY_NAME : "This host",
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

/**
 * Server-authoritative read of what this host stores and where.
 *
 * Unlike host-control status, this wire is allowed to carry locations — names
 * and paths only. Secret material is unrepresentable. A category the host
 * cannot verify is `unknown`, never a guess.
 *
 * The report is read-only. Purge and export stay on their own surfaces.
 */

import { Schema } from "effect";
import { HostControlServiceMode } from "./hostControl";
import { ProjectId } from "./projects";
import { SettingsDeepLink } from "./settings";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const BoundedName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));
const BoundedPurpose = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));
const BoundedPath = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => value.startsWith("/") && !value.includes("\0")),
);

export const MAX_HOST_DATA_MAP_PROJECTS = 4_096;
export const MAX_HOST_DATA_MAP_NAMED_LOCATIONS = 16;

/** A filesystem location the host verified, or an honest unknown. */
export const HostDataMapLocation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("known"),
    path: BoundedPath,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
  }).annotations(strict),
);
export type HostDataMapLocation = typeof HostDataMapLocation.Type;

export const HostDataMapNamedLocation = Schema.Struct({
  name: BoundedName,
  location: HostDataMapLocation,
}).annotations(strict);
export type HostDataMapNamedLocation = typeof HostDataMapNamedLocation.Type;

/**
 * OS credential backends Octant actually uses. Values never appear; only the
 * Keychain or secret-service entry name does.
 */
export const HostDataMapCredentialBackend = Schema.Literal("keychain", "secret-service");
export type HostDataMapCredentialBackend = typeof HostDataMapCredentialBackend.Type;

export const HostDataMapCredentialEntry = Schema.Struct({
  service: BoundedName,
}).annotations(strict);
export type HostDataMapCredentialEntry = typeof HostDataMapCredentialEntry.Type;

export const HostDataMapCredentials = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("known"),
    backend: HostDataMapCredentialBackend,
    entries: Schema.Array(HostDataMapCredentialEntry).pipe(Schema.maxItems(32)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
  }).annotations(strict),
);
export type HostDataMapCredentials = typeof HostDataMapCredentials.Type;

export const HostDataMapOutboundCategoryId = Schema.Literal(
  "provider-calls",
  "update-checks",
  "marketplace-fetches",
);
export type HostDataMapOutboundCategoryId = typeof HostDataMapOutboundCategoryId.Type;

export const HostDataMapOutboundCategory = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("known"),
    category: HostDataMapOutboundCategoryId,
    leavesMachine: Schema.Boolean,
    purpose: BoundedPurpose,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    category: HostDataMapOutboundCategoryId,
  }).annotations(strict),
);
export type HostDataMapOutboundCategory = typeof HostDataMapOutboundCategory.Type;

export const HostDataMapHostKind = Schema.Literal("desktop", "headless");
export type HostDataMapHostKind = typeof HostDataMapHostKind.Type;

export const HostDataMapHost = Schema.Struct({
  hostId: BoundedName,
  displayName: BoundedName,
  kind: HostDataMapHostKind,
  serviceMode: HostControlServiceMode,
  journal: HostDataMapLocation,
  projections: HostDataMapLocation,
  artifacts: Schema.Array(HostDataMapNamedLocation).pipe(
    Schema.maxItems(MAX_HOST_DATA_MAP_NAMED_LOCATIONS),
  ),
  caches: Schema.Array(HostDataMapNamedLocation).pipe(
    Schema.maxItems(MAX_HOST_DATA_MAP_NAMED_LOCATIONS),
  ),
  credentials: HostDataMapCredentials,
  outbound: Schema.Array(HostDataMapOutboundCategory).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type HostDataMapHost = typeof HostDataMapHost.Type;

export const HostDataMapProjectType = Schema.Literal("chat", "work", "code");
export type HostDataMapProjectType = typeof HostDataMapProjectType.Type;

export const HostDataMapProject = Schema.Struct({
  projectId: ProjectId,
  name: BoundedName,
  type: HostDataMapProjectType,
  journal: HostDataMapLocation,
  projections: HostDataMapLocation,
  artifacts: Schema.Array(HostDataMapNamedLocation).pipe(Schema.maxItems(8)),
  caches: Schema.Array(HostDataMapNamedLocation).pipe(Schema.maxItems(8)),
  credentials: HostDataMapCredentials,
  boundRoot: Schema.optional(HostDataMapLocation),
}).annotations(strict);
export type HostDataMapProject = typeof HostDataMapProject.Type;

export const HostDataMapProjects = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("known"),
    projects: Schema.Array(HostDataMapProject).pipe(Schema.maxItems(MAX_HOST_DATA_MAP_PROJECTS)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
  }).annotations(strict),
);
export type HostDataMapProjects = typeof HostDataMapProjects.Type;

/**
 * Pointers to the existing purge and export surfaces. This map never performs
 * those operations.
 */
export const HostDataMapRelatedAction = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("thread-retention"),
    settings: SettingsDeepLink,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("thread-export"),
    guidance: BoundedPurpose,
  }).annotations(strict),
);
export type HostDataMapRelatedAction = typeof HostDataMapRelatedAction.Type;

export const HostDataMap = Schema.Struct({
  host: HostDataMapHost,
  projects: HostDataMapProjects,
  related: Schema.Array(HostDataMapRelatedAction).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type HostDataMap = typeof HostDataMap.Type;

export const decodeHostDataMap = Schema.decodeUnknownSync(HostDataMap, {
  onExcessProperty: "error",
});

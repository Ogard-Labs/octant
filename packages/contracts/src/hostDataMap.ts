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

const BoundedName = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const BoundedPurpose = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255));
const BoundedPath = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => value.startsWith("/") && !value.includes("\0")),
);

export const MAX_HOST_DATA_MAP_PROJECTS = 4_096;
export const MAX_HOST_DATA_MAP_NAMED_LOCATIONS = 24;

/** A filesystem location the host verified, or an honest unknown. */
export const HostDataMapLocation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    path: BoundedPath,
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
  }),
]);
export type HostDataMapLocation = typeof HostDataMapLocation.Type;

export const HostDataMapNamedLocation = Schema.Struct({
  name: BoundedName,
  location: HostDataMapLocation,
});
export type HostDataMapNamedLocation = typeof HostDataMapNamedLocation.Type;

/**
 * OS credential backends Octant actually uses. Values never appear; only the
 * Keychain or secret-service entry name does.
 */
export const HostDataMapCredentialBackend = Schema.Literals(["keychain", "secret-service"]);
export type HostDataMapCredentialBackend = typeof HostDataMapCredentialBackend.Type;

export const HostDataMapCredentialEntry = Schema.Struct({
  service: BoundedName,
});
export type HostDataMapCredentialEntry = typeof HostDataMapCredentialEntry.Type;

export const HostDataMapCredentials = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    backend: HostDataMapCredentialBackend,
    entries: Schema.Array(HostDataMapCredentialEntry).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
  }),
]);
export type HostDataMapCredentials = typeof HostDataMapCredentials.Type;

export const HostDataMapOutboundCategoryId = Schema.Literals([
  "provider-calls",
  "update-checks",
  "marketplace-fetches",
  "speech-model-downloads",
]);
export type HostDataMapOutboundCategoryId = typeof HostDataMapOutboundCategoryId.Type;

export const HostDataMapOutboundCategory = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    category: HostDataMapOutboundCategoryId,
    leavesMachine: Schema.Boolean,
    purpose: BoundedPurpose,
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    category: HostDataMapOutboundCategoryId,
  }),
]);
export type HostDataMapOutboundCategory = typeof HostDataMapOutboundCategory.Type;

export const HostDataMapHostKind = Schema.Literals(["desktop", "headless"]);
export type HostDataMapHostKind = typeof HostDataMapHostKind.Type;

export const HostDataMapHost = Schema.Struct({
  hostId: BoundedName,
  displayName: BoundedName,
  kind: HostDataMapHostKind,
  serviceMode: HostControlServiceMode,
  journal: HostDataMapLocation,
  projections: HostDataMapLocation,
  artifacts: Schema.Array(HostDataMapNamedLocation).check(
    Schema.isMaxLength(MAX_HOST_DATA_MAP_NAMED_LOCATIONS),
  ),
  caches: Schema.Array(HostDataMapNamedLocation).check(
    Schema.isMaxLength(MAX_HOST_DATA_MAP_NAMED_LOCATIONS),
  ),
  credentials: HostDataMapCredentials,
  outbound: Schema.Array(HostDataMapOutboundCategory).check(Schema.isMaxLength(8)),
});
export type HostDataMapHost = typeof HostDataMapHost.Type;

export const HostDataMapProjectType = Schema.Literals(["chat", "work", "code"]);
export type HostDataMapProjectType = typeof HostDataMapProjectType.Type;

export const HostDataMapProject = Schema.Struct({
  projectId: ProjectId,
  name: BoundedName,
  type: HostDataMapProjectType,
  journal: HostDataMapLocation,
  projections: HostDataMapLocation,
  artifacts: Schema.Array(HostDataMapNamedLocation).check(Schema.isMaxLength(8)),
  caches: Schema.Array(HostDataMapNamedLocation).check(Schema.isMaxLength(8)),
  credentials: HostDataMapCredentials,
  boundRoot: Schema.optional(HostDataMapLocation),
});
export type HostDataMapProject = typeof HostDataMapProject.Type;

export const HostDataMapProjects = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("known"),
    projects: Schema.Array(HostDataMapProject).check(
      Schema.isMaxLength(MAX_HOST_DATA_MAP_PROJECTS),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
  }),
]);
export type HostDataMapProjects = typeof HostDataMapProjects.Type;

/**
 * Pointers to the existing purge and export surfaces. This map never performs
 * those operations.
 */
export const HostDataMapRelatedAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread-retention"),
    settings: SettingsDeepLink,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-export"),
    guidance: BoundedPurpose,
  }),
]);
export type HostDataMapRelatedAction = typeof HostDataMapRelatedAction.Type;

export const HostDataMap = Schema.Struct({
  host: HostDataMapHost,
  projects: HostDataMapProjects,
  related: Schema.Array(HostDataMapRelatedAction).check(Schema.isMaxLength(8)),
});
export type HostDataMap = typeof HostDataMap.Type;

export const decodeHostDataMap = Schema.decodeUnknownSync(HostDataMap, {
  onExcessProperty: "error",
});

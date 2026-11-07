import { Schema } from "effect";
import { BrowserThreadId } from "./browserAutomation";
import { StoredBrowserProfile } from "./browserProfiles";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const PersistentBrowserOwnerId = Schema.UUID.pipe(Schema.brand("PersistentBrowserOwnerId"));
export type PersistentBrowserOwnerId = typeof PersistentBrowserOwnerId.Type;
export const PersistentBrowserLeaseId = Schema.UUID.pipe(Schema.brand("PersistentBrowserLeaseId"));
export type PersistentBrowserLeaseId = typeof PersistentBrowserLeaseId.Type;
const bounded = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8192));
const origin = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }),
);

/** Server-derived execution receipt; discovery and profile selection grant no authority. */
export const PersistentBrowserLeaseBinding = Schema.Struct({
  ownerId: PersistentBrowserOwnerId,
  grantId: Schema.UUID,
  executionId: bounded,
  threadId: BrowserThreadId,
  mode: Schema.Literal("work", "code"),
  projectId: ProjectId,
  providerId: bounded,
  modelId: bounded,
  authorityRevision: bounded,
  profile: StoredBrowserProfile,
  origins: Schema.Array(origin).pipe(Schema.minItems(1), Schema.maxItems(64)),
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type PersistentBrowserLeaseBinding = typeof PersistentBrowserLeaseBinding.Type;
export const decodePersistentBrowserLeaseBinding = Schema.decodeUnknownSync(
  PersistentBrowserLeaseBinding,
);

export const PersistentBrowserOwnerStatus = Schema.Union(
  Schema.Struct({ status: Schema.Literal("disabled", "unavailable") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("ready"), ownerId: PersistentBrowserOwnerId }).annotations(
    strict,
  ),
);
export type PersistentBrowserOwnerStatus = typeof PersistentBrowserOwnerStatus.Type;
export const decodePersistentBrowserOwnerStatus = Schema.decodeUnknownSync(
  PersistentBrowserOwnerStatus,
);
export const PersistentBrowserContextCreated = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("created"),
    ownerId: PersistentBrowserOwnerId,
    leaseId: PersistentBrowserLeaseId,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("unavailable") }).annotations(strict),
);
export type PersistentBrowserContextCreated = typeof PersistentBrowserContextCreated.Type;
export const decodePersistentBrowserContextCreated = Schema.decodeUnknownSync(
  PersistentBrowserContextCreated,
);

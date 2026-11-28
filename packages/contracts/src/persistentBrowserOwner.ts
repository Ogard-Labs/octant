import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { BrowserThreadId } from "./browserAutomation";
import { StoredBrowserProfile } from "./browserProfiles";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

export const PersistentBrowserOwnerId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("PersistentBrowserOwnerId"),
);
export type PersistentBrowserOwnerId = typeof PersistentBrowserOwnerId.Type;
export const PersistentBrowserLeaseId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("PersistentBrowserLeaseId"),
);
export type PersistentBrowserLeaseId = typeof PersistentBrowserLeaseId.Type;
const bounded = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(8192));
const origin = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
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
  grantId: GuidString,
  executionId: bounded,
  threadId: BrowserThreadId,
  mode: Schema.Literals(["work", "code"]),
  projectId: ProjectId,
  providerId: bounded,
  modelId: bounded,
  authorityRevision: bounded,
  profile: StoredBrowserProfile,
  origins: Schema.Array(origin).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  expiresAt: UtcTimestamp,
});
export type PersistentBrowserLeaseBinding = typeof PersistentBrowserLeaseBinding.Type;
export const decodePersistentBrowserLeaseBinding = Schema.decodeUnknownSync(
  PersistentBrowserLeaseBinding,
  STRICT_DECODE_OPTIONS,
);

export const PersistentBrowserOwnerStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["disabled", "unavailable"]) }),
  Schema.Struct({ status: Schema.Literal("ready"), ownerId: PersistentBrowserOwnerId }),
]);
export type PersistentBrowserOwnerStatus = typeof PersistentBrowserOwnerStatus.Type;
export const decodePersistentBrowserOwnerStatus = Schema.decodeUnknownSync(
  PersistentBrowserOwnerStatus,
  STRICT_DECODE_OPTIONS,
);
export const PersistentBrowserContextCreated = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("created"),
    ownerId: PersistentBrowserOwnerId,
    leaseId: PersistentBrowserLeaseId,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type PersistentBrowserContextCreated = typeof PersistentBrowserContextCreated.Type;
export const decodePersistentBrowserContextCreated = Schema.decodeUnknownSync(
  PersistentBrowserContextCreated,
  STRICT_DECODE_OPTIONS,
);

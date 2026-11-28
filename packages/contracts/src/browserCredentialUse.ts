import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { personDecides } from "./hostAnswer";
import { BrowserContextId, BrowserProfile, BrowserThreadId } from "./browserAutomation";
import { ProjectId } from "./projects";
import { WindowId } from "./shell";
import { UtcTimestamp } from "./events";

const ItemId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{26}$/i));
const AccountId = ItemId.pipe(Schema.brand("BrowserCredentialAccountId"));
const VaultId = ItemId.pipe(Schema.brand("BrowserCredentialVaultId"));
const SelectedItemId = ItemId.pipe(Schema.brand("BrowserCredentialItemId"));
const GrantId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserCredentialGrantId"),
);
const ReviewId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserCredentialReviewId"),
);
const HostSessionId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserCredentialHostSessionId"),
);
const FillPlanId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserCredentialFillPlanId"),
);
const CustodyId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("BrowserCredentialCustodyId"),
);
export const BrowserCredentialItem = Schema.Struct({
  store: Schema.Literal("onepassword"),
  accountId: AccountId,
  vaultId: VaultId,
  itemId: SelectedItemId,
});
export type BrowserCredentialItem = typeof BrowserCredentialItem.Type;

export const BrowserCredentialOrigin = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }),
);

export const BrowserCredentialMetadata = Schema.Struct({
  item: BrowserCredentialItem,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  version: PositiveInt,
  websiteOrigins: Schema.Array(BrowserCredentialOrigin).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  storeRevision: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
});
export type BrowserCredentialMetadata = typeof BrowserCredentialMetadata.Type;

export const BrowserCredentialTarget = Schema.Struct({
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
  mode: Schema.Literals(["work", "code"]),
  projectId: ProjectId,
  profile: BrowserProfile,
  topOrigin: BrowserCredentialOrigin,
  // This slice grants no iframe access. A later fill must prove that frame's identity separately.
  frame: Schema.Struct({
    kind: Schema.Literal("top"),
    origin: BrowserCredentialOrigin,
  }),
});
export type BrowserCredentialTarget = typeof BrowserCredentialTarget.Type;

export const BrowserCredentialScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    projectId: ProjectId,
    threadId: BrowserThreadId,
    contextId: BrowserContextId,
  }),
]);
export type BrowserCredentialScope = typeof BrowserCredentialScope.Type;

/** Permission for selected credential use, never a store unlock or an OAuth identity. */
export const BrowserCredentialGrant = Schema.Struct({
  kind: Schema.Literal("browser-credential-grant"),
  grantId: GrantId,
  hostSessionId: HostSessionId,
  metadata: BrowserCredentialMetadata,
  target: BrowserCredentialTarget,
  scope: BrowserCredentialScope,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
export type BrowserCredentialGrant = typeof BrowserCredentialGrant.Type;

const Context = {
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
  mode: Schema.Literals(["work", "code"]),
};
export const BrowserCredentialCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("prepare-browser-credential-fill"),
    ...Context,
    grantId: GrantId,
  }),
  Schema.Struct({
    kind: Schema.Literals([
      "confirm-browser-credential-fill",
      "cancel-browser-credential-fill",
      "submit-browser-credential-fill",
    ]),
    ...Context,
    planId: FillPlanId,
  }),
  Schema.Struct({
    kind: Schema.Literal("review-browser-credential"),
    ...Context,
    item: BrowserCredentialItem,
  }),
  Schema.Struct({
    kind: Schema.Literal("allow-browser-credential"),
    ...Context,
    reviewId: ReviewId,
    scope: Schema.Literals(["project", "task"]),
  }),
  Schema.Struct({ kind: Schema.Literal("list-browser-credential-grants"), ...Context }),
  Schema.Struct({
    kind: Schema.Literal("revoke-browser-credential"),
    ...Context,
    grantId: GrantId,
  }),
]);
export type BrowserCredentialCommand = typeof BrowserCredentialCommand.Type;

export const BrowserCredentialResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("browser-credential-fill-review"),
    planId: FillPlanId,
    grantId: GrantId,
    metadata: BrowserCredentialMetadata,
    target: BrowserCredentialTarget,
    usernameLabel: Schema.String.check(Schema.isMaxLength(128)),
    passwordLabel: Schema.String.check(Schema.isMaxLength(128)),
    submissionOrigin: BrowserCredentialOrigin,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-fill-outcome"),
    planId: FillPlanId,
    status: Schema.Literals(["filled", "authentication-required", "denied", "cancelled", "failed"]),
    effect: Schema.Literals(["none", "possible", "completed"]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-review"),
    reviewId: ReviewId,
    metadata: BrowserCredentialMetadata,
    target: BrowserCredentialTarget,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-grants"),
    grants: Schema.Array(BrowserCredentialGrant).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-refused"),
    reason: Schema.Literals([
      "unauthorized",
      "hold-required",
      "unsupported",
      "invalid-item",
      "locked",
      "missing",
      "unavailable",
      "not-linked",
      "uncertain",
      "site-mismatch",
      "stale",
      "expired",
      "cancelled",
      "journal-unavailable",
      "limit",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]).annotate(personDecides);
export type BrowserCredentialResult = typeof BrowserCredentialResult.Type;

const FillOwner = Schema.Struct({ windowId: WindowId, threadId: BrowserThreadId });
const FillContext = { contextId: BrowserContextId, owner: FillOwner, planId: FillPlanId };
export const BrowserCredentialNativeCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("prepare"),
    contextId: BrowserContextId,
    owner: FillOwner,
    origin: BrowserCredentialOrigin,
  }),
  Schema.Struct({
    kind: Schema.Literals(["validate", "cancel"]),
    ...FillContext,
  }),
  Schema.Struct({
    kind: Schema.Literal("submit"),
    ...FillContext,
    expiresAt: UtcTimestamp,
  }),
]);
export type BrowserCredentialNativeCommand = typeof BrowserCredentialNativeCommand.Type;
export const BrowserCredentialNativeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("prepared"),
    planId: FillPlanId,
    usernameLabel: Schema.String.check(Schema.isMaxLength(128)),
    passwordLabel: Schema.String.check(Schema.isMaxLength(128)),
    submissionOrigin: BrowserCredentialOrigin,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals(["stale", "unavailable", "authentication-required"]),
  }),
  Schema.Struct({ status: Schema.Literal("validated"), valid: Schema.Boolean }),
  Schema.Struct({
    status: Schema.Literals(["filled", "authentication-required", "cancelled", "failed"]),
    effect: Schema.Literals(["none", "possible", "completed"]),
  }),
]);
export type BrowserCredentialNativeResult = typeof BrowserCredentialNativeResult.Type;
export type BrowserCredentialFillPreparation = Extract<
  BrowserCredentialNativeResult,
  { readonly status: "prepared" | "refused" }
>;
export const decodeBrowserCredentialNativeCommand = Schema.decodeUnknownSync(
  BrowserCredentialNativeCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCredentialNativeResult = Schema.decodeUnknownSync(
  BrowserCredentialNativeResult,
  STRICT_DECODE_OPTIONS,
);
export const BrowserCredentialHostCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stage-browser-credential-fill"),
    ...FillContext,
    metadata: BrowserCredentialMetadata,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("commit-browser-credential-fill"),
    ...FillContext,
    custodyId: CustodyId,
  }),
  Schema.Struct({
    kind: Schema.Literal("cancel-browser-credential-fill"),
    ...FillContext,
  }),
]);
export type BrowserCredentialHostCommand = typeof BrowserCredentialHostCommand.Type;
export const BrowserCredentialHostResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), custodyId: CustodyId }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals([
      "stale",
      "unavailable",
      "locked",
      "missing",
      "uncertain",
      "not-linked",
      "invalid-item",
      "changed",
      "cancelled",
    ]),
  }),
  Schema.Struct({
    status: Schema.Literals(["filled", "authentication-required", "cancelled", "failed"]),
    effect: Schema.Literals(["none", "possible", "completed"]),
  }),
]);
export type BrowserCredentialHostResult = typeof BrowserCredentialHostResult.Type;
export const decodeBrowserCredentialHostCommand = Schema.decodeUnknownSync(
  BrowserCredentialHostCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCredentialHostResult = Schema.decodeUnknownSync(
  BrowserCredentialHostResult,
  STRICT_DECODE_OPTIONS,
);

export const BrowserCredentialJournalRecord = Schema.Union([
  Schema.Struct({
    name: Schema.Literal("browser-credential.fill-recorded"),
    grantId: GrantId,
    planId: FillPlanId,
    windowId: WindowId,
    status: Schema.Literals(["filled", "authentication-required", "denied", "cancelled", "failed"]),
    effect: Schema.Literals(["none", "possible", "completed"]),
  }),
  Schema.Struct({
    name: Schema.Literal("browser-credential.granted"),
    grant: BrowserCredentialGrant,
    windowId: WindowId,
  }),
  Schema.Struct({
    name: Schema.Literal("browser-credential.revoked"),
    grantId: GrantId,
    reason: Schema.Literals(["revoked", "expired", "changed"]),
    windowId: Schema.optional(WindowId),
  }),
]);
export type BrowserCredentialJournalRecord = typeof BrowserCredentialJournalRecord.Type;

export const decodeBrowserCredentialCommand = Schema.decodeUnknownSync(
  BrowserCredentialCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCredentialResult = Schema.decodeUnknownSync(
  BrowserCredentialResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCredentialGrant = Schema.decodeUnknownSync(
  BrowserCredentialGrant,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCredentialMetadata = Schema.decodeUnknownSync(
  BrowserCredentialMetadata,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserCredentialTarget = Schema.decodeUnknownSync(
  BrowserCredentialTarget,
  STRICT_DECODE_OPTIONS,
);

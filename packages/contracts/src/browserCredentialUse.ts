import { Schema } from "effect";
import { personDecides } from "./hostAnswer";
import { BrowserContextId, BrowserProfile, BrowserThreadId } from "./browserAutomation";
import { ProjectId } from "./projects";
import { WindowId } from "./shell";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const ItemId = Schema.String.pipe(Schema.pattern(/^[a-z0-9]{26}$/i));
const AccountId = ItemId.pipe(Schema.brand("BrowserCredentialAccountId"));
const VaultId = ItemId.pipe(Schema.brand("BrowserCredentialVaultId"));
const SelectedItemId = ItemId.pipe(Schema.brand("BrowserCredentialItemId"));
const GrantId = Schema.UUID.pipe(Schema.brand("BrowserCredentialGrantId"));
const ReviewId = Schema.UUID.pipe(Schema.brand("BrowserCredentialReviewId"));
const HostSessionId = Schema.UUID.pipe(Schema.brand("BrowserCredentialHostSessionId"));
const FillPlanId = Schema.UUID.pipe(Schema.brand("BrowserCredentialFillPlanId"));
const CustodyId = Schema.UUID.pipe(Schema.brand("BrowserCredentialCustodyId"));
export const BrowserCredentialItem = Schema.Struct({
  store: Schema.Literal("onepassword"),
  accountId: AccountId,
  vaultId: VaultId,
  itemId: SelectedItemId,
}).annotations(strict);
export type BrowserCredentialItem = typeof BrowserCredentialItem.Type;

export const BrowserCredentialOrigin = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.filter((value) => {
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
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  version: Schema.Int.pipe(Schema.positive()),
  websiteOrigins: Schema.Array(BrowserCredentialOrigin).pipe(
    Schema.minItems(1),
    Schema.maxItems(8),
  ),
  storeRevision: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
}).annotations(strict);
export type BrowserCredentialMetadata = typeof BrowserCredentialMetadata.Type;

export const BrowserCredentialTarget = Schema.Struct({
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
  mode: Schema.Literal("work", "code"),
  projectId: ProjectId,
  profile: BrowserProfile,
  topOrigin: BrowserCredentialOrigin,
  // This slice grants no iframe access. A later fill must prove that frame's identity separately.
  frame: Schema.Struct({
    kind: Schema.Literal("top"),
    origin: BrowserCredentialOrigin,
  }).annotations(strict),
}).annotations(strict);
export type BrowserCredentialTarget = typeof BrowserCredentialTarget.Type;

export const BrowserCredentialScope = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("task"),
    projectId: ProjectId,
    threadId: BrowserThreadId,
    contextId: BrowserContextId,
  }).annotations(strict),
);
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
}).annotations(strict);
export type BrowserCredentialGrant = typeof BrowserCredentialGrant.Type;

const Context = {
  contextId: BrowserContextId,
  threadId: BrowserThreadId,
  mode: Schema.Literal("work", "code"),
};
export const BrowserCredentialCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("prepare-browser-credential-fill"),
    ...Context,
    grantId: GrantId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal(
      "confirm-browser-credential-fill",
      "cancel-browser-credential-fill",
      "submit-browser-credential-fill",
    ),
    ...Context,
    planId: FillPlanId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("review-browser-credential"),
    ...Context,
    item: BrowserCredentialItem,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("allow-browser-credential"),
    ...Context,
    reviewId: ReviewId,
    scope: Schema.Literal("project", "task"),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("list-browser-credential-grants"), ...Context }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("revoke-browser-credential"),
    ...Context,
    grantId: GrantId,
  }).annotations(strict),
);
export type BrowserCredentialCommand = typeof BrowserCredentialCommand.Type;

export const BrowserCredentialResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("browser-credential-fill-review"),
    planId: FillPlanId,
    grantId: GrantId,
    metadata: BrowserCredentialMetadata,
    target: BrowserCredentialTarget,
    usernameLabel: Schema.String.pipe(Schema.maxLength(128)),
    passwordLabel: Schema.String.pipe(Schema.maxLength(128)),
    submissionOrigin: BrowserCredentialOrigin,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-fill-outcome"),
    planId: FillPlanId,
    status: Schema.Literal("filled", "authentication-required", "denied", "cancelled", "failed"),
    effect: Schema.Literal("none", "possible", "completed"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-review"),
    reviewId: ReviewId,
    metadata: BrowserCredentialMetadata,
    target: BrowserCredentialTarget,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-grants"),
    grants: Schema.Array(BrowserCredentialGrant).pipe(Schema.maxItems(64)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-credential-refused"),
    reason: Schema.Literal(
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
    ),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
).annotations(personDecides);
export type BrowserCredentialResult = typeof BrowserCredentialResult.Type;

const FillOwner = Schema.Struct({ windowId: WindowId, threadId: BrowserThreadId }).annotations(
  strict,
);
const FillContext = { contextId: BrowserContextId, owner: FillOwner, planId: FillPlanId };
export const BrowserCredentialNativeCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("prepare"),
    contextId: BrowserContextId,
    owner: FillOwner,
    origin: BrowserCredentialOrigin,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("validate", "cancel"),
    ...FillContext,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("submit"),
    ...FillContext,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
);
export type BrowserCredentialNativeCommand = typeof BrowserCredentialNativeCommand.Type;
export const BrowserCredentialNativeResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("prepared"),
    planId: FillPlanId,
    usernameLabel: Schema.String.pipe(Schema.maxLength(128)),
    passwordLabel: Schema.String.pipe(Schema.maxLength(128)),
    submissionOrigin: BrowserCredentialOrigin,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("stale", "unavailable", "authentication-required"),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("validated"), valid: Schema.Boolean }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("filled", "authentication-required", "cancelled", "failed"),
    effect: Schema.Literal("none", "possible", "completed"),
  }).annotations(strict),
);
export type BrowserCredentialNativeResult = typeof BrowserCredentialNativeResult.Type;
export type BrowserCredentialFillPreparation = Extract<
  BrowserCredentialNativeResult,
  { readonly status: "prepared" | "refused" }
>;
export const decodeBrowserCredentialNativeCommand = Schema.decodeUnknownSync(
  BrowserCredentialNativeCommand,
);
export const decodeBrowserCredentialNativeResult = Schema.decodeUnknownSync(
  BrowserCredentialNativeResult,
);
export const BrowserCredentialHostCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("stage-browser-credential-fill"),
    ...FillContext,
    metadata: BrowserCredentialMetadata,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("commit-browser-credential-fill"),
    ...FillContext,
    custodyId: CustodyId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel-browser-credential-fill"),
    ...FillContext,
  }).annotations(strict),
);
export type BrowserCredentialHostCommand = typeof BrowserCredentialHostCommand.Type;
export const BrowserCredentialHostResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("ready"), custodyId: CustodyId }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal(
      "stale",
      "unavailable",
      "locked",
      "missing",
      "uncertain",
      "not-linked",
      "invalid-item",
      "changed",
      "cancelled",
    ),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("filled", "authentication-required", "cancelled", "failed"),
    effect: Schema.Literal("none", "possible", "completed"),
  }).annotations(strict),
);
export type BrowserCredentialHostResult = typeof BrowserCredentialHostResult.Type;
export const decodeBrowserCredentialHostCommand = Schema.decodeUnknownSync(
  BrowserCredentialHostCommand,
);
export const decodeBrowserCredentialHostResult = Schema.decodeUnknownSync(
  BrowserCredentialHostResult,
);

export const BrowserCredentialJournalRecord = Schema.Union(
  Schema.Struct({
    name: Schema.Literal("browser-credential.fill-recorded"),
    grantId: GrantId,
    planId: FillPlanId,
    windowId: WindowId,
    status: Schema.Literal("filled", "authentication-required", "denied", "cancelled", "failed"),
    effect: Schema.Literal("none", "possible", "completed"),
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("browser-credential.granted"),
    grant: BrowserCredentialGrant,
    windowId: WindowId,
  }).annotations(strict),
  Schema.Struct({
    name: Schema.Literal("browser-credential.revoked"),
    grantId: GrantId,
    reason: Schema.Literal("revoked", "expired", "changed"),
    windowId: Schema.optional(WindowId),
  }).annotations(strict),
);
export type BrowserCredentialJournalRecord = typeof BrowserCredentialJournalRecord.Type;

export const decodeBrowserCredentialCommand = Schema.decodeUnknownSync(BrowserCredentialCommand);
export const decodeBrowserCredentialResult = Schema.decodeUnknownSync(BrowserCredentialResult);
export const decodeBrowserCredentialGrant = Schema.decodeUnknownSync(BrowserCredentialGrant);
export const decodeBrowserCredentialMetadata = Schema.decodeUnknownSync(BrowserCredentialMetadata);
export const decodeBrowserCredentialTarget = Schema.decodeUnknownSync(BrowserCredentialTarget);

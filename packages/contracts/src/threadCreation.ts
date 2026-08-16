import { Schema } from "effect";
import { CodeCheckoutId, CodeRepositoryId } from "./code";
import { OctantMode } from "./modes";
import { BindingRevisionId, ProjectId } from "./projects";
import {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";
import { HostId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const MAX_NEW_THREAD_DRAFT_INTENT_BYTES = 32 * 1024;

export const NewThreadDraftId = brandedUuid("NewThreadDraftId");
export type NewThreadDraftId = typeof NewThreadDraftId.Type;
export const ThreadCreationRootId = brandedUuid("ThreadCreationRootId");
export type ThreadCreationRootId = typeof ThreadCreationRootId.Type;

export const ThreadCreationAuthority = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("chat") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("work"), rootId: ThreadCreationRootId }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code"),
    bindingRevisionId: BindingRevisionId,
    repositoryId: CodeRepositoryId,
    checkoutId: CodeCheckoutId,
    executionPolicy: ProviderExecutionPolicy,
    permissionPersistence: PermissionPersistence,
  }).annotations(strict),
);
export type ThreadCreationAuthority = typeof ThreadCreationAuthority.Type;

const ThreadCreationContextFields = {
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
} as const;

export const ValidatedThreadCreationContext = Schema.Union(
  Schema.Struct({
    ...ThreadCreationContextFields,
    mode: Schema.Literal("chat"),
    projectId: Schema.NullOr(ProjectId),
    authority: Schema.Struct({ kind: Schema.Literal("chat") }).annotations(strict),
  }).annotations(strict),
  Schema.Struct({
    ...ThreadCreationContextFields,
    mode: Schema.Literal("work"),
    projectId: ProjectId,
    authority: Schema.Struct({
      kind: Schema.Literal("work"),
      rootId: ThreadCreationRootId,
    }).annotations(strict),
  }).annotations(strict),
  Schema.Struct({
    ...ThreadCreationContextFields,
    mode: Schema.Literal("code"),
    projectId: ProjectId,
    authority: Schema.Struct({
      kind: Schema.Literal("code"),
      bindingRevisionId: BindingRevisionId,
      repositoryId: CodeRepositoryId,
      checkoutId: CodeCheckoutId,
      executionPolicy: ProviderExecutionPolicy,
      permissionPersistence: PermissionPersistence,
    }).annotations(strict),
  }).annotations(strict),
);
export type ValidatedThreadCreationContext = typeof ValidatedThreadCreationContext.Type;

export const ValidatedThreadDraft = Schema.Struct({
  draftId: NewThreadDraftId,
  intent: Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= MAX_NEW_THREAD_DRAFT_INTENT_BYTES),
  ),
  context: ValidatedThreadCreationContext,
}).annotations(strict);
export type ValidatedThreadDraft = typeof ValidatedThreadDraft.Type;

export const ThreadCreationContextField = Schema.Literal(
  "host",
  "mode",
  "project",
  "provider",
  "model",
  "authority",
);
export type ThreadCreationContextField = typeof ThreadCreationContextField.Type;

export const ValidatedThreadCreationResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    draft: ValidatedThreadDraft,
    context: ValidatedThreadCreationContext,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("missing-context", "invalid-context"),
    field: ThreadCreationContextField,
    draft: ValidatedThreadDraft,
  }).annotations(strict),
);
export type ValidatedThreadCreationResult = typeof ValidatedThreadCreationResult.Type;

export const decodeValidatedThreadDraft = Schema.decodeUnknownSync(ValidatedThreadDraft);
export const decodeValidatedThreadCreationContext = Schema.decodeUnknownSync(
  ValidatedThreadCreationContext,
);
export const decodeValidatedThreadCreationResult = Schema.decodeUnknownSync(
  ValidatedThreadCreationResult,
);

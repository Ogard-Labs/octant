import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeRepositoryId } from "./code";
import { BindingRevisionId, ProjectId } from "./projects";
import {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";
import { HostId } from "./shell";

const encoder = new TextEncoder();
const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const MAX_NEW_THREAD_DRAFT_INTENT_BYTES = 32 * 1024;

export const NewThreadDraftId = brandedUuid("NewThreadDraftId");
export type NewThreadDraftId = typeof NewThreadDraftId.Type;
export const ThreadCreationRootId = brandedUuid("ThreadCreationRootId");
export type ThreadCreationRootId = typeof ThreadCreationRootId.Type;

export const ThreadCreationAuthority = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat") }),
  Schema.Struct({ kind: Schema.Literal("work"), rootId: ThreadCreationRootId }),
  Schema.Struct({
    kind: Schema.Literal("code"),
    bindingRevisionId: BindingRevisionId,
    repositoryId: CodeRepositoryId,
    checkoutId: CodeCheckoutId,
    executionPolicy: ProviderExecutionPolicy,
    permissionPersistence: PermissionPersistence,
  }),
]);
export type ThreadCreationAuthority = typeof ThreadCreationAuthority.Type;

const ThreadCreationContextFields = {
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
} as const;

export const ValidatedThreadCreationContext = Schema.Union([
  Schema.Struct({
    ...ThreadCreationContextFields,
    mode: Schema.Literal("chat"),
    projectId: Schema.NullOr(ProjectId),
    authority: Schema.Struct({ kind: Schema.Literal("chat") }),
  }),
  Schema.Struct({
    ...ThreadCreationContextFields,
    mode: Schema.Literal("work"),
    projectId: ProjectId,
    authority: Schema.Struct({
      kind: Schema.Literal("work"),
      rootId: ThreadCreationRootId,
    }),
  }),
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
    }),
  }),
]);
export type ValidatedThreadCreationContext = typeof ValidatedThreadCreationContext.Type;

export const ValidatedThreadDraft = Schema.Struct({
  draftId: NewThreadDraftId,
  intent: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter(
      (value) => encoder.encode(value).byteLength <= MAX_NEW_THREAD_DRAFT_INTENT_BYTES,
    ),
  ),
  context: ValidatedThreadCreationContext,
});
export type ValidatedThreadDraft = typeof ValidatedThreadDraft.Type;

export const ThreadCreationContextField = Schema.Literals([
  "host",
  "mode",
  "project",
  "provider",
  "model",
  "authority",
]);
export type ThreadCreationContextField = typeof ThreadCreationContextField.Type;

export const ValidatedThreadCreationResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    draft: ValidatedThreadDraft,
    context: ValidatedThreadCreationContext,
  }),
  Schema.Struct({
    kind: Schema.Literals(["missing-context", "invalid-context"]),
    field: ThreadCreationContextField,
    draft: ValidatedThreadDraft,
  }),
]);
export type ValidatedThreadCreationResult = typeof ValidatedThreadCreationResult.Type;

export const decodeValidatedThreadDraft = Schema.decodeUnknownSync(
  ValidatedThreadDraft,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidatedThreadCreationContext = Schema.decodeUnknownSync(
  ValidatedThreadCreationContext,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidatedThreadCreationResult = Schema.decodeUnknownSync(
  ValidatedThreadCreationResult,
  STRICT_DECODE_OPTIONS,
);

import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId, ProviderExecutionPolicy } from "./providers";

/**
 * The resolved creation context for a new thread draft. The server validates
 * host, mode, Project, root/worktree, provider/model, authority, and extension
 * policy before creation. The renderer carries only transient draft state.
 */
export const ThreadCreationContext = Schema.Struct({
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  modelId: Schema.optional(ProviderModelId),
  executionPolicy: Schema.optional(ProviderExecutionPolicy),
});
export type ThreadCreationContext = typeof ThreadCreationContext.Type;

/**
 * A transient draft-thread state carried by the renderer. Draft text survives
 * cancellation or creation failure without creating an implicit or
 * cross-Project thread.
 */
export const NewThreadDraft = Schema.Struct({
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  promptText: Schema.optional(Schema.String.check(Schema.isMaxLength(100_000))),
  context: Schema.optional(ThreadCreationContext),
});
export type NewThreadDraft = typeof NewThreadDraft.Type;

export const decodeThreadCreationContext = Schema.decodeUnknownSync(
  ThreadCreationContext,
  STRICT_DECODE_OPTIONS,
);
export const decodeNewThreadDraft = Schema.decodeUnknownSync(NewThreadDraft, STRICT_DECODE_OPTIONS);

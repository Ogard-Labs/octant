import { Schema } from "effect";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId, ProviderExecutionPolicy } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

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
}).annotations(strict);
export type ThreadCreationContext = typeof ThreadCreationContext.Type;

/**
 * A transient draft-thread state carried by the renderer. Draft text survives
 * cancellation or creation failure without creating an implicit or
 * cross-Project thread.
 */
export const NewThreadDraft = Schema.Struct({
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  promptText: Schema.optional(Schema.String.pipe(Schema.maxLength(100_000))),
  context: Schema.optional(ThreadCreationContext),
}).annotations(strict);
export type NewThreadDraft = typeof NewThreadDraft.Type;

export const decodeThreadCreationContext = Schema.decodeUnknownSync(ThreadCreationContext);
export const decodeNewThreadDraft = Schema.decodeUnknownSync(NewThreadDraft);

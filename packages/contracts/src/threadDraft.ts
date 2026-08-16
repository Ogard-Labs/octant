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

/** Mode-specific welcome copy and intent card descriptors. */
export interface DraftThreadModePresentation {
  readonly mode: OctantMode;
  readonly eyebrow: string;
  readonly heading: string;
  readonly description: string;
  readonly composerPlaceholder: string;
  readonly intentCards: ReadonlyArray<DraftIntentCard>;
}

export interface DraftIntentCard {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** Build mode-specific welcome presentation for the draft-thread workspace. */
export function draftThreadModePresentation(mode: OctantMode): DraftThreadModePresentation {
  switch (mode) {
    case "chat":
      return {
        mode,
        eyebrow: "Octant Chat",
        heading: "What are you working on?",
        description:
          "Start a calm, focused conversation. Keep it unfiled or place it in a virtual Project when it becomes a shared workspace.",
        composerPlaceholder: "Ask anything…",
        intentCards: [
          {
            id: "explain",
            label: "Explain a concept",
            description: "Break down a topic into clear, digestible parts.",
          },
          {
            id: "draft",
            label: "Draft text",
            description: "Write emails, summaries, or documents together.",
          },
          {
            id: "brainstorm",
            label: "Brainstorm ideas",
            description: "Explore possibilities and refine your thinking.",
          },
        ],
      };
    case "work":
      return {
        mode,
        eyebrow: "Octant Work",
        heading: "What are we working on?",
        description:
          "Start a work thread inside this confined folder. Documents, presentations, spreadsheets, reports, and artifacts stay local.",
        composerPlaceholder: "Describe the work…",
        intentCards: [
          {
            id: "document",
            label: "Create a document",
            description: "Draft, edit, and review documents in your project folder.",
          },
          {
            id: "analyze",
            label: "Analyze files",
            description: "Review spreadsheets, PDFs, or images in this project.",
          },
          {
            id: "plan",
            label: "Plan and organize",
            description: "Structure work, set milestones, and track progress.",
          },
        ],
      };
    case "code":
      return {
        mode,
        eyebrow: "Octant Code",
        heading: "What should we build?",
        description:
          "Start a Code thread in this repository. The thread inherits the current checkout and approval policy.",
        composerPlaceholder: "Describe the change…",
        intentCards: [
          {
            id: "implement",
            label: "Implement a feature",
            description: "Build new functionality with tests and review.",
          },
          {
            id: "fix",
            label: "Fix a bug",
            description: "Diagnose, reproduce, and resolve an issue.",
          },
          {
            id: "refactor",
            label: "Refactor code",
            description: "Improve structure while keeping behavior intact.",
          },
        ],
      };
  }
}

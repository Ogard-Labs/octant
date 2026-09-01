import type { ProjectId } from "@octant/contracts/projects";
import type { CodeThreadProviderChoice } from "../code/codeThreadCreate";

/**
 * What a draft that named a Project resolves to. `unresolved-selection` is its
 * own answer because an explicitly chosen Project that no longer exists is not
 * the same question as a draft that never named one.
 */
export type DraftProjectResolution<TProject> =
  | { readonly kind: "project"; readonly project: TProject | undefined }
  | { readonly kind: "unresolved-selection" };

/**
 * Resolve the Project a draft submits into.
 *
 * An explicitly chosen Project id is authoritative. When it no longer resolves
 * — archived or deleted while the draft stayed open — the draft is refused, not
 * retargeted: substituting whatever Project happens to be active would create
 * the thread, and start its first provider turn, in a repository or folder the
 * user never chose. Only a draft that named no Project at all falls back to the
 * active one.
 */
export function resolveDraftProject<TProject extends { readonly id: ProjectId }>(input: {
  readonly draftProjectId: ProjectId | undefined;
  readonly candidates: ReadonlyArray<TProject>;
  readonly activeProject: TProject | undefined;
}): DraftProjectResolution<TProject> {
  if (input.draftProjectId === undefined) {
    return { kind: "project", project: input.activeProject };
  }
  const chosen = input.candidates.find(
    (candidate) => String(candidate.id) === String(input.draftProjectId),
  );
  return chosen === undefined
    ? { kind: "unresolved-selection" }
    : { kind: "project", project: chosen };
}

/** Shown when a draft's explicitly chosen Project no longer resolves. */
export const UNRESOLVED_DRAFT_PROJECT_MESSAGE =
  "The folder this draft was started in is no longer available. Choose another folder before starting the thread.";

/**
 * Any directory can be bound as a Code Project, but a Code thread still needs a
 * repository checkout. Say what to do instead of a generic preparation error.
 */
export function checkoutNotPreparedMessage(projectName: string): string {
  return `"${projectName}" has no Git checkout. Choose another Project above, or run git init in that folder and retry.`;
}

export function resolveWorkProviderChoice(
  choices: ReadonlyArray<CodeThreadProviderChoice>,
  selectedProviderInstanceId?: CodeThreadProviderChoice["instanceId"],
  selectedModelId?: CodeThreadProviderChoice["modelId"],
): CodeThreadProviderChoice | undefined {
  return (
    choices.find(
      (choice) =>
        choice.instanceId === selectedProviderInstanceId && choice.modelId === selectedModelId,
    ) ?? choices[0]
  );
}

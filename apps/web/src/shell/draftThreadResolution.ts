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

/**
 * The model a new Work thread starts on: the one picked in the composer, then
 * Work's default from Settings, then the first available. A default the host
 * no longer offers falls through rather than starting a thread nothing serves.
 */
export function resolveWorkProviderChoice(
  choices: ReadonlyArray<CodeThreadProviderChoice>,
  selectedProviderInstanceId?: CodeThreadProviderChoice["instanceId"],
  selectedModelId?: CodeThreadProviderChoice["modelId"],
  defaults?: {
    readonly defaultProviderInstanceId?: CodeThreadProviderChoice["instanceId"] | undefined;
    readonly defaultModelId?: CodeThreadProviderChoice["modelId"] | undefined;
  },
): CodeThreadProviderChoice | undefined {
  const find = (
    instanceId: CodeThreadProviderChoice["instanceId"] | undefined,
    modelId: CodeThreadProviderChoice["modelId"] | undefined,
  ) => choices.find((choice) => choice.instanceId === instanceId && choice.modelId === modelId);
  return (
    find(selectedProviderInstanceId, selectedModelId) ??
    find(defaults?.defaultProviderInstanceId, defaults?.defaultModelId) ??
    choices[0]
  );
}

/**
 * The model a new Work thread starts on. A pick made in the Work composer
 * wins, then the Work default from Settings, then the first model. While the
 * host has not yet said what the default is there is no choice at all, so a
 * thread cannot start on a guess. A host without Work settings keeps the older
 * fallback: the shared draft choice, which Chat and Code picks also move.
 */
export function resolveWorkDraftChoice(input: {
  readonly choices: ReadonlyArray<CodeThreadProviderChoice>;
  readonly settingsStatus: "loading" | "ready" | "unsupported";
  readonly defaults?:
    | {
        readonly defaultProviderInstanceId?: CodeThreadProviderChoice["instanceId"] | undefined;
        readonly defaultModelId?: CodeThreadProviderChoice["modelId"] | undefined;
      }
    | undefined;
  readonly workSelection?: {
    readonly providerInstanceId: CodeThreadProviderChoice["instanceId"];
    readonly modelId: CodeThreadProviderChoice["modelId"];
  };
  readonly sharedSelection?: {
    readonly providerInstanceId: CodeThreadProviderChoice["instanceId"];
    readonly modelId: CodeThreadProviderChoice["modelId"];
  };
}): CodeThreadProviderChoice | undefined {
  if (input.settingsStatus === "loading") return undefined;
  const selection =
    input.workSelection ??
    (input.settingsStatus === "unsupported" ? input.sharedSelection : undefined);
  return resolveWorkProviderChoice(
    input.choices,
    selection?.providerInstanceId,
    selection?.modelId,
    input.defaults,
  );
}

/**
 * What to say when Code has nothing loaded yet.
 *
 * "Still loading" is only true while it is loading. A disconnected or refused
 * host was reporting itself as a slow one, so the user waited for something
 * that was never going to arrive; its own reason is the useful thing to show.
 */
export function codeUnavailableMessage(input: {
  readonly status: "loading" | "ready" | "disconnected" | "conflict-reload";
  readonly errorMessage?: string;
}): string {
  return input.status === "loading" || input.status === "conflict-reload"
    ? "Code is still loading on this host. Try again in a moment."
    : (input.errorMessage ?? "Code is unavailable on this host. Reconnect and try again.");
}

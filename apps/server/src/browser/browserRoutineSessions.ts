import {
  decodeToolActionAuthority,
  LOCAL_HOST_ID,
  sameToolActionAuthority,
  type CodeThread,
  type CodeCheckoutIdentity,
  type AutomationDefinition,
  type AutomationRun,
  type BrowserThreadId,
  type Project,
  type ToolActionAuthority,
  type ToolHostId,
} from "@octant/contracts";
import type { AppToolThreadLevel } from "@octant/domain";
import { deriveManagedWorktreeCheckoutId } from "../code/managedCodeThreadCreation";
import type { CurrentBrowserSessionTarget } from "./browserSessionGrants";
import { withToolFamilyHelp, type AppManagedToolSet } from "../providers/appManagedToolSet";
import { BROWSER_TOOL_DEFINITION, BROWSER_TOOL_HELP } from "./browserToolDefinition";
import { parseBrowserToolInput } from "./browserToolOperations";

/** Account delegation supplements the ordinary Private path rather than replacing it. */
export function withRoutineBrowserProfiles(input: {
  readonly privateTools: AppManagedToolSet;
  readonly profileTools: AppManagedToolSet;
}): AppManagedToolSet {
  let mode: "private" | "stored" = "private";
  let switching = false;
  let generation = 0;
  let closing: Promise<void> | undefined;
  const selected = () => (mode === "private" ? input.privateTools : input.profileTools);
  const refused = (error: string) => ({ result: { error }, isError: true });
  return withToolFamilyHelp(
    {
      definitions: input.profileTools.definitions.map((definition) => {
        if (definition.name !== BROWSER_TOOL_DEFINITION.name) return definition;
        const properties = definition.inputSchema.properties;
        return {
          ...definition,
          description:
            "Use this routine's Private Browser page with its ordinary site approval, or explicitly select a granted stored profile. Account permission grants no file transfer. Stop the current page before changing profiles.",
          inputSchema: {
            ...definition.inputSchema,
            properties: {
              ...(typeof properties === "object" &&
              properties !== null &&
              !Array.isArray(properties)
                ? properties
                : {}),
              profile: BROWSER_TOOL_DEFINITION.inputSchema.properties.profile,
            },
          },
        };
      }),
      close: () => {
        closing ??= Promise.all([input.privateTools.close?.(), input.profileTools.close?.()]).then(
          () => undefined,
        );
        return closing;
      },
      execute: async (call) => {
        if (call.name !== BROWSER_TOOL_DEFINITION.name) return refused("tool-unavailable");
        if (closing !== undefined || call.signal?.aborted) return refused("tool-interrupted");
        if (switching) return refused("browser-busy");
        const operation = parseBrowserToolInput(call.inputJson, {
          allowProfile: true,
          allowUploadPermission: true,
          allowDownloadPermission: true,
        });
        if (operation === undefined) return refused("invalid-browser-input");
        const next =
          operation.operation === "navigate" && operation.profile !== undefined
            ? operation.profile === "private"
              ? "private"
              : "stored"
            : mode;
        if (next !== mode) {
          switching = true;
          generation += 1;
          try {
            const stopped = await selected().execute({
              ...call,
              inputJson: JSON.stringify({ operation: "stop" }),
            });
            if (stopped.isError === true) return stopped;
            mode = next;
          } finally {
            switching = false;
          }
          if (closing !== undefined || call.signal?.aborted) return refused("tool-interrupted");
        }
        // A refused or expired stored-profile call keeps this path selected.
        // Falling back would return a different page under unrelated approval.
        const started = generation;
        const answer = await selected().execute(call);
        if (closing !== undefined || call.signal?.aborted || started !== generation)
          return {
            result: { error: "browser-context-changed", effect: "unknown" },
            isError: true,
          };
        return answer;
      },
    },
    BROWSER_TOOL_HELP,
  );
}

/**
 * The level a routine's Browser target reads the tool gate at. Inside a turn
 * it is the level that turn runs at. Between turns, while a person reviews
 * what the routine may open, there is no turn: a routine opted into its
 * Project's level may run at Full access, so its target is read there and
 * stays reviewable on a runtime that carries Octant's tools only at Full
 * access; every other routine runs below it, where the guarded capability
 * alone answers. Reviewing offers no tool: each turn is still judged at its
 * own level.
 */
export function routineBrowserToolLevel(
  definition: Pick<AutomationDefinition, "projectLevel">,
  turn: AppToolThreadLevel | undefined,
): AppToolThreadLevel | undefined {
  if (turn !== undefined) return turn;
  return definition.projectLevel === "opted-in" ? { executionPolicy: "full-access" } : undefined;
}

/** The reviewed recipient is a definition, never whichever thread last ran it. */
export function currentRoutineBrowserTarget(input: {
  readonly definition: AutomationDefinition;
  readonly project:
    | (Pick<Project, "id" | "type" | "lifecycle" | "version"> & {
        readonly bindingHistory?: ReadonlyArray<{ readonly revisionId: string }>;
      })
    | undefined;
  readonly toolHostId: ToolHostId;
  readonly providerEligible: boolean;
  readonly executionProfileCurrent: boolean;
}): CurrentBrowserSessionTarget | undefined {
  const { definition, project } = input;
  const binding = definition.binding;
  if (
    String(definition.hostId) !== String(LOCAL_HOST_ID) ||
    definition.mode === "chat" ||
    definition.lifecycle !== "enabled" ||
    !input.providerEligible ||
    !input.executionProfileCurrent ||
    !definition.authorityProfile.effective.tools ||
    !definition.authorityProfile.requested.tools ||
    definition.executionProfile.executionPolicy === "full-access" ||
    definition.authorityProfile.effective.executionPolicy === "full-access" ||
    definition.authorityProfile.requested.executionPolicy === "full-access" ||
    project === undefined ||
    project.lifecycle !== "active" ||
    project.type !== definition.mode ||
    project.version !== definition.projectVersion ||
    binding.kind === "chat" ||
    String(project.id) !== String(definition.projectId) ||
    String(project.bindingHistory?.at(-1)?.revisionId) !== String(binding.bindingRevisionId)
  )
    return undefined;
  const authority = decodeToolActionAuthority({
    hostId: input.toolHostId,
    mode: definition.mode,
    projectId: definition.projectId,
    providerInstanceId: definition.executionProfile.providerInstanceId,
    extension: { kind: "core" },
    rootId: binding.bindingRevisionId,
    ...(binding.kind === "code" ? { worktreeId: binding.checkoutId } : {}),
  });
  return {
    target: {
      grantee: { kind: "routine", routineId: definition.id },
      label: definition.displayName,
      modelId: definition.executionProfile.modelId,
      authority,
    },
    // Observation/version counters do not change the reviewed definition.
    revision: JSON.stringify({
      definitionRevision: definition.definitionRevision,
      binding,
      authorityProfile: definition.authorityProfile,
      executionProfile: definition.executionProfile,
    }),
  };
}

/** A dispatcher-only run reference still needs its current host-owned receipt. */
export function routineBrowserExecutionIsCurrent(input: {
  readonly run: AutomationRun | undefined;
  readonly definition: AutomationDefinition | undefined;
  readonly threadId: BrowserThreadId;
  readonly authority: ToolActionAuthority | undefined;
  readonly target: CurrentBrowserSessionTarget | undefined;
  readonly codeExecution?:
    | {
        readonly thread:
          | Pick<
              CodeThread,
              | "id"
              | "projectId"
              | "bindingRevisionId"
              | "repositoryId"
              | "checkoutId"
              | "providerInstanceId"
              | "modelId"
            >
          | undefined;
        readonly checkout: CodeCheckoutIdentity | undefined;
      }
    | undefined;
}): boolean {
  const { run, definition, target, authority } = input;
  return (
    run !== undefined &&
    definition !== undefined &&
    target !== undefined &&
    authority !== undefined &&
    run.cancellationTombstone === undefined &&
    ["dispatching", "running", "waiting"].includes(run.lifecycle) &&
    String(run.automationId) === String(definition.id) &&
    String(run.threadId) === String(input.threadId) &&
    run.definitionSnapshot.definitionRevision === definition.definitionRevision &&
    JSON.stringify(run.definitionSnapshot.executionProfile) ===
      JSON.stringify(definition.executionProfile) &&
    JSON.stringify(run.definitionSnapshot.authorityProfile) ===
      JSON.stringify(definition.authorityProfile) &&
    run.authoritySnapshot.effectiveAuthorityDigest ===
      definition.authorityProfile.effectiveAuthorityDigest &&
    JSON.stringify(run.authoritySnapshot.requested) ===
      JSON.stringify(definition.authorityProfile.requested) &&
    JSON.stringify(run.authoritySnapshot.effective) ===
      JSON.stringify(definition.authorityProfile.effective) &&
    (definition.mode === "code"
      ? codeExecutionMatches(input, authority, definition, target)
      : sameToolActionAuthority(authority, target.target.authority))
  );
}

function codeExecutionMatches(
  input: Parameters<typeof routineBrowserExecutionIsCurrent>[0],
  authority: ToolActionAuthority,
  definition: AutomationDefinition,
  target: CurrentBrowserSessionTarget,
): boolean {
  const binding = definition.binding;
  const thread = input.codeExecution?.thread;
  const checkout = input.codeExecution?.checkout;
  if (
    binding.kind !== "code" ||
    authority.mode !== "code" ||
    thread === undefined ||
    checkout === undefined
  )
    return false;
  return (
    String(thread.id) === String(input.threadId) &&
    String(thread.projectId) === String(definition.projectId) &&
    String(thread.bindingRevisionId) === String(binding.bindingRevisionId) &&
    String(thread.repositoryId) === String(binding.repositoryId) &&
    String(thread.providerInstanceId) === String(definition.executionProfile.providerInstanceId) &&
    String(thread.modelId) === String(definition.executionProfile.modelId) &&
    (definition.targetPolicy === "same-thread"
      ? String(definition.originThreadId) === String(thread.id) &&
        String(checkout.id) === String(binding.checkoutId) &&
        ["existing-worktree", "managed-worktree", "plain-folder"].includes(checkout.kind)
      : checkout.kind === "managed-worktree" &&
        String(checkout.id) ===
          String(
            deriveManagedWorktreeCheckoutId({
              repositoryId: binding.repositoryId,
              threadId: thread.id,
            }),
          )) &&
    checkout.availability === "available" &&
    String(checkout.repositoryId) === String(binding.repositoryId) &&
    String(checkout.id) === String(thread.checkoutId) &&
    String(authority.worktreeId) === String(checkout.id) &&
    sameToolActionAuthority(
      decodeToolActionAuthority({ ...authority, worktreeId: binding.checkoutId }),
      target.target.authority,
    )
  );
}

import type { PermissionMode } from "@octant/contracts/providers";
import type { ProjectSummary } from "@octant/contracts/projects";
import type { WorkAccess } from "@octant/contracts";
import { createContext, useContext } from "react";
import {
  defaultPermissionModeFor,
  defaultWorkPermissionModeFor,
  guardrailScopeOf,
  type GuardrailLevelScope,
} from "@octant/domain/guardrail-policy";
import { PERMISSION_MODE_LABEL } from "./PermissionModePicker";

/**
 * The defaults a thread's level can come from, so a thread can say whether
 * its level is the global default, its Project's, or its own. Absent outside
 * the app shell (a paired device's page), where the indicator names the level
 * alone.
 */
export interface GuardrailDefaults {
  readonly code: PermissionMode;
  readonly work: PermissionMode | undefined;
  readonly projectModes: ReadonlyMap<string, PermissionMode | undefined>;
}

/** The defaults a thread's level can come from, read from Settings and the Projects. */
export function guardrailDefaultsOf(input: {
  readonly codeSettings: Parameters<typeof defaultPermissionModeFor>[0]["settings"];
  readonly workSettings: { readonly defaultAccess: WorkAccess } | undefined;
  readonly projects: ReadonlyArray<ProjectSummary>;
}): GuardrailDefaults {
  const overrides: Array<[string, PermissionMode | undefined]> = [];
  for (const project of input.projects) {
    if (project.type === "chat") continue;
    // A Code Project that remembered Full access before Project modes existed
    // starts threads in Full access, as it always did.
    overrides.push([
      String(project.id),
      project.defaultPermissionMode ??
        (project.type === "code" && project.codeAccessPersistence === "project-default"
          ? "full-access"
          : undefined),
    ]);
  }
  return {
    code: defaultPermissionModeFor({ settings: input.codeSettings }),
    work:
      input.workSettings === undefined
        ? undefined
        : defaultWorkPermissionModeFor({ settings: input.workSettings }),
    projectModes: new Map(overrides),
  };
}

export const GuardrailDefaultsContext = createContext<GuardrailDefaults | undefined>(undefined);

const SCOPE_WORDS: Readonly<Record<GuardrailLevelScope, string>> = {
  global: "your default",
  project: "this Project",
  thread: "this thread",
};

/** Where a thread's level in force comes from, or undefined when the defaults are unknown. */
export function useGuardrailScope(input: {
  readonly surface: "code" | "work";
  readonly projectId: string;
  readonly mode: PermissionMode;
}): GuardrailLevelScope | undefined {
  const defaults = useContext(GuardrailDefaultsContext);
  const globalDefault = input.surface === "code" ? defaults?.code : defaults?.work;
  if (defaults === undefined || globalDefault === undefined) return undefined;
  return guardrailScopeOf({
    mode: input.mode,
    projectDefault: defaults.projectModes.get(input.projectId),
    globalDefault,
  });
}

/** A thread's header line: its level and where the level came from. */
export function ThreadGuardrailLevel(props: {
  readonly surface: "code" | "work";
  readonly projectId: string;
  readonly mode: PermissionMode;
  /**
   * Whether a reviewer can run for this thread. A thread stored at Auto with
   * none asks first, as the mode picker already says, so the header names
   * Ask first rather than claim a reviewer is in force.
   */
  readonly autoSupported: boolean;
}) {
  const scope = useGuardrailScope(props);
  const inForce = props.mode === "auto" && !props.autoSupported ? "ask-first" : props.mode;
  return <GuardrailLevelIndicator mode={inForce} scope={scope} />;
}

/** The level in force on a thread and the scope it came from, in the thread's header. */
export function GuardrailLevelIndicator(props: {
  readonly mode: PermissionMode;
  readonly scope?: GuardrailLevelScope | undefined;
}) {
  const label = PERMISSION_MODE_LABEL[props.mode];
  return (
    <p className="guardrail-level thread-column" data-mode={props.mode}>
      <span className="guardrail-level__mode">{label}</span>
      {props.scope === undefined ? null : (
        <span className="guardrail-level__scope"> · set by {SCOPE_WORDS[props.scope]}</span>
      )}
    </p>
  );
}

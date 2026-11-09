import type { PermissionMode } from "@octant/contracts/providers";
import type { ProjectSummary } from "@octant/contracts/projects";
import { useState } from "react";
import { useFullAccessWarning } from "../code/FullAccessWarning";
import { PERMISSION_MODE_OPTIONS } from "../code/PermissionModePicker";
import { OctantSelectField } from "../ui/base/OctantSelect";

type BoundProjectSummary = Extract<ProjectSummary, { readonly type: "code" | "work" }>;

const FOLLOW_SETTINGS = "settings";

const optionsFor = (modes: ReadonlyArray<(typeof PERMISSION_MODE_OPTIONS)[number]>) => [
  { id: FOLLOW_SETTINGS, label: "Same as Settings" },
  ...modes.map((option) => ({ id: option.id, label: option.label })),
];
const CODE_OPTIONS = optionsFor(PERMISSION_MODE_OPTIONS);
// Work shares Code's levels and has no Plan overlay.
const WORK_OPTIONS = optionsFor(PERMISSION_MODE_OPTIONS.filter((option) => option.id !== "plan"));

const SANDBOX_OPTIONS = [
  { id: FOLLOW_SETTINGS, label: "Same as Settings" },
  { id: "on", label: "Keep the sandbox" },
  { id: "off", label: "No sandbox" },
];

export interface ProjectPermissionModeSectionProps {
  readonly project: BoundProjectSummary;
  /**
   * A mode change, or a sandbox change. The sandbox argument is absent when
   * only the mode changed (the Project keeps its choice), and a choice or
   * "settings" when the person changed the sandbox.
   */
  readonly onChange: (
    mode: PermissionMode | undefined,
    fullAccessSandbox?: boolean | "settings",
  ) => Promise<boolean>;
  readonly disabled?: boolean;
}

/**
 * The Project's override of the Settings default mode. A Project that only
 * remembered Full access before modes existed reads as Full access.
 */
export function ProjectPermissionModeSection(props: ProjectPermissionModeSectionProps) {
  // Each command asserts the Project version it read, so a second pick waits
  // for the first rather than being refused as stale.
  const [pending, setPending] = useState(false);
  const warning = useFullAccessWarning({ projectId: String(props.project.id) });
  const value =
    props.project.defaultPermissionMode ??
    (props.project.type === "code" && props.project.codeAccessPersistence === "project-default"
      ? "full-access"
      : FOLLOW_SETTINGS);
  return (
    <>
      <OctantSelectField
        aria-label="Default mode for this Project"
        className="window-no-drag"
        disabled={props.disabled === true || pending}
        onValueChange={(next) => {
          const mode = PERMISSION_MODE_OPTIONS.find((option) => option.id === next)?.id;
          if (mode === undefined && next !== FOLLOW_SETTINGS) return;
          warning.guard(mode, () => {
            setPending(true);
            void props.onChange(mode).finally(() => setPending(false));
          });
        }}
        options={props.project.type === "work" ? WORK_OPTIONS : CODE_OPTIONS}
        value={value}
      />
      <span className="text-xs text-muted-foreground">Sandbox at Full access</span>
      <OctantSelectField
        aria-label="Sandbox at Full access for this Project"
        className="window-no-drag"
        disabled={props.disabled === true || pending}
        onValueChange={(next) => {
          if (next !== FOLLOW_SETTINGS && next !== "on" && next !== "off") return;
          const sandbox = next === FOLLOW_SETTINGS ? undefined : next === "on";
          if (sandbox === props.project.defaultFullAccessSandbox) return;
          setPending(true);
          // Send the mode the Project is in, not only its stored field: a
          // Project that remembered Full access before modes existed has no
          // mode of its own, and sending none reads as "follow Settings",
          // which drops that remembered Full access.
          void props
            .onChange(value === FOLLOW_SETTINGS ? undefined : value, sandbox ?? "settings")
            .finally(() => setPending(false));
        }}
        options={SANDBOX_OPTIONS}
        value={
          props.project.defaultFullAccessSandbox === undefined
            ? FOLLOW_SETTINGS
            : props.project.defaultFullAccessSandbox
              ? "on"
              : "off"
        }
      />
      {warning.dialog}
    </>
  );
}

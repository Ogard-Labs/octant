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

export interface ProjectPermissionModeSectionProps {
  readonly project: BoundProjectSummary;
  readonly onChange: (mode: PermissionMode | undefined) => Promise<boolean>;
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
      {warning.dialog}
    </>
  );
}

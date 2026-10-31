import type { PermissionMode } from "@octant/contracts/providers";
import type { ProjectSummary } from "@octant/contracts/projects";
import { useState } from "react";
import { PERMISSION_MODE_OPTIONS } from "../code/PermissionModePicker";
import { OctantSelectField } from "../ui/base/OctantSelect";

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

const FOLLOW_SETTINGS = "settings";

const OPTIONS = [
  { id: FOLLOW_SETTINGS, label: "Same as Settings" },
  ...PERMISSION_MODE_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
];

export interface ProjectPermissionModeSectionProps {
  readonly project: CodeProjectSummary;
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
  const value =
    props.project.defaultPermissionMode ??
    (props.project.codeAccessPersistence === "project-default" ? "full-access" : FOLLOW_SETTINGS);
  return (
    <OctantSelectField
      aria-label="Default mode for this Project"
      className="window-no-drag"
      disabled={props.disabled === true || pending}
      onValueChange={(next) => {
        const mode = PERMISSION_MODE_OPTIONS.find((option) => option.id === next)?.id;
        if (mode === undefined && next !== FOLLOW_SETTINGS) return;
        setPending(true);
        void props.onChange(mode).finally(() => setPending(false));
      }}
      options={OPTIONS}
      value={value}
    />
  );
}

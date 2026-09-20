import type { CodeNewThreadWorkspace } from "@octant/contracts/projects";
import { ChevronDown, FolderGit2, FolderOpen } from "lucide-react";
import { OctantMenu } from "../../ui/base/OctantMenu";

export const CODE_WORKSPACE_OPTIONS: ReadonlyArray<{
  readonly id: CodeNewThreadWorkspace;
  readonly label: string;
  readonly detail: string;
  readonly icon: typeof FolderOpen;
}> = [
  {
    id: "current-checkout",
    label: "Current checkout",
    detail: "Work against this repository's current files.",
    icon: FolderOpen,
  },
  {
    id: "managed-worktree",
    label: "Managed worktree",
    detail: "Create an isolated worktree for this thread.",
    icon: FolderGit2,
  },
];

export interface CodeWorkspaceSelectorProps {
  readonly disabled?: boolean;
  readonly onChange: (workspace: CodeNewThreadWorkspace) => void;
  readonly value: CodeNewThreadWorkspace;
}

/**
 * Where a new Code thread works: the Project's current checkout or a managed
 * worktree of its own.
 *
 * It is the shared menu, with each choice's one sentence under its label. It
 * used to be a popover of hand-built option buttons whose styles were removed
 * when the access menu beside it moved to the shared menu, so it opened as an
 * unstyled strip across the composer with label and sentence run together.
 */
export function CodeWorkspaceSelector(props: CodeWorkspaceSelectorProps) {
  const selected =
    CODE_WORKSPACE_OPTIONS.find((option) => option.id === props.value) ?? CODE_WORKSPACE_OPTIONS[0];
  const TriggerIcon = selected?.icon ?? FolderOpen;

  return (
    <OctantMenu
      items={CODE_WORKSPACE_OPTIONS.map((option) => ({
        description: option.detail,
        icon: <option.icon aria-hidden="true" size={14} strokeWidth={1.7} />,
        label: option.label,
        value: option.id,
      }))}
      onValueChange={(value) => {
        const next = CODE_WORKSPACE_OPTIONS.find((option) => option.id === value);
        if (next !== undefined) props.onChange(next.id);
      }}
      trigger={
        <>
          <TriggerIcon aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{selected?.label}</span>
          <ChevronDown aria-hidden="true" size={12} />
        </>
      }
      triggerClassName="code-composer-choice__trigger composer-tray__item"
      {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
      triggerLabel="Workspace"
      value={props.value}
    />
  );
}

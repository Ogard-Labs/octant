import type { CodeNewThreadWorkspace } from "@octant/contracts/projects";
import { ChevronDown, FolderGit2, FolderOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantPopover } from "../../ui/base/OctantPopover";

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

export function CodeWorkspaceSelector(props: CodeWorkspaceSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected =
    CODE_WORKSPACE_OPTIONS.find((option) => option.id === props.value) ?? CODE_WORKSPACE_OPTIONS[0];
  const TriggerIcon = selected?.icon ?? FolderOpen;

  return (
    <OctantPopover
      className="code-composer-choice__menu"
      onOpenChange={setOpen}
      open={open}
      title="Workspace"
      trigger={
        <>
          <TriggerIcon aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{selected?.label}</span>
          <ChevronDown aria-hidden="true" size={12} />
        </>
      }
      triggerClassName="code-composer-choice__trigger"
      triggerLabel="Workspace"
      {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
    >
      <p className="code-composer-choice__caption">Workspace</p>
      <div aria-label="Workspace" className="code-composer-choice__list" role="listbox">
        {CODE_WORKSPACE_OPTIONS.map((option) => (
          <WorkspaceOption
            icon={<option.icon aria-hidden="true" size={14} strokeWidth={1.7} />}
            key={option.id}
            label={option.label}
            detail={option.detail}
            onSelect={() => {
              props.onChange(option.id);
              setOpen(false);
            }}
            selected={option.id === props.value}
          />
        ))}
      </div>
    </OctantPopover>
  );
}

function WorkspaceOption(props: {
  readonly detail: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
  readonly selected: boolean;
}) {
  return (
    <OctantButton
      aria-selected={props.selected}
      className="code-composer-choice__option"
      onClick={props.onSelect}
      role="option"
      type="button"
      variant="ghost"
    >
      <span className="code-composer-choice__option-icon">{props.icon}</span>
      <span className="code-composer-choice__option-copy">
        <span className="code-composer-choice__option-label">{props.label}</span>
        <span className="code-composer-choice__option-detail">{props.detail}</span>
      </span>
    </OctantButton>
  );
}

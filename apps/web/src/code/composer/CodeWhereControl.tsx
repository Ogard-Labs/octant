import { DEFAULT_CODE_NEW_THREAD_WORKSPACE } from "@octant/contracts/projects";
import type { CodeNewThreadWorkspace } from "@octant/contracts/projects";
import { ChevronDown, FolderGit2, FolderOpen } from "../../ui/icons";
import { useId, useState, type ReactNode } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { MiddleEllipsis } from "../../ui/base/MiddleEllipsis";
import { OctantPopover } from "../../ui/base/OctantPopover";
import { OctantSwitch } from "../../ui/base/OctantSwitch";
import { moveWithinRadioGroup } from "../../ui/base/radioGroupKeys";

export interface CodeWhereControlProps {
  readonly workspace: CodeNewThreadWorkspace;
  readonly onWorkspaceChange: (workspace: CodeNewThreadWorkspace) => void;
  /** The branch the Project's checkout is on, or the base a new worktree starts from. */
  readonly branch: string;
  /** The branch a new worktree will be created on. */
  readonly worktreeBranch: string;
  readonly projectRoot?: string;
  /** The existing base-branch picker, drawn after "from" when a new worktree is chosen. */
  readonly baseBranchPicker?: ReactNode;
  /** The "Start from origin" choice for a new worktree, drawn under the base branch. */
  readonly sourceControl?: ReactNode;
  /** The existing working-folder fields, drawn in place as the "Subfolder" row. */
  readonly subfolder?: ReactNode;
  /** The working subfolder when it is not the whole folder, said on the chip. */
  readonly subfolderName?: string;
  /** False when the subfolder typed is one the host would refuse. */
  readonly subfolderValid?: boolean;
  /**
   * The Project's remembered new-thread workspace. Present only when this
   * surface can record it, so a surface that cannot offers no switch.
   */
  readonly remembered?: {
    readonly value: CodeNewThreadWorkspace;
    readonly onChange: (workspace: CodeNewThreadWorkspace) => void;
  };
  readonly disabled?: boolean;
}

const CHOICES: ReadonlyArray<{
  readonly id: CodeNewThreadWorkspace;
  readonly label: string;
  readonly icon: typeof FolderOpen;
}> = [
  { id: "current-checkout", label: "This checkout", icon: FolderOpen },
  { id: "managed-worktree", label: "New worktree", icon: FolderGit2 },
];

/**
 * Where a new Code thread works, as one chip and one panel. The branch, the
 * checkout choice and the working subfolder used to be three chips that each
 * answered a part of this question, and "Main folder" beside "Current
 * checkout" read as two different places. The panel only arranges the state
 * those controls already held: choosing a radio sets the same workspace the
 * old menu did, and nothing here creates a worktree. It is made when the
 * thread is created.
 */
export function CodeWhereControl(props: CodeWhereControlProps) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const worktree = props.workspace === "managed-worktree";
  const place = worktree ? props.worktreeBranch : props.branch;
  const choice = CHOICES.find((candidate) => candidate.id === props.workspace) ?? CHOICES[0];
  const subfolder =
    props.subfolderName === undefined || props.subfolderName === "." ? "" : props.subfolderName;
  const subfolderUsable = props.subfolderValid !== false;
  const label = [
    place,
    choice?.label ?? "",
    ...(subfolder === "" ? [] : [subfolder]),
    ...(subfolderUsable ? [] : ["subfolder not usable"]),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const TriggerIcon = choice?.icon ?? FolderOpen;
  const remembered = props.remembered;

  return (
    <OctantPopover
      align="start"
      className="code-where__panel"
      keepMounted
      onOpenChange={setOpen}
      open={open}
      side="top"
      titledBy={headingId}
      trigger={
        <>
          <TriggerIcon aria-hidden="true" size={12} />
          <span className="code-where__label">{label}</span>
          <ChevronDown aria-hidden="true" size={12} />
        </>
      }
      triggerClassName="composer-tray__item code-where__trigger"
      {...(props.disabled === true ? { triggerDisabled: true } : {})}
      {...(subfolderUsable ? {} : { triggerDataAttributes: { "data-invalid": true } })}
      triggerLabel={`Where this thread works: ${label}`}
    >
      <h3 className="oct-nav-group code-where__title" id={headingId}>
        Where should this thread work?
      </h3>
      <div
        aria-labelledby={headingId}
        className="code-where__choices"
        onKeyDown={moveWithinRadioGroup}
        role="radiogroup"
      >
        {CHOICES.map((candidate) => {
          const selected = candidate.id === props.workspace;
          return (
            <OctantButton
              aria-checked={selected}
              className="code-where__radio"
              key={candidate.id}
              onClick={() => props.onWorkspaceChange(candidate.id)}
              role="radio"
              tabIndex={selected ? 0 : -1}
              type="button"
              variant="bare"
            >
              <span aria-hidden="true" className="code-where__dot" />
              <span className="oct-menu-option code-where__name">{candidate.label}</span>
              {candidate.id === "current-checkout" ? (
                props.projectRoot === undefined ? (
                  <span className="oct-menu-detail code-where__meta">{`on ${props.branch}`}</span>
                ) : (
                  <MiddleEllipsis
                    className="oct-menu-detail code-where__meta"
                    suffix={` · on ${props.branch}`}
                    text={props.projectRoot}
                  />
                )
              ) : (
                <span className="oct-menu-detail code-where__meta">
                  isolated copy, its own branch
                </span>
              )}
            </OctantButton>
          );
        })}
      </div>
      {/* The rows a new worktree adds are always laid out. Choosing "This
          checkout" quiets and disables them instead of removing them, so the
          panel is the same size in both states and nothing moves. */}
      <div
        className="code-where__detail"
        data-quiet={worktree ? undefined : "true"}
        data-reserved=""
        inert={!worktree}
      >
        <div className="code-where__line" data-reserved="">
          <span className="oct-menu-detail code-where__line-label">from</span>
          {props.baseBranchPicker}
        </div>
        <div className="code-where__line" data-reserved="">
          <span className="oct-menu-detail code-where__line-label">branch</span>
          <MiddleEllipsis className="code-where__code" text={props.worktreeBranch} />
          <span className="oct-menu-detail">(auto)</span>
        </div>
        {props.sourceControl}
      </div>
      {props.subfolder === undefined ? null : (
        <div className="code-where__subfolder" data-reserved="">
          {props.subfolder}
        </div>
      )}
      {remembered === undefined ? null : (
        <div className="code-where__remember" data-reserved="">
          <span className="oct-menu-option">Remember for this Project</span>
          <OctantSwitch
            checked={remembered.value === props.workspace}
            disabled={remembered.value === props.workspace && !worktree}
            disabledReason="This is already what a new thread starts with."
            label="Remember for this Project"
            onCheckedChange={(on) =>
              remembered.onChange(on ? props.workspace : DEFAULT_CODE_NEW_THREAD_WORKSPACE)
            }
          />
        </div>
      )}
    </OctantPopover>
  );
}

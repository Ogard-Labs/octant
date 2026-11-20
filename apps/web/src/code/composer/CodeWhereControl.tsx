import { DEFAULT_CODE_NEW_THREAD_WORKSPACE } from "@octant/contracts/projects";
import type { CodeNewThreadWorkspace } from "@octant/contracts/projects";
import { Check, ChevronDown, ChevronRight, GitBranch, GitFork } from "../../ui/icons";
import { useId, useRef, useState, type ReactNode } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import { OctantPopover } from "../../ui/base/OctantPopover";
import { moveWithinRadioGroup } from "../../ui/base/radioGroupKeys";

export interface CodeWhereControlProps {
  /** Opens the menu on first draw — the Environment's branch-switching entry. */
  readonly startOpen?: boolean;
  readonly workspace: CodeNewThreadWorkspace;
  readonly onWorkspaceChange: (workspace: CodeNewThreadWorkspace) => void;
  /** The branch the Project's checkout is on, or the base a new worktree starts from. */
  readonly branch: string;
  /** The branch a new worktree will be created on. */
  readonly worktreeBranch: string;
  readonly projectRoot?: string;
  /**
   * The base-branch picker, drawn as the menu's "Start from" row
   * (`CodeBranchSelector` with `presentation="row"`).
   */
  readonly baseBranchPicker?: ReactNode;
  /** The worktree's source settings, shown in the Worktree options dialog. */
  readonly sourceControl?: ReactNode;
  /** The working-folder fields, shown in the Subfolder pop-out. */
  readonly subfolder?: ReactNode;
  /** The working subfolder when it is not the whole folder, said on the chip. */
  readonly subfolderName?: string;
  /** False when the subfolder typed is one the host would refuse. */
  readonly subfolderValid?: boolean;
  /**
   * The Project's remembered new-thread workspace. Present only when this
   * surface can record it, so a surface that cannot offers no row.
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
}> = [
  { id: "current-checkout", label: "This checkout" },
  { id: "managed-worktree", label: "New worktree" },
];

/**
 * Where a new Code thread works, as one quiet chip and a plain menu: the
 * choice between this checkout and a new worktree, the branch it starts from,
 * the subfolder, and whether the Project remembers the choice. A tall form of
 * switches, fields and notes made the most common question (which branch?)
 * the hardest to see (maintainer request, 2026-11-17). The settings a person
 * rarely changes (where a worktree is fetched from, its branch name) and the
 * subfolder field open as small dialogs from their rows. Nothing here creates
 * a worktree; that happens when the thread is created.
 */
export function CodeWhereControl(props: CodeWhereControlProps) {
  const [open, setOpen] = useState(props.startOpen === true);
  const [dialog, setDialog] = useState<"worktree" | undefined>(undefined);
  const [subfolderOpen, setSubfolderOpen] = useState(false);
  const headingId = useId();
  const worktree = props.workspace === "managed-worktree";
  const subfolder =
    props.subfolderName === undefined || props.subfolderName === "." ? "" : props.subfolderName;
  const subfolderUsable = props.subfolderValid !== false;
  const place = worktree ? `New worktree · from ${props.branch}` : props.branch;
  const label = [
    place,
    ...(subfolder === "" ? [] : [subfolder]),
    ...(subfolderUsable ? [] : ["subfolder not usable"]),
  ].join(" · ");
  const TriggerIcon = worktree ? GitFork : GitBranch;
  const remembered = props.remembered;
  const chip = useRef<HTMLSpanElement>(null);
  // The dialog opens from a row in this menu, and the menu closes as it
  // opens, so the row cannot take focus back: the chip does (review finding,
  // 2026-11-17: focus was left on the page's body).
  const chipButton = useRef<HTMLElement | null>(null);
  const rememberedHere = remembered !== undefined && remembered.value === props.workspace;
  const openDialog = (which: "worktree") => {
    chipButton.current = chip.current?.closest("button") ?? null;
    setOpen(false);
    setDialog(which);
  };

  return (
    <>
      <OctantPopover
        align="start"
        className="code-where__panel"
        keepMounted
        onOpenChange={setOpen}
        open={open}
        side="top"
        titledBy={headingId}
        trigger={
          <span className="code-where__chip" ref={chip}>
            <TriggerIcon aria-hidden="true" size={14} />
            <span className="code-where__label">{label}</span>
            <ChevronDown aria-hidden="true" className="code-where__chevron" size={12} />
          </span>
        }
        triggerClassName="composer-tray__item code-where__trigger"
        triggerVariant="ghost"
        {...(props.disabled === true ? { triggerDisabled: true } : {})}
        {...(subfolderUsable ? {} : { triggerDataAttributes: { "data-invalid": true } })}
        triggerLabel={`Where this thread works: ${label}`}
      >
        <p className="code-where__caption" id={headingId}>
          Where this thread works
        </p>
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
                className="code-where__row code-where__row--radio"
                key={candidate.id}
                onClick={() => props.onWorkspaceChange(candidate.id)}
                role="radio"
                tabIndex={selected ? 0 : -1}
                {...(candidate.id === "current-checkout" && props.projectRoot !== undefined
                  ? { title: props.projectRoot }
                  : {})}
                type="button"
                variant="bare"
              >
                <span className="code-where__row-name">
                  <span aria-hidden="true" className="code-where__dot" />
                  {candidate.label}
                </span>
                <span className="code-where__row-value">
                  {candidate.id === "current-checkout" ? `on ${props.branch}` : "own branch"}
                </span>
              </OctantButton>
            );
          })}
        </div>
        <div aria-hidden="true" className="code-where__separator" />
        {/* The branch row is the same row in both states: a new worktree
            chooses where it starts, this checkout says the branch it is on,
            so the menu keeps its size and nothing moves when the choice
            changes. */}
        {worktree && props.baseBranchPicker !== undefined ? (
          props.baseBranchPicker
        ) : (
          <div className="code-where__row code-where__row--fact">
            <span className="code-where__row-name">Branch</span>
            <span className="code-where__row-value">{props.branch}</span>
          </div>
        )}
        {props.subfolder === undefined ? null : (
          // A pop-out beside its row, like Start from, that stays mounted:
          // a subfolder the host refuses keeps what was typed when the
          // pop-out closes and opens again.
          <OctantPopover
            align="start"
            className="code-where__subfolder"
            keepMounted
            onOpenChange={setSubfolderOpen}
            open={subfolderOpen}
            side="inline-end"
            title="Working subfolder"
            trigger={
              <>
                <span className="code-where__row-name">Subfolder</span>
                <span className="code-where__row-value">
                  <span className="code-where__row-value-text">
                    {subfolderUsable ? subfolder || "Whole folder" : "Not usable"}
                  </span>
                  <ChevronRight aria-hidden="true" size={12} />
                </span>
              </>
            }
            triggerClassName="code-where__row code-where__row--action"
            {...(subfolderUsable ? {} : { triggerDataAttributes: { "data-invalid": true } })}
            triggerLabel={`Subfolder: ${subfolderUsable ? subfolder || "Whole folder" : "Not usable"}`}
          >
            {props.subfolder}
          </OctantPopover>
        )}
        <div aria-hidden="true" className="code-where__separator" />
        {remembered === undefined ? null : (
          <OctantButton
            aria-checked={rememberedHere}
            // Remembering the default again would change nothing, so the
            // row says so instead of offering a press that does nothing.
            disabled={rememberedHere && !worktree}
            className="code-where__row code-where__row--check"
            onClick={() =>
              remembered.onChange(
                rememberedHere ? DEFAULT_CODE_NEW_THREAD_WORKSPACE : props.workspace,
              )
            }
            role="checkbox"
            {...(rememberedHere && !worktree
              ? { title: "This is already what a new thread starts with." }
              : {})}
            type="button"
            variant="bare"
          >
            <span className="code-where__row-name">
              <span aria-hidden="true" className="code-where__tick">
                {rememberedHere ? <Check size={14} /> : null}
              </span>
              Remember for this Project
            </span>
          </OctantButton>
        )}
        {props.sourceControl === undefined || props.sourceControl === null ? null : (
          <OctantButton
            className="code-where__row code-where__row--action"
            disabled={!worktree}
            onClick={() => openDialog("worktree")}
            {...(worktree ? {} : { title: "Choose New worktree first." })}
            type="button"
            variant="bare"
          >
            <span className="code-where__row-name">
              <span aria-hidden="true" className="code-where__tick" />
              Worktree options…
            </span>
          </OctantButton>
        )}
      </OctantPopover>
      <OctantDialog
        className="code-where-dialog"
        label="Worktree options"
        onClose={() => setDialog(undefined)}
        open={dialog === "worktree"}
        restoreFocus={chipButton}
      >
        <h2 className="code-where-dialog__title">Worktree options</h2>
        <p className="code-where-dialog__lead">
          The new worktree gets its own branch, <code>{props.worktreeBranch}</code>, made from{" "}
          {props.branch}.
        </p>
        <div className="code-where-dialog__body">{props.sourceControl}</div>
        <div className="code-where-dialog__actions">
          <OctantButton onClick={() => setDialog(undefined)} type="button">
            Done
          </OctantButton>
        </div>
      </OctantDialog>
    </>
  );
}

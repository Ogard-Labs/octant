import type { ProjectAction } from "@octant/contracts/projects";
import { ChevronDown, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantMenuIconSlot } from "../ui/base/OctantMenuIconSlot";
import {
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
  OctantMenuTrigger,
} from "../ui/base/OctantMenu";

/** How many actions sit in the header before the rest move into a menu. */
const INLINE_ACTIONS = 3;

export interface ProjectActionButtonsProps {
  readonly onSetup?: () => void;
  readonly actions: ReadonlyArray<ProjectAction>;
  /** The Project's main folder and its extra folders; a choice is offered only with an extra one. */
  readonly mainFolder?: string;
  readonly defaultFolderLabel?: string;
  readonly extraFolders?: ReadonlyArray<string>;
  /** `folder` is the extra folder the person chose; absent runs in the main folder. */
  readonly onRun: (action: ProjectAction, folder?: string) => void;
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/**
 * The Code Project's saved actions in the window header: up to three as
 * one-press buttons, the rest in one menu with where they run. Each one
 * opens the host-resolved preview before a dedicated run; the host decides
 * which checkout and authority may run the saved line. Drawn into the header's own slot, and
 * nowhere when that slot is not on screen.
 */
export function ProjectActionButtons(props: ProjectActionButtonsProps) {
  const [host, setHost] = useState<Element | null>(() =>
    typeof document === "undefined"
      ? null
      : document.querySelector("[data-octant-project-actions]"),
  );
  useEffect(() => {
    setHost(document.querySelector("[data-octant-project-actions]"));
  }, []);
  const extras = props.extraFolders ?? [];
  const [chosen, setChosen] = useState<string>("");
  // A removed folder falls back to the main one rather than staying chosen.
  const folder =
    extras.includes(chosen) ||
    (props.defaultFolderLabel !== undefined && chosen === props.mainFolder)
      ? chosen
      : "";
  const run = (action: ProjectAction) =>
    folder === "" ? props.onRun(action) : props.onRun(action, folder);
  if (host === null || (props.actions.length === 0 && props.onSetup === undefined)) return null;
  const inline = props.actions.slice(0, INLINE_ACTIONS);
  const rest = props.actions.slice(INLINE_ACTIONS);
  const folderChoices: ReadonlyArray<{ readonly label: string; readonly value: string }> =
    // Where to run is a choice about the buttons beside it, so it is offered
    // only when there is something to run. With no saved action the header
    // used to read "Run in: Active checkout" next to nothing.
    props.actions.length === 0 || (extras.length === 0 && props.defaultFolderLabel === undefined)
      ? []
      : [
          ...(props.defaultFolderLabel === undefined
            ? [{ label: `${folderName(props.mainFolder ?? "")} (main)`, value: "" }]
            : [
                { label: props.defaultFolderLabel, value: "" },
                ...(props.mainFolder === undefined
                  ? []
                  : [
                      {
                        label: `${folderName(props.mainFolder)} (Project folder)`,
                        value: props.mainFolder,
                      },
                    ]),
              ]),
          ...extras.map((path) => ({ label: folderName(path), value: path })),
        ];
  const onSetup = props.onSetup;
  // One menu holds everything that is not a one-press run: the actions past
  // the third, where they run, and the task's worktree setup. Each used to be
  // its own text control in the window's title bar.
  const inMenu = rest.length > 0 || folderChoices.length > 0;
  return createPortal(
    <div
      aria-label="Project actions"
      className="project-action-buttons window-no-drag"
      role="group"
    >
      {inline.map((action) => (
        <OctantButton
          key={String(action.id)}
          onClick={() => run(action)}
          size="sm"
          title={action.command}
          type="button"
          variant="ghost"
        >
          <Play aria-hidden="true" size={12} />
          {action.name}
        </OctantButton>
      ))}
      {inMenu ? (
        <OctantMenuRoot>
          <OctantMenuTrigger
            aria-label="More Project actions"
            render={<OctantButton size="sm" variant="ghost" />}
          >
            <span>More</span>
            <ChevronDown aria-hidden="true" size={12} />
          </OctantMenuTrigger>
          <OctantMenuPortal>
            <OctantMenuPositioner align="end">
              <OctantMenuPopup>
                {rest.map((action) => (
                  <OctantMenuItem
                    key={String(action.id)}
                    onClick={() => run(action)}
                    title={action.command}
                  >
                    <Play aria-hidden="true" size={12} />
                    {action.name}
                  </OctantMenuItem>
                ))}
                {folderChoices.length === 0 ? null : (
                  <>
                    {rest.length === 0 ? null : <OctantMenuSeparator />}
                    <OctantMenuGroup>
                      <OctantMenuGroupLabel>Run in</OctantMenuGroupLabel>
                      <OctantMenuRadioGroup onValueChange={setChosen} value={folder}>
                        {folderChoices.map((choice) => (
                          <OctantMenuRadioItem key={choice.value} value={choice.value}>
                            {rest.length === 0 ? null : <OctantMenuIconSlot />}
                            {choice.label}
                          </OctantMenuRadioItem>
                        ))}
                      </OctantMenuRadioGroup>
                    </OctantMenuGroup>
                  </>
                )}
                {onSetup === undefined ? null : (
                  <>
                    <OctantMenuSeparator />
                    <OctantMenuItem onClick={onSetup}>
                      {rest.length === 0 ? null : <OctantMenuIconSlot />}
                      Worktrees…
                    </OctantMenuItem>
                  </>
                )}
              </OctantMenuPopup>
            </OctantMenuPositioner>
          </OctantMenuPortal>
        </OctantMenuRoot>
      ) : onSetup === undefined ? null : (
        <OctantButton onClick={onSetup} size="sm" type="button" variant="ghost">
          Worktrees
        </OctantButton>
      )}
    </div>,
    host,
  );
}

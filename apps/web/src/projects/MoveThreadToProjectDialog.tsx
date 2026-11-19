import type { ProjectSummary } from "@octant/contracts/projects";
import type { ProviderInstance, ProviderModel } from "@octant/contracts/providers";
import { isProviderAllowedByProjectPolicy } from "@octant/domain/project-provider-policy";
import {
  THREAD_MOVE_REFUSALS,
  decideThreadMove,
  folderContains,
  type MovableThreadMode,
} from "@octant/domain/thread-project-move-policy";
import { useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { moveWithinRadioGroup } from "../ui/base/radioGroupKeys";
import { Folder } from "../ui/icons";
import { ProjectIcon } from "./ProjectIcon";

export type MoveThreadOutcome =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "cancelled" }
  | {
      readonly status: "deferred";
      /** The real move's answer once the source turn settles and it dispatches. */
      readonly settled: Promise<MoveThreadOutcome>;
      /** Drops the queued intent so it never dispatches. */
      readonly cancel: () => void;
    };

export interface MoveThreadToProjectDialogProps {
  readonly mode: MovableThreadMode;
  readonly threadTitle: string;
  /** The Project the thread is in now. */
  readonly currentProjectId: string;
  /**
   * A turn is still occupying the thread: the dialog offers Move after this
   * turn (the default) against an explicit Stop and move now, and the host
   * still revalidates when the queued move dispatches.
   */
  readonly busy?: boolean;
  /** Every Project the window knows; the dialog picks the ones this thread may join. */
  readonly projects: ReadonlyArray<ProjectSummary>;
  /**
   * The thread's actual provider and model, when the surface that opened the
   * dialog knew them: a destination whose policy refuses either shows the
   * reason instead of offering a move the host would deny.
   */
  readonly threadProvider?: ProviderInstance | undefined;
  readonly threadModel?: ProviderModel | undefined;
  /**
   * The thread's approved working folder, when it has one: the host refuses
   * every move to a different Project then, so each destination shows that
   * reason rather than a dead choice.
   */
  readonly threadWorkingFolderId?: string | undefined;
  /**
   * The thread's checkout kind and availability, when its view knew them: a
   * remote-root or unavailable checkout plainly cannot move, and shows the
   * host's refusal up front. A plain folder alone is no refusal.
   */
  readonly threadCheckoutKind?: string | undefined;
  readonly threadCheckoutAvailability?: "available" | "unavailable" | "waiting" | undefined;
  readonly onMove: (
    projectId: string,
    when?: "after-turn" | "stop-now",
  ) => Promise<MoveThreadOutcome>;
  readonly onClose: () => void;
}

const CODE_SAME_FOLDER =
  "A Code thread can only move to a Project bound to the same repository folder.";
const WORKING_FOLDER_BOUND =
  "This task's working folder is bound to its current Project. Start a new task in the destination Project.";
const CHECKOUT_UNAVAILABLE = "Code thread checkout is unavailable.";

const KIND: Record<MovableThreadMode, { readonly noun: string; readonly project: string }> = {
  work: { noun: "task", project: "Work Project" },
  code: { noun: "thread", project: "Code Project" },
};

/**
 * Files a Work or Code thread into another Project of the same kind. The host
 * decides and refuses with a reason; the dialog applies the same rule to grey
 * out a Project the host would refuse, and names the reason beside it, so the
 * choice never reads as a dead button.
 */
export function MoveThreadToProjectDialog(props: MoveThreadToProjectDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const whenId = useId();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [when, setWhen] = useState<"after-turn" | "stop-now">("after-turn");
  const [pending, setPending] = useState<
    Extract<MoveThreadOutcome, { readonly status: "deferred" }> | undefined
  >(undefined);
  const kind = KIND[props.mode];

  const bound = (project: ProjectSummary) =>
    project.type === "chat" ? undefined : project.binding.canonicalRoot;
  const current = props.projects.find((project) => String(project.id) === props.currentProjectId);
  const currentFolder = current === undefined ? undefined : bound(current);

  const candidates = props.projects.filter(
    (project) =>
      project.type === props.mode &&
      project.lifecycle === "active" &&
      String(project.id) !== props.currentProjectId,
  );

  function reasonFor(project: ProjectSummary): string | undefined {
    const folder = bound(project);
    if (folder === undefined || currentFolder === undefined) {
      return THREAD_MOVE_REFUSALS["destination-unavailable"];
    }
    // The host refuses any move once the thread is bound to a working folder,
    // whatever the destination — the same string it answers with.
    if (props.threadWorkingFolderId !== undefined) return WORKING_FOLDER_BOUND;
    if (
      props.mode === "code" &&
      (props.threadCheckoutKind === "remote-root" ||
        props.threadCheckoutAvailability === "unavailable")
    ) {
      return CHECKOUT_UNAVAILABLE;
    }
    const decision = decideThreadMove({
      thread: { lifecycle: "active", executing: false, awaitingInput: false },
      source: { id: props.currentProjectId, mode: props.mode, folder: currentFolder },
      destination: {
        id: String(project.id),
        mode: project.type,
        lifecycle: project.lifecycle,
        folder,
      },
    });
    if (decision.status === "refused") return THREAD_MOVE_REFUSALS[decision.reason];
    if (props.mode === "code" && !folderContains(currentFolder, folder)) return CODE_SAME_FOLDER;
    if (
      props.threadProvider !== undefined &&
      project.type !== "chat" &&
      !isProviderAllowedByProjectPolicy(project, props.threadProvider, props.threadModel)
    ) {
      // A refusal against an unknown model may only be missing data, not a
      // policy the thread actually breaks — say which it is.
      if (props.threadModel === undefined) {
        return "This thread's model is not known here; the host decides whether this Project's provider policy allows it.";
      }
      return "This Project's provider policy does not allow this thread's provider or model.";
    }
    return undefined;
  }

  // Every way the dialog goes away while a move is queued — Cancel move, the
  // footer button, Escape, the backdrop — drops that same queued request, so
  // a move the person dismissed never dispatches silently behind the dialog.
  function dismiss(): void {
    pending?.cancel();
    props.onClose();
  }

  async function move(projectId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const outcome =
        props.busy === true ? await props.onMove(projectId, when) : await props.onMove(projectId);
      if (outcome.status === "ok") props.onClose();
      else if (outcome.status === "cancelled") props.onClose();
      else if (outcome.status === "deferred") {
        setPending(outcome);
        void outcome.settled.then((settled) => {
          setPending(undefined);
          if (settled.status === "ok" || settled.status === "cancelled") props.onClose();
          else if (settled.status === "refused") setRefusal(settled.message);
        });
      } else setRefusal(outcome.message);
    } catch {
      setRefusal("The thread could not be moved. Nothing changed; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OctantDialog
      className="project-dialog"
      describedBy={descriptionId}
      label="Move to Project"
      labelledBy={titleId}
      onClose={() => {
        if (!busy) dismiss();
      }}
      open
      popupId="move-thread-to-project-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Move to Project</h1>
      </div>
      <p id={descriptionId}>
        &ldquo;{props.threadTitle}&rdquo; keeps its history and its access level, and stays a{" "}
        {props.mode === "work" ? "Work task" : "Code thread"}.{" "}
        {props.mode === "work"
          ? "It can move to another Work Project whose folder is the same as, or contains, its folder."
          : "It can move to another Code Project with the same repository folder."}
      </p>
      {props.busy === true ? (
        pending === undefined ? (
          <fieldset className="move-thread__when" disabled={busy}>
            <legend id={whenId}>This {kind.noun} is still working</legend>
            <div
              aria-labelledby={whenId}
              className="move-thread__when-choices"
              onKeyDown={moveWithinRadioGroup}
              role="radiogroup"
            >
              {(
                [
                  { id: "after-turn", label: "Move after this turn" },
                  { id: "stop-now", label: "Stop and move now" },
                ] as const
              ).map((choice) => (
                <OctantButton
                  aria-checked={when === choice.id}
                  className="move-thread__when-choice"
                  key={choice.id}
                  onClick={() => setWhen(choice.id)}
                  role="radio"
                  tabIndex={when === choice.id ? 0 : -1}
                  type="button"
                  variant="bare"
                >
                  <span aria-hidden="true" className="code-where__dot" />
                  {choice.label}
                </OctantButton>
              ))}
            </div>
          </fieldset>
        ) : (
          <p>The move is queued for when this turn finishes.</p>
        )
      ) : null}
      {candidates.length === 0 ? (
        <p>
          {current === undefined
            ? `There is no other ${kind.project} to move this ${kind.noun} into.`
            : `This thread belongs to “${current.name}”. There is no other ${kind.project} to move this ${kind.noun} into.`}
        </p>
      ) : (
        <ul aria-label={`${kind.project}s`} className="move-thread__list">
          {candidates.map((project) => {
            const reason = reasonFor(project);
            const reasonId = `${descriptionId}-${String(project.id)}`;
            return (
              <li key={String(project.id)}>
                <OctantButton
                  aria-describedby={reason === undefined ? undefined : reasonId}
                  className="move-thread__choice"
                  disabled={busy || pending !== undefined || reason !== undefined}
                  onClick={() => void move(String(project.id))}
                  type="button"
                  variant="outline"
                >
                  <span className="move-thread__title">
                    <ProjectIcon
                      fallback={<Folder aria-hidden="true" size={16} />}
                      projectId={String(project.id)}
                      size={16}
                    />
                    <span className="move-thread__name">{project.name}</span>
                  </span>
                  <span className="move-thread__folder">{bound(project)}</span>
                </OctantButton>
                {reason === undefined ? null : (
                  <span className="move-thread__reason" id={reasonId}>
                    {reason}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {refusal === undefined ? null : <OctantAlert tone="danger">{refusal}</OctantAlert>}
      <div className="project-dialog__actions">
        <OctantButton disabled={busy} onClick={dismiss} type="button" variant="outline">
          {pending === undefined ? "Cancel" : "Cancel move"}
        </OctantButton>
      </div>
    </OctantDialog>
  );
}

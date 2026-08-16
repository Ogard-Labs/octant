import type { ProjectSummary } from "@octant/contracts/projects";
import type { RootlessThreadSummary, RootlessTurnState } from "@octant/contracts/rootless-thread";
import { AlertCircle, CheckCircle, FolderPlus, LoaderCircle, LockKeyhole } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface RootlessThreadWorkspaceProps {
  readonly thread: RootlessThreadSummary;
  readonly projects?: ReadonlyArray<ProjectSummary>;
  readonly onAttachFolder?: (thread: RootlessThreadSummary) => void;
}

function projectName(
  projects: ReadonlyArray<ProjectSummary> | undefined,
  projectId: string,
): string {
  return (
    projects?.find((candidate) => String(candidate.id) === String(projectId))?.name ?? projectId
  );
}

function turnStatusLabel(turn: RootlessTurnState): string {
  switch (turn.status) {
    case "accepted":
      return "Starting";
    case "running":
      return "Working";
    case "completed":
      return "Completed";
    case "waiting":
      return "Waiting";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}

function turnReply(turn: RootlessTurnState): string {
  const response = turn.response?.trim();
  if (response !== undefined && response !== "") return response;
  if (turn.failure !== undefined) return turn.failure.message;
  switch (turn.status) {
    case "accepted":
    case "running":
      return "Octant is working on this request…";
    case "waiting":
      return "This turn is waiting for approval or additional input.";
    case "cancelled":
      return "This turn was cancelled.";
    case "failed":
      return "The provider could not complete this turn.";
    case "completed":
      return "The provider completed without a visible reply.";
  }
}

export function RootlessThreadWorkspace(props: RootlessThreadWorkspaceProps) {
  const modeLabel = props.thread.mode === "code" ? "Code" : "Work";
  const isProjectBacked = props.thread.workspaceKind === "project-backed";
  const projectId = props.thread.projectId;
  const boundName = projectId === undefined ? undefined : projectName(props.projects, projectId);
  const turn = props.thread.initialTurn;
  const turnPending = turn?.status === "accepted" || turn?.status === "running";
  return (
    <section aria-label={`Rootless ${modeLabel} thread`} className="rootless-thread-workspace">
      <header className="rootless-thread-workspace__header">
        <h1>{props.thread.title}</h1>
        <p>
          {isProjectBacked ? `Attached to ${boundName ?? "a Project"}` : "Unfiled · No folder"}
          {` · ${props.thread.modelId}`}
        </p>
      </header>
      <div className="rootless-thread-workspace__scroll">
        <div aria-label="Conversation" className="rootless-thread-workspace__conversation">
          {turn === undefined ? (
            <div className="rootless-thread-workspace__empty" role="status">
              <strong>No first turn was recorded</strong>
              <p>
                Start without a folder from the {modeLabel} composer, or attach a saved Project.
              </p>
            </div>
          ) : (
            <>
              <article
                aria-label="You"
                className="rootless-thread-workspace__message rootless-thread-workspace__message--user"
              >
                <p>{turn.prompt}</p>
              </article>
              <article
                aria-label="Octant"
                className="rootless-thread-workspace__message rootless-thread-workspace__message--assistant"
              >
                <div className="rootless-thread-workspace__message-label">
                  <span>Octant</span>
                  <span
                    className="rootless-thread-workspace__turn-status"
                    data-status={turn.status}
                  >
                    {turnPending ? (
                      <LoaderCircle aria-hidden="true" className="is-spinning" size={12} />
                    ) : turn.status === "completed" ? (
                      <CheckCircle aria-hidden="true" size={12} />
                    ) : (
                      <AlertCircle aria-hidden="true" size={12} />
                    )}
                    {turnStatusLabel(turn)}
                  </span>
                </div>
                <p>{turnReply(turn)}</p>
                {turn.status === "failed" ? (
                  <div aria-label="Support correlation">
                    <p>
                      Support correlation ID: <code>{turn.requestId}</code>
                    </p>
                    <OctantButton
                      onClick={() => {
                        void navigator.clipboard?.writeText(String(turn.requestId));
                      }}
                      type="button"
                      variant="secondary"
                    >
                      Copy support ID
                    </OctantButton>
                  </div>
                ) : null}
              </article>
            </>
          )}
          {isProjectBacked ? (
            <div
              aria-label="Folder attached"
              className="rootless-thread-workspace__capability"
              role="status"
              data-capability="enabled"
            >
              <CheckCircle aria-hidden="true" size={16} strokeWidth={1.7} />
              <div>
                <strong>Folder attached</strong>
                <p>
                  This imported thread preserves its first turn and Project context. Start a new
                  Project thread to continue with {props.thread.mode === "work" ? "Work" : "Code"}{" "}
                  tools.
                </p>
              </div>
            </div>
          ) : (
            <div
              aria-label="Root-backed tools are unavailable"
              className="rootless-thread-workspace__capability"
              role="status"
              data-capability="disabled"
            >
              <LockKeyhole aria-hidden="true" size={16} strokeWidth={1.7} />
              <div>
                <strong>Root-backed tools are unavailable</strong>
                <p>
                  Attach a folder to continue with files, shell, Git, tests, previews, and delivery.
                </p>
              </div>
              {props.onAttachFolder === undefined ? null : (
                <OctantButton
                  onClick={() => props.onAttachFolder!(props.thread)}
                  type="button"
                  variant="secondary"
                >
                  <FolderPlus aria-hidden="true" size={14} strokeWidth={1.7} />
                  Attach folder
                </OctantButton>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

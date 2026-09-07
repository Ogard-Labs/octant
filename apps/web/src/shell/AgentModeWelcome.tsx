import type { OctantMode } from "@octant/contracts/modes";
import { Aperture, FolderPlus, Sparkles } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export interface AgentModeWelcomeProps {
  readonly mode: Extract<OctantMode, "work" | "code">;
  /** Whether a Project is already bound; the page then leads with a new task. */
  readonly hasProjects?: boolean;
  readonly onAddFolder: () => void;
  readonly onOpenDraft?: () => void;
  readonly providerReady: boolean;
  readonly providerMessage?: string;
}

const copy: Record<
  AgentModeWelcomeProps["mode"],
  { readonly eyebrow: string; readonly heading: string; readonly description: string }
> = {
  work: {
    eyebrow: "Work",
    heading: "Add a folder to start",
    description:
      "Bind a confined folder for documents, decks, spreadsheets, and artifacts. Then open a work thread from the harness composer.",
  },
  code: {
    eyebrow: "Code",
    heading: "Add a folder to start",
    description:
      "Bind a confined folder for approval-gated coding work. Then start a Code thread with provider, branch, and delivery context.",
  },
};

/* Once a folder is bound the page is a starting point, not setup: it leads
   with the task and keeps adding a folder as the second thing to do. */
const withProjects: Record<
  AgentModeWelcomeProps["mode"],
  { readonly heading: string; readonly description: string }
> = {
  work: {
    heading: "Start a task",
    description: "Pick a Project in the sidebar, or start here and choose one in the composer.",
  },
  code: {
    heading: "Start a Code thread",
    description: "Pick a Project in the sidebar, or start here and choose one in the composer.",
  },
};

export function AgentModeWelcome(props: AgentModeWelcomeProps) {
  const base = copy[props.mode];
  const presentation = props.hasProjects === true ? { ...base, ...withProjects[props.mode] } : base;
  const newTask =
    props.onOpenDraft === undefined ? null : (
      <OctantButton
        className="draft-thread__intent-card"
        disabled={!props.providerReady}
        onClick={props.onOpenDraft}
        role="listitem"
        type="button"
        variant="ghost"
      >
        <span className="draft-thread__intent-label">
          <Sparkles aria-hidden="true" size={14} strokeWidth={1.8} />
          New task
        </span>
        <span className="draft-thread__intent-description">
          {props.hasProjects === true
            ? "Start a new thread in a Project."
            : "Start a draft thread before a folder is bound."}
        </span>
      </OctantButton>
    );
  return (
    <section
      aria-label={`${presentation.eyebrow} welcome`}
      className="draft-thread agent-mode-welcome"
    >
      <div className="draft-thread__canvas">
        <div className="draft-thread__welcome">
          <Aperture
            aria-hidden="true"
            className="new-thread-welcome__mark"
            size={24}
            strokeWidth={1.4}
          />
          <p className="draft-thread__eyebrow">Octant {presentation.eyebrow}</p>
          <h1 className="oct-title oct-title--hero">{presentation.heading}</h1>
          <p className="draft-thread__description">{presentation.description}</p>
        </div>

        <div className="draft-thread__intent-cards" role="list" aria-label="Get started">
          {props.hasProjects === true ? newTask : null}
          <OctantButton
            className="draft-thread__intent-card"
            onClick={props.onAddFolder}
            role="listitem"
            type="button"
            variant="ghost"
          >
            <span className="draft-thread__intent-label">
              <FolderPlus aria-hidden="true" size={14} strokeWidth={1.8} />
              Add folder
            </span>
            <span className="draft-thread__intent-description">
              Select a confined folder on this Mac.
            </span>
          </OctantButton>
          {props.hasProjects === true ? null : newTask}
        </div>

        {props.providerMessage === undefined ? null : (
          <p className="draft-thread__error" role="status">
            {props.providerMessage}
          </p>
        )}
        {!props.providerReady ? (
          <p className="draft-thread__hint" role="status">
            Detecting local providers… connect Ollama or a CLI runtime in Settings if this takes
            longer than a few seconds.
          </p>
        ) : props.hasProjects === true ? null : (
          <p className="draft-thread__hint">
            Tip: use the sidebar <strong>Add folder</strong> action any time.
          </p>
        )}
      </div>
    </section>
  );
}
